// 星の小瓶, 星みくじ, usage counts for every part of the page, admin-only diary view counts, and usage.html.
// Every Supabase and /api/bulletin request is intercepted: nothing reaches production.
// Run: PLAYWRIGHT_PATH=... CHROMIUM_PATH=... node --test tests/bottle-usage.cjs
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
async function open({ rpc = {}, admin = false, width = 390, storage = {}, time = null, page: pagePath = '/', query = '' } = {}) {
  const context = await browser.newContext({ viewport:{ width, height:844 }, reducedMotion:'reduce' });
  if (time) await context.clock.setFixedTime(new Date(time));   // Date だけを固定。タイマーはふつうに進む
  const calls = [], posts = [], errors = [], tables = [];
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
    tables.push(name);
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
  await page.goto(base + pagePath + query);
  if (pagePath === '/') await page.waitForFunction(() => document.querySelector('#posts-container article') && document.querySelector('#messages-container [data-report-open], #messages-container .report-done, #messages-container p'));
  return { context, page, calls, posts, errors, tables };
}
const rpcCalls = (calls, name) => calls.filter(call => call.name === name);

const BOTTLE = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEY = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jstToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Tokyo' }).format(new Date());
const bodies = (calls, name) => rpcCalls(calls, name).map(call => call.body);
const kinds = calls => bodies(calls, 'note_usage').map(body => body.p_kind);
const waitFor = async (check, what) => {
  for (let i = 0; i < 80; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail('timed out waiting for ' + what);
};

test('the music room is gone: no section, no link, no request for tracks, and nothing left to upload', async () => {
  const a = await open({ admin:true });
  try {
    assert.equal(await a.page.locator('#music, a[href="#music"], #upload-modal, #tracks-container, audio').count(), 0);
    assert.equal(a.tables.includes('music_tracks'), false, 'tracks are never requested');
    // The only mention left is the notice that the room has closed.
    assert.match(await a.page.locator('#news-list').innerText(), /音楽室は、おしまいにしました/);
    assert.doesNotMatch(await a.page.evaluate(() => { const news = document.getElementById('news'); news.hidden = true; const text = document.body.innerText; news.hidden = false; return text; }), /音楽室|音楽を聴く|MUSIC/);
    assert.equal(await a.page.evaluate(() => typeof window.openUploadModal), 'undefined');
    await a.page.locator('#admin-btn').click();
    assert.equal(await a.page.locator('#admin-menu a[href="usage.html"]').count(), 1, 'the admin menu leads to the usage page');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});

test('bottle: picking sends only ids to skip, shows who it is for and roughly when, and stops at three a day', async () => {
  let n = 0;
  const a = await open({ rpc:{
    sea_bottle_count: 14,
    pick_bottle: () => ({ id:BOTTLE(++n), to:'sleepless', word:'same_night', from_admin:n === 2, at:'2026-11-08T18:00:00+00:00', picks:99, owner_key:KEY(9) }),
    note_usage: true,
  } });
  try {
    await a.page.waitForFunction(() => document.querySelector('#bottle-sea').textContent.includes('14本'));
    assert.equal(await a.page.locator('#bottle-letter').isVisible(), false);
    await a.page.locator('#bottle-pick').click();
    await a.page.locator('#bottle-letter').waitFor();
    assert.deepEqual(bodies(a.calls, 'pick_bottle'), [{ p_skip:[] }], 'nothing about the visitor is sent');
    assert.equal(await a.page.locator('#bottle-letter-from').textContent(), '11月9日の夜中3時ごろ、だれかが流した小瓶');
    assert.equal(await a.page.locator('#bottle-letter-to').textContent(), '眠れない夜のだれかへ');
    assert.equal(await a.page.locator('#bottle-letter-word').textContent(), '同じ夜を、過ごしています。');
    assert.doesNotMatch(await a.page.locator('#bottle').innerText(), /99|50000000/, 'counts and keys never reach the picker');
    assert.match(await a.page.locator('#bottle-pick').textContent(), /もうひとつ ひろう（きょうはあと2つ）/);
    await a.page.locator('#bottle-pick').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-letter-from').textContent.includes('管理人が流した小瓶'));
    assert.deepEqual(bodies(a.calls, 'pick_bottle')[1], { p_skip:[BOTTLE(1)] }, 'a bottle already read is not handed over again');
    await a.page.locator('#bottle-pick').focus();
    await a.page.keyboard.press('Enter');
    await a.page.waitForFunction(() => document.querySelector('#bottle-pick').textContent.includes('きょうの小瓶は、ここまで'));
    assert.equal(await a.page.locator('#bottle-pick').isDisabled(), true);
    assert.equal(await a.page.evaluate(() => document.activeElement.id), 'bottle-letter', 'focus moves to the letter when the button goes away');
    await a.page.locator('#bottle-pick').click({ force:true });
    assert.equal(rpcCalls(a.calls, 'pick_bottle').length, 3, 'no fourth bottle today');
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    assert.equal(await a.page.locator('#bottle-pick').isDisabled(), true, 'the limit survives a reload');
    assert.deepEqual(kinds(a.calls).filter(kind => kind === 'bottle_pick'), ['bottle_pick'], 'picking counts as used once a day');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  // Tomorrow the count starts again; tonight's light chooses the recipient asked for first.
  const state = JSON.stringify({ day:'2026-11-10', picked:3, thrown:2, seen:[BOTTLE(1)], thanked:[], starters:[], mine:[] });
  const light = JSON.stringify({ day:jstToday(), mood:'lonely' });
  const b = await open({ storage:{ hoshiumi_bottle:state, hoshiumi_light:light },
    rpc:{ pick_bottle:{ id:BOTTLE(5), to:'lonely', word:'not_alone', from_admin:false, at:'2026-11-10T03:00:00+00:00' } } });
  try {
    assert.equal(await b.page.locator('#bottle-pick').isEnabled(), true);
    await b.page.locator('#bottle-pick').click();
    await b.page.locator('#bottle-letter').waitFor();
    assert.deepEqual(bodies(b.calls, 'pick_bottle'), [{ p_skip:[BOTTLE(1)], p_to:'lonely' }]);
    assert.equal(await b.page.locator('#bottle-letter-from').textContent(), '11月10日の昼12時ごろ、だれかが流した小瓶');
  } finally { await b.context.close(); }
});

test('bottle before bottle-usage.sql, offline, or with a bad answer: only the bottles the admin left, clearly labelled', async () => {
  const bad = [{ id:BOTTLE(1), to:'sleepless', word:'<img src=x onerror=alert(1)>', at:'2026-11-08T18:00:00Z' },
    { id:'not-a-uuid', to:'sleepless', word:'here' }, { id:BOTTLE(1), to:'everyone', word:'here' }, 'text', 7, []];
  for (const answer of [undefined, null, ...bad]) {
    const a = await open({ rpc:answer === undefined ? {} : { pick_bottle:answer } });
    try {
      assert.equal(await a.page.locator('#bottle-sea').isVisible(), false, 'no count without the server');
      await a.page.locator('#bottle-pick').click();
      await a.page.locator('#bottle-letter').waitFor();
      assert.equal(await a.page.locator('#bottle-letter-from').textContent(), '管理人が、はじめに置いておいた小瓶', JSON.stringify(answer));
      assert.equal(await a.page.locator('#bottle-thanks').isVisible(), false, 'nobody to thank for a starter bottle');
      assert.match(await a.page.locator('#bottle-letter-word').textContent(), /。$/);
      assert.equal(await a.page.locator('#bottle-letter img').count(), 0);
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
  }
  // When every starter has been read and the sea has nothing new, it says so instead of repeating.
  const state = JSON.stringify({ day:jstToday(), picked:0, thrown:0, seen:[], thanked:[], starters:[0, 1, 2, 3, 4, 5, 6, 7], mine:[] });
  const c = await open({ storage:{ hoshiumi_bottle:state }, rpc:{ pick_bottle:null } });
  try {
    await c.page.locator('#bottle-pick').click();
    await c.page.waitForFunction(() => document.querySelector('#bottle-status').textContent.includes('流れ着いていません'));
    assert.equal(await c.page.locator('#bottle-letter').isVisible(), false);
    assert.match(await c.page.locator('#bottle-pick').textContent(), /^流れ着いた小瓶をひろう$/, 'an empty sea does not use up the day');
  } finally { await c.context.close(); }
});

test('bottle: throwing sends one fixed recipient and one fixed phrase, two a day, and the count comes back only to this device', async () => {
  let answer = { ok:false }, status = [];
  const a = await open({ rpc:{
    sea_bottle_count: 3,
    throw_bottle: () => answer,
    bottle_status: () => status,
    note_usage: true,
  } });
  try {
    assert.equal(await a.page.locator('#bottle-form').isVisible(), false);
    await a.page.locator('#bottle-open-form').click();
    assert.equal(await a.page.locator('#bottle-open-form').getAttribute('aria-expanded'), 'true');
    assert.equal(await a.page.locator('#bottle-form input[type="text"], #bottle-form textarea').count(), 0, 'there is nowhere to type');
    assert.equal(await a.page.locator('#bottle-form input[name="bottle-to"]').count(), 6);
    assert.equal(await a.page.locator('#bottle-form input[name="bottle-word"]').count(), 10);
    await a.page.locator('#bottle-throw').click();
    assert.match(await a.page.locator('#bottle-form-error').textContent(), /ひとつずつ選んでください/);
    assert.equal(rpcCalls(a.calls, 'throw_bottle').length, 0);
    await a.page.locator('#bottle-form input[value="anxious"]').check();
    await a.page.locator('#bottle-form input[value="slowly"]').check();
    assert.equal(await a.page.locator('#bottle-preview-to').textContent(), '明日がこわいだれかへ');
    assert.equal(await a.page.locator('#bottle-preview-word').textContent(), 'ゆっくりで、大丈夫です。');
    await a.page.locator('#bottle-throw').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-form-error').textContent.includes('混み合って'));
    answer = { status:503, body:{ message:'down' } };
    await a.page.locator('#bottle-throw').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-form-error').textContent.includes('いまは流せませんでした'));
    assert.equal(await a.page.locator('#bottle-mine').isVisible(), false, 'a bottle that was not accepted is not listed');
    answer = { ok:true, id:BOTTLE(21), key:KEY(21) };
    await a.page.locator('#bottle-throw').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-status').textContent.includes('小瓶を流しました'));
    assert.deepEqual(bodies(a.calls, 'throw_bottle').at(-1), { p_to:'anxious', p_word:'slowly' }, 'only the two choices are sent');
    assert.equal(await a.page.locator('#bottle-form').isVisible(), false);
    assert.equal(await a.page.evaluate(() => document.activeElement.id), 'bottle-open-form');
    assert.match(await a.page.locator('#bottle-sea').textContent(), /4本/);
    assert.match(await a.page.locator('#bottle-mine-list').textContent(), /明日がこわいだれかへ.*ゆっくりで、大丈夫です。.*まだ、波の上をただよっています/s);
    assert.equal(await a.page.locator('#bottle-news').isVisible(), false);
    // My own bottle is never handed back to me.
    await a.page.locator('#bottle-pick').click();
    await a.page.locator('#bottle-letter').waitFor();
    assert.deepEqual(bodies(a.calls, 'pick_bottle').at(-1), { p_skip:[BOTTLE(21)] });
    // Second bottle, then the daily limit.
    answer = { ok:true, id:BOTTLE(22), key:KEY(22) };
    await a.page.locator('#bottle-open-form').click();
    await a.page.locator('#bottle-form input[value="anyone"]').check();
    await a.page.locator('#bottle-form input[value="here"]').check();
    await a.page.locator('#bottle-throw').click();
    await a.page.waitForFunction(() => document.querySelectorAll('#bottle-mine-list li').length === 2);
    await a.page.locator('#bottle-open-form').click();
    await a.page.locator('#bottle-form input[value="anyone"]').check();
    await a.page.locator('#bottle-form input[value="here"]').check();
    const thrown = rpcCalls(a.calls, 'throw_bottle').length;
    await a.page.locator('#bottle-throw').click();
    assert.match(await a.page.locator('#bottle-form-error').textContent(), /2本までです/);
    assert.equal(rpcCalls(a.calls, 'throw_bottle').length, thrown, 'the third is not sent');
    assert.deepEqual(kinds(a.calls).filter(kind => kind === 'bottle_throw'), ['bottle_throw']);
    // Coming back: the device asks with its keys, and news shows once it has been seen.
    status = [{ key:KEY(21), picks:2, thanks:1 }, { key:KEY(22), picks:0, thanks:0 }];
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    await a.page.waitForFunction(() => !document.querySelector('#bottle-news').hidden);
    assert.deepEqual(bodies(a.calls, 'bottle_status').at(-1), { p_keys:[KEY(21), KEY(22)] });
    assert.match(await a.page.locator('#bottle-mine-list li').nth(1).textContent(), /2回 拾われました。ありがとうが 1つ 届いています。\s*NEW/);
    assert.doesNotMatch(await a.page.locator('#bottle-mine-list li').nth(0).textContent(), /NEW/);
    await a.page.locator('#bottle-news a').click();
    await a.page.waitForFunction(() => JSON.parse(localStorage.getItem('hoshiumi_bottle')).mine[0].shownPicks === 2);
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    await a.page.waitForFunction(() => document.querySelector('#bottle-mine-list').textContent.includes('2回 拾われました'));
    await a.page.waitForTimeout(300);
    assert.equal(await a.page.locator('#bottle-news').isVisible(), false, 'old news is not announced twice');
    assert.equal(await a.page.locator('#bottle-mine-list .new-badge').count(), 0);
    // A bottle that has drifted away (not in the answer any more) leaves the list.
    status = [{ key:KEY(22), picks:1, thanks:0 }];
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    await a.page.waitForFunction(() => document.querySelectorAll('#bottle-mine-list li').length === 1);
    assert.match(await a.page.locator('#bottle-mine-list').textContent(), /今夜ここに来たあなたへ.*1回 拾われました/s);
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});

test('bottle: thanks goes to the bottle once; tampered device storage is never trusted', async () => {
  let ok = false;
  const a = await open({ rpc:{ pick_bottle:{ id:BOTTLE(1), to:'tired', word:'rest', from_admin:false, at:'2026-11-09T12:00:00Z' }, thank_bottle: () => ok, note_usage:true } });
  try {
    await a.page.locator('#bottle-pick').click();
    await a.page.locator('#bottle-thanks').waitFor();
    await a.page.locator('#bottle-thanks').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-thanks-note').textContent.includes('いまは返せませんでした'));
    assert.equal(await a.page.locator('#bottle-thanks').isEnabled(), true, 'a failure can be retried');
    ok = true;
    await a.page.locator('#bottle-thanks').click();
    await a.page.waitForFunction(() => document.querySelector('#bottle-thanks').textContent === 'ありがとうを返しました');
    assert.deepEqual(bodies(a.calls, 'thank_bottle'), [{ p_id:BOTTLE(1) }, { p_id:BOTTLE(1) }]);
    assert.equal(await a.page.locator('#bottle-thanks').isDisabled(), true);
    await a.page.locator('#bottle-thanks').click({ force:true });
    assert.equal(rpcCalls(a.calls, 'thank_bottle').length, 2, 'one thanks per bottle from this device');
    assert.deepEqual(kinds(a.calls).filter(kind => kind === 'bottle_thanks'), ['bottle_thanks']);
  } finally { await a.context.close(); }
  const tampered = JSON.stringify({ day:jstToday(), picked:-5, thrown:'x', seen:['<script>', 7, BOTTLE(1)], thanked:{}, starters:[99, -1, 'a'],
    mine:[{ id:BOTTLE(3), key:KEY(3), to:'<b>x</b>', word:'here' }, { id:BOTTLE(4), key:KEY(4), to:'tired', word:'rest', day:'<i>', picks:'9', thanks:-1 }, null, 'x'] });
  const b = await open({ storage:{ hoshiumi_bottle:tampered }, rpc:{ bottle_status:[{ key:KEY(4), picks:'many', thanks:null }, { key:'x' }, null] } });
  try {
    await b.page.waitForFunction(() => document.querySelectorAll('#bottle-mine-list li').length === 1);
    assert.deepEqual(bodies(b.calls, 'bottle_status'), [{ p_keys:[KEY(4)] }], 'only well-formed keys are asked about');
    assert.match(await b.page.locator('#bottle-mine-list').textContent(), /疲れているだれかへ.*流した小瓶：まだ、波の上をただよっています/s);
    assert.equal(await b.page.locator('#bottle-mine-list b, #bottle-mine-list i').count(), 0);
    assert.match(await b.page.locator('#bottle-pick').textContent(), /^流れ着いた小瓶をひろう$/);
    assert.deepEqual(b.errors, []);
  } finally { await b.context.close(); }
});

test('mikuji: one draw a day in Japan time, kept on this device, and only "drawn" is counted', async () => {
  const a = await open({ rpc:{ note_usage:true } });
  try {
    assert.equal(await a.page.locator('#mikuji-result').isVisible(), false);
    assert.match(await a.page.locator('#mikuji').innerText(), /大吉も凶もない/);
    await a.page.locator('#mikuji-draw').click();
    await a.page.locator('#mikuji-result').waitFor();
    const first = await a.page.locator('#mikuji-result').innerText();
    assert.match(first, /今夜の星[\s\S]+今夜のちいさなこと[\s\S]+今夜のおまもり[\s\S]+また明日、引けます。/);
    assert.equal(await a.page.locator('#mikuji-draw').isDisabled(), true);
    assert.equal(await a.page.evaluate(() => document.activeElement.id), 'mikuji-result');
    const saved = JSON.parse(await a.page.evaluate(() => localStorage.getItem('hoshiumi_mikuji')));
    assert.deepEqual(Object.keys(saved).sort(), ['charm', 'day', 'small', 'star']);
    assert.equal(saved.day, jstToday());
    await waitFor(() => kinds(a.calls).includes('mikuji_draw'), 'the draw to be counted');
    assert.equal(JSON.stringify(a.calls).includes(await a.page.locator('#mikuji-star').textContent()), false, 'what was drawn is never sent');
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    assert.equal(await a.page.locator('#mikuji-result').innerText(), first, 'the same result for the rest of the day');
    assert.equal(await a.page.locator('#mikuji-draw').isDisabled(), true);
    assert.equal(kinds(a.calls).filter(kind => kind === 'mikuji_draw').length, 1);
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  for (const stored of [{ day:'2026-11-10', star:0, small:0, charm:0 }, { day:jstToday(), star:99, small:0, charm:0 }, { day:jstToday(), star:'<b>', small:0, charm:0 }, 'x']) {
    const b = await open({ storage:{ hoshiumi_mikuji:JSON.stringify(stored) } });
    try {
      assert.equal(await b.page.locator('#mikuji-result').isVisible(), false, JSON.stringify(stored));
      assert.equal(await b.page.locator('#mikuji-draw').isEnabled(), true);
    } finally { await b.context.close(); }
  }
  // Every result is gentle: no fortune ranks, nothing about the future, no orders to try harder.
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const lists = html.slice(html.indexOf('const MIKUJI_STARS'), html.indexOf('const MIKUJI_KEY'));
  assert.doesNotMatch(lists, /大吉|中吉|小吉|末吉|凶|運勢|がんば|頑張|べき|しなさい|明日は|きっと/);
});

test('usage: each part is counted as seen and used once a day by kind only; the admin is never counted', async () => {
  const a = await open({ rpc:{ note_usage:true, note_diary_view:true, increment_visit_count:100 } });
  try {
    await waitFor(() => kinds(a.calls).includes('visit'), 'the visit');
    // The top of the page is on screen: the first parts are seen without scrolling to them.
    for (const id of ['bottle', 'lights', 'news', 'profile', 'blog', 'bulletin', 'mikuji', 'welcome', 'promise', 'mood', 'coping', 'services', 'links', 'support']) {
      await a.page.evaluate(id => document.getElementById(id).scrollIntoView({ behavior:'instant', block:'start' }), id);
      const kind = id === 'bulletin' ? 'bbs_seen' : id + '_seen';
      await waitFor(() => kinds(a.calls).includes(kind), kind);
    }
    await a.page.locator('#mood .mood-btn[data-mood="1"]').click();
    await a.page.getByRole('button', { name:'べつの言葉を見る' }).click();
    await a.page.locator('#news-list a[data-news-post]').first().click();
    await a.page.locator('#detail-modal').waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.evaluate(() => { for (const a of document.querySelectorAll('#services a, #links a, #support a')) a.addEventListener('click', e => e.preventDefault()); });
    await a.page.locator('#services a').first().click();
    await a.page.locator('#links a[href^="https"]').first().click();
    await a.page.locator('#support a[href^="tel:"]').first().click();
    await a.page.locator('#sos-btn').click();
    await a.page.keyboard.press('Escape');
    await a.page.evaluate(() => { for (const a of document.querySelectorAll('#welcome a.visit-path')) a.addEventListener('click', e => e.preventDefault()); });
    await a.page.locator('#welcome a.visit-path').first().click();
    await a.page.locator('#msg-content').pressSequentially('こん');
    const expected = ['visit', 'bottle_seen', 'lights_seen', 'news_seen', 'profile_seen', 'blog_seen', 'bbs_seen', 'mikuji_seen', 'welcome_seen',
      'promise_seen', 'mood_seen', 'coping_seen', 'services_seen', 'links_seen', 'support_seen', 'mood_used', 'affirm_next', 'news_tap',
      'diary_open', 'services_tap', 'links_tap', 'help_tap', 'sos_open', 'welcome_tap', 'bbs_typing'];
    await waitFor(() => expected.every(kind => kinds(a.calls).includes(kind)), 'all kinds: missing ' + expected.filter(kind => !kinds(a.calls).includes(kind)));
    assert.deepEqual(kinds(a.calls).slice().sort(), expected.slice().sort(), 'each kind exactly once, and nothing else');
    assert.deepEqual(bodies(a.calls, 'note_usage').map(body => Object.keys(body).join()), expected.map(() => 'p_kind'), 'only the kind is sent');
    assert.deepEqual(bodies(a.calls, 'note_diary_view'), [{ p_post_id:DIARY_ID }]);
    assert.equal(rpcCalls(a.calls, 'note_site_signal').length, 0, 'the older function is not needed once note_usage exists');
    // Doing it all again the same day adds nothing.
    await a.page.reload();
    await a.page.locator('#posts-container article').waitFor();
    await a.page.locator('#mood .mood-btn[data-mood="3"]').click();
    await a.page.evaluate(id => openPost(id), DIARY_ID);
    await a.page.keyboard.press('Escape');
    await a.page.evaluate(() => document.getElementById('bulletin').scrollIntoView({ behavior:'instant' }));
    await a.page.waitForTimeout(2600);
    assert.equal(rpcCalls(a.calls, 'note_usage').length, expected.length, 'once per kind per day');
    assert.equal(rpcCalls(a.calls, 'note_diary_view').length, 1, 'once per diary per day');
    assert.equal(JSON.stringify(a.calls).includes('しんどい'), false, 'the chosen mood never leaves the device');
    assert.match(await a.page.locator('#mood .lead').textContent(), /この端末の中だけ.*どの気持ちを選んだかは数えません/);
    assert.match(await a.page.locator('#counting').textContent(), /見られた回数.*使われた回数.*数を見るのは管理人だけ/s);
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  const admin = await open({ admin:true, rpc:{ note_usage:true, note_diary_view:true, diary_view_counts:{ [DIARY_ID]:12, 'not-a-uuid':5 } } });
  try {
    await admin.page.evaluate(() => document.getElementById('mikuji').scrollIntoView({ behavior:'instant' }));
    await admin.page.locator('#mikuji-draw').click();
    await admin.page.locator('#mood .mood-btn[data-mood="2"]').click();
    await admin.page.evaluate(id => openPost(id), DIARY_ID);
    await admin.page.waitForFunction(() => document.querySelector('#detail-views').textContent.includes('12'));
    assert.match(await admin.page.locator('#detail-views').textContent(), /これまでに 12 回 開かれました（管理者にだけ表示）/);
    await admin.page.keyboard.press('Escape');
    assert.match(await admin.page.locator('#posts-container .diary-views').textContent(), /12 回/);
    await admin.page.waitForTimeout(2600);
    assert.equal(rpcCalls(admin.calls, 'note_usage').length, 0, 'nothing the admin does is counted');
    assert.equal(rpcCalls(admin.calls, 'note_diary_view').length, 0);
    assert.equal(await admin.page.locator('#bottle-admin-note').count(), 1);
  } finally { await admin.context.close(); }
  // Visitors never see reading counts, even if the function answered them.
  const visitor = await open({ rpc:{ diary_view_counts:{ [DIARY_ID]:12 } } });
  try {
    await visitor.page.evaluate(id => openPost(id), DIARY_ID);
    await visitor.page.locator('#detail-modal').waitFor();
    assert.equal(await visitor.page.locator('#detail-views').textContent(), '');
    assert.equal(await visitor.page.locator('#posts-container .diary-views').count(), 0);
    assert.equal(rpcCalls(visitor.calls, 'diary_view_counts').length, 0, 'visitors do not even ask');
  } finally { await visitor.context.close(); }
});

const w = (today, d7, d30, all) => ({ today, d7, d30, all });
const usageSummary = () => ({
  today:'2026-11-11', since:'2026-11-11', counter_total:975,
  counts:{
    signal:{ visit:w(7, 91, 298, 310), bottle_seen:w(5, 70, 221, 230), bottle_pick:w(3, 38, 120, 124), mikuji_draw:w(1, 12, 37, 38), diary_open:w(1, 11, 35, 36), sos_open:w(0, 1, 4, 4), blog_seen:w(2, 26, 81, 85) },
    light:{ lonely:w(1, 6, 15, 15), sleepless:w(1, 9, 27, 28) }, metoo:{ all:w(0, 3, 8, 8) }, view:{ all:w(1, 14, 44, 46) },
    bbs:{ post:w(0, 1, 2, 7), reply:w(0, 0, 1, 2) }, bottle_to:{ sleepless:w(1, 4, 9, 9) }, bottle_word:{ same_night:w(1, 3, 7, 7) },
  },
  bottles:{ in_sea:22, from_admin:3, picked_once:17, picks:124, thanks:30 },
  top_diaries:{ today:[], d7:[{ post_id:DIARY_ID, title:'<img src=x onerror="document.title=\'hacked\'">の夜', n:6 }, { post_id:'bad id"><b>', title:'通院の日', n:'4' }], d30:[], all:[] },
  daily:Array.from({ length:14 }, (_, i) => ({ day:`2026-${i < 3 ? '10' : '11'}-${String(i < 3 ? 29 + i : i - 2).padStart(2, '0')}`, kinds:{ visit:i === 13 ? 7 : i + 3 } })),
  hours:[9, 14, 18, 16, 8, 3, 2, 4, 6, 7, 9, 10, 12, 11, 9, 8, 10, 12, 15, 18, 22, 27, 24, 17],
});

test('usage page: numbers only for the signed-in admin, switched by period, with every server value treated as text', async () => {
  const out = await open({ page:'/usage.html' });
  try {
    await out.page.waitForFunction(() => document.querySelector('#message').textContent.includes('管理者だけが見られます'));
    assert.equal(await out.page.locator('#report').isVisible(), false);
    assert.equal(rpcCalls(out.calls, 'site_usage_summary').length, 0, 'not signed in: the numbers are not even requested');
    assert.equal(await out.page.locator('#message a[href="./"]').count(), 1);
  } finally { await out.context.close(); }
  for (const [answer, text] of [[undefined, /bottle-usage\.sql を実行/], [{ status:403, body:{ code:'42501', message:'admin only' } }, /管理者のアカウントでログイン/],
    [{ status:500, body:{ code:'XX000', message:'secret detail' } }, /読み込めませんでした/], [['not', 'an', 'object'], /読み込めませんでした/]]) {
    const b = await open({ page:'/usage.html', admin:true, rpc:answer === undefined ? {} : { site_usage_summary:answer } });
    try {
      await b.page.waitForFunction(() => !document.querySelector('#message').textContent.includes('読み込み中'));
      assert.match(await b.page.locator('#message').textContent(), text);
      assert.doesNotMatch(await b.page.locator('body').innerText(), /secret detail/);
      assert.equal(await b.page.locator('#report').isVisible(), false);
    } finally { await b.context.close(); }
  }
  const a = await open({ page:'/usage.html', admin:true, width:1100, rpc:{ site_usage_summary:usageSummary() } });
  try {
    await a.page.locator('#places tr').first().waitFor();
    assert.deepEqual(bodies(a.calls, 'site_usage_summary'), [{}]);
    const row = async name => (await a.page.locator('#places tr', { has:a.page.locator('th', { hasText:name }) }).innerText()).replace(/\s+/g, ' ');
    assert.match(await a.page.locator('#tiles').innerText(), /訪問\s*91[\s\S]*延べ 975[\s\S]*小瓶をひろった\s*38[\s\S]*星の灯りをともした\s*15[\s\S]*日記をひらいた\s*11[\s\S]*14回[\s\S]*掲示板の書き込み\s*1/);
    assert.match(await row('星の小瓶'), /星の小瓶 70 訪問の77% ひろった ?38 流した ?0 ありがとう ?0/);
    assert.match(await row('日記'), /日記 26 訪問の29% ひらいた ?11 「私も」 ?3/);
    assert.match(await row('つらいとき'), /— ひらいた ?1/);
    assert.match(await row('星の海の約束'), /星の海の約束 0 訪問の0% —/, 'a kind with no rows yet reads as zero');
    assert.equal(await a.page.locator('#places tr').count(), 15);
    // Diary titles are shown as text, never as markup; malformed ids get no link.
    assert.equal(await a.page.locator('#top-diaries img, #top-diaries b').count(), 0);
    assert.match(await a.page.locator('#top-diaries').innerText(), /<img src=x onerror=.*の夜\s*6/);
    assert.equal(await a.page.title(), '利用状況 ｜ 星の海');
    assert.equal(await a.page.locator('#top-diaries a').count(), 1);
    assert.equal(await a.page.locator('#top-diaries a').getAttribute('href'), './?diary=' + DIARY_ID);
    assert.match(await a.page.locator('#top-diaries li').nth(1).innerText(), /通院の日\s*0/, 'a count that is not a number reads as zero');
    assert.match(await a.page.locator('#sea').innerText(), /海にある小瓶\s*22\s*本[\s\S]*管理人の小瓶 3本[\s\S]*17[\s\S]*124[\s\S]*30/);
    // Period buttons re-read the same answer; nothing is requested again.
    await a.page.getByRole('button', { name:'きょう', exact:true }).click();
    assert.equal(await a.page.getByRole('button', { name:'きょう', exact:true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await a.page.getByRole('button', { name:'7日', exact:true }).getAttribute('aria-pressed'), 'false');
    assert.match(await row('星の小瓶'), /星の小瓶 5 訪問の71% ひろった ?3/);
    assert.match(await a.page.locator('#top-diaries').innerText(), /まだありません/);
    assert.match(await a.page.locator('#period-note').textContent(), /きょうの数です.*数えはじめた日：2026年11月11日/);
    await a.page.getByRole('button', { name:'これまで', exact:true }).click();
    assert.match(await row('星の小瓶'), /星の小瓶 230 訪問の74% ひろった ?124/);
    assert.match(await a.page.locator('#period-note').textContent(), /最長で400日ぶん/);
    assert.equal(rpcCalls(a.calls, 'site_usage_summary').length, 1);
    // Charts: one bar per day and per hour, a table twin, and the keyboard reads each bar.
    assert.equal(await a.page.locator('#chart-daily .col').count(), 14);
    assert.equal(await a.page.locator('#chart-hours .col').count(), 24);
    assert.deepEqual(await a.page.locator('#chart-daily .val').allTextContents(), ['15', '7'], 'only the peak and today carry a number');
    assert.deepEqual(await a.page.locator('#chart-hours .val').allTextContents(), ['27']);
    assert.equal(await a.page.locator('#chart-daily details tr').count(), 14);
    assert.equal(await a.page.locator('#chart-hours details tr').count(), 24);
    await a.page.locator('#chart-daily .plot').focus();
    await a.page.keyboard.press('ArrowLeft');
    assert.match(await a.page.locator('#chart-daily .tip').textContent(), /^711月11日（水）・訪問$/);
    await a.page.keyboard.press('ArrowLeft');
    assert.match(await a.page.locator('#chart-daily .tip').textContent(), /^1511月10日（火）・訪問$/);
    await a.page.keyboard.press('Home');
    assert.match(await a.page.locator('#chart-daily .tip').textContent(), /^310月29日（木）・訪問$/);
    await a.page.keyboard.press('Escape');
    assert.equal(await a.page.locator('#chart-daily .tip').isVisible(), false);
    await a.page.locator('#chart-hours .col').nth(21).hover();
    assert.match(await a.page.locator('#chart-hours .tip').textContent(), /^2721時台・訪問$/);
    const tip = await a.page.evaluate(() => { const t = document.querySelector('#chart-hours .tip').getBoundingClientRect(), f = document.querySelector('#chart-hours').getBoundingClientRect();
      return t.left >= f.left - 1 && t.right <= f.right + 1; });
    assert.equal(tip, true, 'the readout stays inside its chart');
    await a.page.locator('#reload').click();
    await waitFor(() => rpcCalls(a.calls, 'site_usage_summary').length === 2, 'the reload');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
  // No numbers yet: zeros and plain words, not errors.
  const empty = await open({ page:'/usage.html', admin:true, rpc:{ site_usage_summary:{ today:'2026-11-11', since:null, counter_total:975, counts:{}, bottles:{}, top_diaries:{}, daily:[], hours:[] } } });
  try {
    await empty.page.locator('#places tr').first().waitFor();
    assert.match(await empty.page.locator('#period-note').textContent(), /まだ訪問の記録がありません/);
    assert.equal(await empty.page.locator('#places .meter').count(), 0, 'no share of zero visits');
    assert.match(await empty.page.locator('#chart-daily').innerText(), /まだ記録がありません/);
    assert.deepEqual(empty.errors, []);
  } finally { await empty.context.close(); }
});

test('the new parts fit phones: no sideways scroll, targets of at least 44px, on the top page and on the usage page', async () => {
  const state = JSON.stringify({ day:jstToday(), picked:0, thrown:0, seen:[], thanked:[], starters:[],
    mine:[{ id:BOTTLE(7), key:KEY(7), to:'anyone', word:'thanks', day:jstToday(), picks:0, thanks:0, shownPicks:0, shownThanks:0 }] });
  for (const width of [320, 375, 414, 768, 1280]) {
    const a = await open({ width, storage:{ hoshiumi_bottle:state }, rpc:{ sea_bottle_count:1234,
      pick_bottle:{ id:BOTTLE(1), to:'anyone', word:'thanks', from_admin:true, at:'2026-11-08T18:00:00Z' }, bottle_status:[{ key:KEY(7), picks:1200, thanks:345 }] } });
    try {
      await a.page.waitForFunction(() => !document.querySelector('#bottle-news').hidden);
      await a.page.locator('#bottle-pick').click();
      await a.page.locator('#bottle-letter').waitFor();
      await a.page.locator('#bottle-open-form').click();
      await a.page.locator('#bottle-form input[value="anyone"]').check();
      await a.page.locator('#bottle-form input[value="thanks"]').check();
      await a.page.locator('#mikuji-draw').click();
      const r = await a.page.evaluate(() => {
        const small = [...document.querySelectorAll('#bottle button, #bottle .bottle-option, #mikuji button, .hero-actions a, .hero-guide a, #bottle-news a')]
          .filter(e => e.getClientRects().length)
          .map(e => [e.textContent.trim().slice(0, 14), Math.round(e.getBoundingClientRect().height)])
          .filter(([, h]) => h < 44);
        const boxes = [...document.querySelectorAll('.bottle-option')].map(e => e.getBoundingClientRect());
        let overlap = 0;
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i], q = boxes[j];
          if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1) overlap++;
        }
        const shore = document.querySelector('.bottle-shore').getBoundingClientRect(), float = document.querySelector('.bottle-float').getBoundingClientRect();
        return { scroll:document.documentElement.scrollWidth - document.documentElement.clientWidth, small, overlap,
          bottleInside:float.left >= shore.left && float.right <= shore.right && float.width > 40 && float.width < 90 };
      });
      assert.equal(r.scroll, 0, `no sideways scroll at ${width}px`);
      assert.deepEqual(r.small, [], `44px targets at ${width}px`);
      assert.equal(r.overlap, 0, `choices do not overlap at ${width}px`);
      assert.equal(r.bottleInside, true, `the bottle keeps its size at ${width}px`);
      if (width === 375) {
        await a.page.locator('#bottle').screenshot({ path:path.join(os.tmpdir(), 'my-site-check', 'bottle-375.png') });
        await a.page.locator('#mikuji').screenshot({ path:path.join(os.tmpdir(), 'my-site-check', 'mikuji-375.png') });
      }
      assert.deepEqual(a.errors, []);
    } finally { await a.context.close(); }
    const u = await open({ page:'/usage.html', admin:true, width, rpc:{ site_usage_summary:usageSummary() } });
    try {
      await u.page.locator('#places tr').first().waitFor();
      const r = await u.page.evaluate(() => ({
        scroll:document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small:[...document.querySelectorAll('button, summary, .site-bar a')].filter(e => e.getClientRects().length)
          .map(e => [e.textContent.trim().slice(0, 10), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 44),
        bars:[...document.querySelectorAll('.col .bar')].every(e => e.getBoundingClientRect().width <= 24.5),
      }));
      assert.equal(r.scroll, 0, `usage page: no sideways scroll at ${width}px`);
      assert.deepEqual(r.small, [], `usage page: 44px targets at ${width}px`);
      assert.equal(r.bars, true, `usage page: thin bars at ${width}px`);
      if (width === 375) await u.page.screenshot({ path:path.join(os.tmpdir(), 'my-site-check', 'usage-375.png'), fullPage:true });
      assert.deepEqual(u.errors, []);
    } finally { await u.context.close(); }
  }
});
