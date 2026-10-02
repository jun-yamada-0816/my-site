const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/bulletin.js');

const id = '30000000-0000-4000-8000-000000000001';
const admin = '20000000-0000-4000-8000-000000000001';
const body = { author_name: '夜ふかしさん', content: '眠れない夜ですが、ここに来られてよかったです。' };
const approved = { id, ...body, parent_id: null, edited_at: null };
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-jwt', OPENAI_API_KEY: 'test-key', BBS_ADMIN_USER_ID: admin };
function model(decision) {
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision }) }] }] };
}
async function invoke(options = {}) {
  const originalFetch = global.fetch;
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env, options.env);
  const calls = [];
  global.fetch = async (url, init) => {
    const call = { url, ...init, payload: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (options.networkError) throw new Error('PRIVATE raw body must never escape');
    let data;
    if (url.includes('/auth/v1/')) data = { id: options.userId ?? admin };
    else if (url.includes('/rpc/')) data = options.slot ?? true;
    else if (url.includes('api.openai.com')) {
      if (options.modelStatus) return Response.json({ private: 'PRIVATE provider details' }, { status: options.modelStatus });
      data = options.model ?? model('allow');
    } else if (init.method === 'POST' || init.method === 'PATCH') data = [approved];
    else data = options.rows ?? [approved];
    return Response.json(data);
  };
  const res = {
    headers: {}, setHeader(name, value) { this.headers[name] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await handler({ method: options.method ?? 'POST', body: options.body ?? body,
      headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.7', ...options.headers } }, res);
    return { ...res, calls };
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(oldEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}
function writes(result) { return result.calls.filter(c => /\/bulletin_messages/.test(c.url) && ['POST', 'PATCH'].includes(c.method)); }

test('only a completed allow decision saves a post; ignores forged approval/ID', async () => {
  const r = await invoke({ body: { ...body, approved: true, id, created_at: 'forged', action: 'create' } });
  assert.equal(r.statusCode, 201);
  assert.equal(writes(r).length, 1);
  assert.deepEqual(writes(r)[0].payload, { ...body, parent_id: null });
  const ai = r.calls.find(c => c.url.includes('api.openai.com'));
  assert.equal(ai.payload.store, false);
  assert.equal(ai.payload.text.format.strict, true);
  assert.deepEqual(JSON.parse(ai.payload.input[0].content), { ...body, reply_to: null });
  assert.match(r.calls[0].payload.p_key, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(r.calls[0].payload).includes('203.0.113.7'));
  assert.equal(r.headers['Cache-Control'], 'no-store');
});
for (const decision of ['block', 'uncertain']) test(`${decision} never saves or exposes rejected text`, async () => {
  const r = await invoke({ model: model(decision) });
  assert.equal(r.statusCode, 422);
  assert.deepEqual(r.body, { error: 'not_allowed' });
  assert.equal(writes(r).length, 0);
});
for (const output of [
  { status: 'incomplete', output: model('allow').output },
  { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'PRIVATE' }] }] },
  { status: 'completed', output: [] },
  model('ALLOW'),
  { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] },
  { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"decision":"allow","other":true}' }] }] },
]) test('malformed, refused or incomplete model response fails closed', async () => {
  const r = await invoke({ model: output });
  assert.equal(r.statusCode, 503);
  assert.equal(writes(r).length, 0);
  assert.deepEqual(r.body, { error: 'unavailable' });
});
test('unavailable model/network/config never falls back to a direct write', async () => {
  for (const options of [{ modelStatus: 429 }, { networkError: true }, { env: { OPENAI_API_KEY: '' } }]) {
    const r = await invoke(options);
    assert.equal(r.statusCode, 503);
    assert.equal(writes(r).length, 0);
    assert(!JSON.stringify(r.body).includes('PRIVATE'));
  }
});
test('rate limit stops requests before model spending; invalid RPC responses fail closed', async () => {
  for (const [slot, status] of [[false, 429], ['true', 503]]) {
    const r = await invoke({ slot });
    assert.equal(r.statusCode, status);
    assert.equal(r.calls.length, 1);
    assert.equal(writes(r).length, 0);
  }
});
test('rejects invalid fields and content type before external calls', async () => {
  for (const input of [{ ...body, content: ' ' }, { ...body, content: 'あ'.repeat(501) }, { ...body, author_name: 'a'.repeat(31) },
    { ...body, parent_id: 'id&select=secrets' }, { ...body, action: 'delete' }, [], '{broken']) {
    const r = await invoke({ body: input });
    assert.equal(r.statusCode, 400);
    assert.equal(r.calls.length, 0);
  }
  assert.equal((await invoke({ headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await invoke({ method: 'GET' })).statusCode, 405);
});
test('requires a trusted Vercel client IP', async () => {
  const r = await invoke({ headers: { 'x-vercel-forwarded-for': '', 'x-forwarded-for': 'spoofed' } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.calls.length, 0);
});
test('a reply includes server-fetched parent context and is saved only after approval', async () => {
  const r = await invoke({ body: { ...body, parent_id: id } });
  assert.equal(r.statusCode, 201);
  const ai = r.calls.find(c => c.url.includes('api.openai.com'));
  assert.deepEqual(JSON.parse(ai.payload.input[0].content).reply_to, body);
  assert.equal(writes(r)[0].payload.parent_id, id);
  const missing = await invoke({ body: { ...body, parent_id: id }, rows: [] });
  assert.equal(missing.statusCode, 400);
  assert.equal(writes(missing).length, 0);
});
test('edits verify real admin identity, ignore forged name, and pass moderation', async () => {
  const input = { action: 'edit', id, content: '修正した本文', author_name: 'forged' };
  assert.equal((await invoke({ body: input })).statusCode, 403);
  const stranger = await invoke({ body: input, headers: { authorization: 'Bearer test' }, userId: 'stranger' });
  assert.equal(stranger.statusCode, 403);
  assert.equal(writes(stranger).length, 0);
  const r = await invoke({ body: input, headers: { authorization: 'Bearer test' } });
  assert.equal(r.statusCode, 200);
  assert.equal(writes(r)[0].method, 'PATCH');
  assert.equal(writes(r)[0].payload.content, input.content);
  const ai = r.calls.find(c => c.url.includes('api.openai.com'));
  assert.equal(JSON.parse(ai.payload.input[0].content).author_name, body.author_name);
  const rejected = await invoke({ body: input, headers: { authorization: 'Bearer test' }, model: model('block') });
  assert.equal(writes(rejected).length, 0);
});
test('new Supabase secret key uses apikey without an invalid JWT Authorization', async () => {
  const r = await invoke({ env: { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.calls[0].headers.apikey, 'sb_secret_test');
  assert.equal(r.calls[0].headers.Authorization, undefined);
});
