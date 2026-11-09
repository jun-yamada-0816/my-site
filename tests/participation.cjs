// Small participation on the main page: 星の灯り, 「私も」, 今週の問いかけ, 「知らせる», BBS counts.
// Every Supabase and /api/bulletin request is intercepted: nothing reaches production.
// Run: PLAYWRIGHT_PATH=... CHROMIUM_PATH=... node --test tests/participation.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// BROWSER=webkit runs the same checks in the engine behind Safari on iPhone.
const engine = require(process.env.PLAYWRIGHT_PATH || 'playwright')[process.env.BROWSER || 'chromium'];
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const PROFILE_ID = '00000000-0000-4000-8000-000000000095';
const DIARY_ID = '10000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '30000000-0000-4000-8000-000000000001';
const user = { id:'20000000-0000-4000-8000-000000000001', aud:'authenticated', role:'authenticated', email:'admin@example.test' };
const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub:user.id, role:'authenticated', exp:Math.floor(Date.now()/1000)+3600 })).toString('base64url'), 'test'].join('.');
let browser, server, base, supabaseJs;

before(async () => {
  const cache = path.join(os.tmpdir(), 'my-site-check', 'supabase-2.49.10.js');
  try { supabaseJs = await fs.readFile(cache); } catch {
    const response = await fetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/dist/umd/supabase.min.js');
    assert(response.ok); supabaseJs = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(cache), { recursive:true }); await fs.writeFile(cache, supabaseJs);
  }
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      res.setHeader('Content-Type', { '.html':'text/html; charset=utf-8', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png' }[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await engine.launch({ headless:true, ...(process.env.CHROMIUM_PATH && engine.name() === 'chromium' ? { executablePath:process.env.CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

const summary = (byMood, ok = true) => ({ total:Object.values(byMood).reduce((a, b) => a + b, 0), by_mood:byMood, ok });
const missing = { status:404, body:{ code:'PGRST202', message:'Could not find the function' } };

// rpc: { name: (body) => ({ status, body }) | value }. Calls are recorded in order.
async function open({ rpc = {}, admin = false, width = 390, storage = {}, time = null } = {}) {
  const context = await browser.newContext({ viewport:{ width, height:844 }, reducedMotion:'reduce' });
  if (time) await context.clock.setFixedTime(new Date(time));   // Date だけを固定。タイマーはふつうに進む
  const calls = [], posts = [], errors = [];
  await context.addInitScript(({ token, user, admin, storage }) => {
    if (sessionStorage.getItem('test-seeded')) return;
    sessionStorage.setItem('test-seeded', '1');
    if (admin) localStorage.setItem('sb-qnmzjwgacnfxwlbgwxcr-auth-token', JSON.stringify({ access_token:token, refresh_token:'test',
      token_type:'bearer', expires_at:Math.floor(Date.now()/1000)+3600, expires_in:3600, user }));
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, { token, user, admin, storage });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1' && url.pathname === '/api/bulletin') {
      const body = request.postDataJSON(); posts.push(body);
      return route.fulfill({ status:201, contentType:'application/json', body:JSON.stringify({ message:{ id:'30000000-0000-4000-8000-000000000077',
        author_name:body.author_name, content:body.content, parent_id:body.parent_id ?? null, edited_at:null, created_at:new Date().toISOString() } }) });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ body:supabaseJs, contentType:'text/javascript', headers:{ 'access-control-allow-origin':'*' } });
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const send = (body, status = 200, headers = {}) => route.fulfill({ status, contentType:'application/json',
      headers:{ 'access-control-allow-origin':'*', ...headers }, body:JSON.stringify(body) });
    if (url.pathname.endsWith('/auth/v1/user')) return send(user);
    const name = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/rpc/')) {
      const body = request.postDataJSON() ?? {};
      calls.push({ name, body });
      if (name === 'increment_visit_count') return send(100);
      const handler = rpc[name];
      if (handler === undefined) return send(missing.body, missing.status);
      const answer = typeof handler === 'function' ? handler(body) : handler;
      return answer && answer.status ? send(answer.body, answer.status) : send(answer);
    }
    if (name === 'site_visits') return send({ count:100 });
    if (name === 'blog_posts') {
      const id = url.searchParams.get('id');
      if (id === 'eq.' + PROFILE_ID) return send([]);
      const diary = { id:DIARY_ID, title:'夜のひとりごと', content:'今日も、ゆっくり。', created_at:'2026-11-08T12:00:00Z' };
      if (url.searchParams.get('select') === 'created_at') return send([{ created_at:diary.created_at }]);
      if (id === 'eq.' + DIARY_ID) return send([diary]);
      return send([diary], 200, { 'access-control-expose-headers':'content-range', 'content-range':'0-0/1' });
    }
    if (name === 'bulletin_messages') return send([
      { id:MESSAGE_ID, author_name:'夜ふかしさん', content:'こんばんは。', created_at:'2026-11-08T14:00:00Z', parent_id:null, edited_at:null },
      { id:'legacy-1', author_name:'古い行', content:'id がUUIDでない行', created_at:'2026-11-07T14:00:00Z', parent_id:null, edited_at:null },
    ]);
    return send([]);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/');
  await page.waitForFunction(() => document.querySelector('#posts-container article') && document.querySelector('#messages-container [data-report-open], #messages-container .report-done, #messages-container p'));
  return { context, page, calls, posts, errors };
}
const rpcCalls = (calls, name) => calls.filter(call => call.name === name);

test('lights: the shared count shows, one choice a day sends only the mood, and the answer counts the others', async () => {
  let after = summary({ lonely:2, calm:1 });
  const a = await open({ rpc:{
    star_lights_summary: summary({ lonely:2, calm:1 }),
    light_star: body => { after = summary({ lonely:3, calm:1 }); return after; },
  } });
  try {
    await a.page.waitForFunction(() => document.querySelector('#lights-count').textContent.includes('3こ'));
    assert.equal(await a.page.locator('#lights-sky .light-star').count(), 3);
    await a.page.getByRole('button', { name:'さみしい' }).click();
    await a.page.waitForFunction(() => !document.querySelector('#lights-response').hidden);
    assert.deepEqual(rpcCalls(a.calls, 'light_star').map(call => call.body), [{ p_mood:'lonely' }], 'only the mood is sent');
    assert.match(await a.page.locator('#lights-response-text').textContent(), /同じ「さみしい」の灯りは、あなたのほかに2こ。/);
    assert.match(await a.page.locator('#lights-count').textContent(), /4こ/);
    assert.equal(await a.page.locator('.light-btn[data-light="lonely"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await a.page.locator('.light-btn:not([disabled])').count(), 0, 'one light a day');
    assert.equal(await a.page.locator('#lights-sky .light-mine').count(), 1);
    assert.equal(await a.page.locator('#lights-sky .light-star').count(), 3, 'my own light is drawn once, as the large star');
    assert.equal(await a.page.locator('#lights-response-links a[href="#bulletin"]').count(), 1);
    const saved = JSON.parse(await a.page.evaluate(() => localStorage.getItem('hoshiumi_light')));
    assert.equal(saved.mood, 'lonely');
    assert.equal(saved.day, new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Tokyo' }).format(new Date()));
    await a.page.reload();
    await a.page.waitForFunction(() => !document.querySelector('#lights-response').hidden);
    assert.match(await a.page.locator('#lights-response-text').textContent(), /きょうは「さみしい」の灯りをともしています/);
    assert.equal(rpcCalls(a.calls, 'light_star').length, 1, 'reload does not light again');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});

test('lights before participation.sql (or offline) stay on this device, and a bad summary is never drawn', async () => {
  const a = await open();
  try {
    await a.page.waitForTimeout(300);
    assert.equal(await a.page.locator('#lights-count').isVisible(), false, 'no count without the server');
    await a.page.getByRole('button', { name:'言葉にならない' }).click();
    await a.page.waitForFunction(() => !document.querySelector('#lights-response').hidden);
    assert.match(await a.page.locator('#lights-response-text').textContent(), /いまはこの端末の夜空にだけ/);
    assert.equal(await a.page.locator('#lights-response-links a[href="#support"]').count(), 1);
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  for (const bad of [{ total:-1, by_mood:{} }, { total:'5', by_mood:{} }, { total:2, by_mood:{ lonely:'2' } }, [], null]) {
    const b = await open({ rpc:{ star_lights_summary:bad } });
    try {
      await b.page.waitForTimeout(300);
      assert.equal(await b.page.locator('#lights-count').isVisible(), false, JSON.stringify(bad));
      assert.equal(await b.page.locator('#lights-sky .light-star').count(), 0);
    } finally { await b.context.close(); }
  }
  const c = await open({ rpc:{ star_lights_summary:summary({ calm:1 }), light_star:summary({ calm:1 }, false) } });
  try {
    await c.page.getByRole('button', { name:'少しおだやか' }).click();
    await c.page.waitForFunction(() => !document.querySelector('#lights-response').hidden);
    assert.match(await c.page.locator('#lights-response-text').textContent(), /混み合っていて/);
  } finally { await c.context.close(); }
});

test('me too reaches the admin once per diary, shows no public count, and the admin sees the count instead', async () => {
  let accept = false;
  const a = await open({ rpc:{ send_metoo: () => accept ? true : { status:503, body:{ message:'down' } } } });
  try {
    await a.page.evaluate(id => openPost(id), DIARY_ID);
    await a.page.locator('#detail-metoo').waitFor();
    assert.match(await a.page.locator('#detail-metoo-note').textContent(), /数は公開しません/);
    await a.page.locator('#detail-metoo').click();
    await a.page.waitForFunction(() => document.querySelector('#detail-metoo-note').textContent.includes('届けられませんでした'));
    assert.equal(await a.page.locator('#detail-metoo').isEnabled(), true, 'a failure can be retried');
    accept = true;
    await a.page.locator('#detail-metoo').click();
    await a.page.waitForFunction(() => document.querySelector('#detail-metoo').textContent.includes('届けました'));
    assert.deepEqual(rpcCalls(a.calls, 'send_metoo').map(call => call.body), [{ p_post_id:DIARY_ID }, { p_post_id:DIARY_ID }]);
    assert.equal(await a.page.locator('#detail-metoo').isDisabled(), true);
    assert.doesNotMatch(await a.page.locator('#detail-modal').textContent(), /私も」：/, 'visitors never see a count');
    await a.page.keyboard.press('Escape');
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    await a.page.evaluate(id => openPost(id), DIARY_ID);
    await a.page.locator('#detail-metoo').waitFor();
    assert.equal(await a.page.locator('#detail-metoo').isDisabled(), true, 'remembered on this device');
    assert.equal(rpcCalls(a.calls, 'send_metoo').length, 2);
    assert.equal(await a.page.evaluate(() => sendMetoo().then(() => 'done')), 'done');
    assert.equal(rpcCalls(a.calls, 'send_metoo').length, 2, 'cannot be sent twice from code either');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  const admin = await open({ admin:true, rpc:{ diary_metoo_count:3 } });
  try {
    await admin.page.evaluate(id => openPost(id), DIARY_ID);
    await admin.page.waitForFunction(() => document.querySelector('#detail-metoo-count').textContent.includes('3'));
    assert.equal(await admin.page.locator('#detail-metoo').isVisible(), false, 'no me-too button for the admin');
    assert.match(await admin.page.locator('#detail-metoo-count').textContent(), /この日記に届いた「私も」：3/);
    assert.equal(await admin.page.locator('#messages-container .report-open').count(), 0, 'no report links for the admin');
  } finally { await admin.context.close(); }
});

test('report sends one of four fixed reasons, is remembered, and malformed ids get no button', async () => {
  let answer = false;
  const a = await open({ rpc:{ report_bulletin: () => answer } });
  try {
    assert.equal(await a.page.locator('#messages-container .report-open').count(), 1, 'only the message with a valid id');
    await a.page.locator(`[data-report-open="${MESSAGE_ID}"]`).click();
    const reasons = await a.page.locator(`[data-report-for="${MESSAGE_ID}"] .report-reason`).allTextContents();
    assert.deepEqual(reasons, ['傷つける言葉がある', '個人が分かる情報がある', '宣伝・関係のない内容', '書いた人のことが心配']);
    await a.page.getByRole('button', { name:'書いた人のことが心配' }).click();
    await a.page.waitForFunction(id => document.getElementById('report-error-' + id)?.textContent.includes('混み合って'), MESSAGE_ID);
    answer = true;
    await a.page.getByRole('button', { name:'書いた人のことが心配' }).click();
    await a.page.locator('#messages-container .report-done').waitFor();
    assert.deepEqual(rpcCalls(a.calls, 'report_bulletin').at(-1).body, { p_message_id:MESSAGE_ID, p_reason:'worry' });
    await a.page.reload();
    await a.page.locator('#messages-container .report-done').waitFor();
    assert.equal(await a.page.evaluate(id => sendReport(id, 'evil').then(() => 'ignored'), MESSAGE_ID), 'ignored');
    assert.equal(rpcCalls(a.calls, 'report_bulletin').length, 2, 'unknown reasons are never sent');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});

test('the weekly question turns over on Monday 0:00 in Japan and only fills an empty form; an empty name posts as ななしさん', async () => {
  const shown = async time => {
    const b = await open({ time });
    try { return [await b.page.locator('#wq-text').textContent(), await b.page.locator('#wq-range').textContent()]; }
    finally { await b.context.close(); }
  };
  const first = await shown('2026-11-09T00:00:00+09:00');
  assert.deepEqual(first, ['最近、少しだけほっとしたことはありますか。', '11/9〜11/15']);
  assert.deepEqual(await shown('2026-11-15T23:59:00+09:00'), first, 'same question until Sunday 23:59 in Japan');
  const next = await shown('2026-11-16T00:00:00+09:00');
  assert.notEqual(next[0], first[0], 'next question on Monday 0:00 in Japan');
  assert.equal(next[1], '11/16〜11/22');
  assert.equal((await shown('2027-02-01T00:00:00+09:00'))[0], first[0], 'twelve questions, then round again');
  const a = await open();
  try {
    await a.page.getByRole('button', { name:'この問いかけに答える' }).click();
    const filled = await a.page.locator('#msg-content').inputValue();
    assert.match(filled, /^【今週の問いかけ】.+\n$/);
    await a.page.locator('#msg-content').fill('書きかけの言葉');
    await a.page.getByRole('button', { name:'この問いかけに答える' }).click();
    assert.equal(await a.page.locator('#msg-content').inputValue(), '書きかけの言葉', 'a draft is never replaced');
    await a.page.locator('#msg-submit').click();
    await a.page.waitForFunction(() => document.querySelector('#messages-container').textContent.includes('書きかけの言葉'));
    assert.deepEqual(a.posts.at(-1), { author_name:'ななしさん', content:'書きかけの言葉', parent_id:null });
    await a.page.locator('#msg-content').fill('   ');
    await a.page.locator('#msg-submit').click();
    assert.match(await a.page.locator('#msg-error').textContent(), /本文を入れてください/);
    assert.equal(a.posts.length, 1, 'an empty body is not sent');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});

test('BBS counts: seen and typing once per day in Japan time, never for the admin, never without device storage', async () => {
  const a = await open({ rpc:{ note_site_signal:true } });
  try {
    await a.page.locator('#bulletin').scrollIntoViewIfNeeded();
    await a.page.evaluate(() => document.getElementById('bulletin').scrollIntoView());
    await a.page.waitForFunction(() => true, null, { timeout:100 });
    for (let i = 0; i < 40 && !rpcCalls(a.calls, 'note_site_signal').length; i++) await a.page.waitForTimeout(100);
    await a.page.locator('#msg-content').pressSequentially('こん');
    await a.page.locator('#msg-content').pressSequentially('ばんは');
    await a.page.waitForTimeout(200);
    assert.deepEqual(rpcCalls(a.calls, 'note_site_signal').map(call => call.body.p_kind).sort(), ['bbs_seen', 'bbs_typing']);
    await a.page.reload();
    await a.page.evaluate(() => document.getElementById('bulletin').scrollIntoView());
    await a.page.locator('#msg-content').pressSequentially('また');
    await a.page.waitForTimeout(2000);
    assert.equal(rpcCalls(a.calls, 'note_site_signal').length, 2, 'once per kind per day');
  } finally { await a.context.close(); }
  const admin = await open({ admin:true, rpc:{ note_site_signal:true } });
  try {
    await admin.page.evaluate(() => document.getElementById('bulletin').scrollIntoView());
    await admin.page.locator('#msg-content').pressSequentially('管理人');
    await admin.page.waitForTimeout(2000);
    assert.equal(rpcCalls(admin.calls, 'note_site_signal').length, 0, 'the admin is never counted');
  } finally { await admin.context.close(); }
  const noStorage = await browser.newContext({ viewport:{ width:390, height:844 } });
  try {
    // Safari's private mode and blocked storage throw on write; then nothing is counted.
    await noStorage.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; });
    const page = await noStorage.newPage();
    const calls = [];
    await noStorage.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1') return route.continue();
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ body:supabaseJs, contentType:'text/javascript', headers:{ 'access-control-allow-origin':'*' } });
      if (url.pathname.includes('/rpc/')) calls.push(url.pathname.split('/').at(-1));
      return route.fulfill({ status:200, contentType:'application/json', headers:{ 'access-control-allow-origin':'*' }, body:'[]' });
    });
    await page.goto(base + '/');
    await page.evaluate(() => document.getElementById('bulletin').scrollIntoView());
    await page.locator('#msg-content').pressSequentially('ひみつ');
    await page.waitForTimeout(2000);
    assert.equal(calls.filter(name => name === 'note_site_signal').length, 0);
  } finally { await noStorage.close(); }
});

test('the new parts fit phones: no sideways scroll, every button is at least 44px, and nothing overlaps', async () => {
  for (const width of [320, 375, 414, 768, 1280]) {
    const a = await open({ width, rpc:{ star_lights_summary:summary({ tired:4, lonely:2, sleepless:5, wordless:1, calm:3 }) } });
    try {
      await a.page.locator(`[data-report-open="${MESSAGE_ID}"]`).click();
      await a.page.evaluate(id => openPost(id), DIARY_ID);
      await a.page.locator('#detail-metoo').waitFor();
      const r = await a.page.evaluate(() => {
        const small = [...document.querySelectorAll('#lights button, #weekly-question button, .report-box button, #detail-metoo, #lights-response a')]
          .filter(e => e.getClientRects().length)
          .map(e => [e.textContent.trim().slice(0, 12), Math.round(e.getBoundingClientRect().height)])
          .filter(([, h]) => h < 44);
        const buttons = [...document.querySelectorAll('.light-btn')].map(e => e.getBoundingClientRect());
        let overlap = 0;
        for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i], b = buttons[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlap++;
        }
        return { scroll:document.documentElement.scrollWidth - document.documentElement.clientWidth, small, overlap };
      });
      assert.equal(r.scroll, 0, `no sideways scroll at ${width}px`);
      assert.deepEqual(r.small, [], `44px targets at ${width}px`);
      assert.equal(r.overlap, 0, `light buttons do not overlap at ${width}px`);
      if (width === 375) {
        await a.page.keyboard.press('Escape');
        await a.page.locator('#lights').screenshot({ path:path.join(os.tmpdir(), 'my-site-check', 'lights-375.png') });
        await a.page.locator('#weekly-question').screenshot({ path:path.join(os.tmpdir(), 'my-site-check', 'weekly-375.png') });
      }
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
  }
});
