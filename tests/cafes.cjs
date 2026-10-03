// The cafe list must not be in the public HTML, and loads only with an admin session.
// Run with Node and Playwright (same PLAYWRIGHT_PATH / CHROMIUM_PATH as tests/retro.cjs).
// Supabase is fully mocked: nothing is sent to production.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const output = process.env.TEST_OUTPUT || path.join(os.tmpdir(), "my-site-check");
const cdnFile = path.join(output, "supabase-2.49.10.js");
const cdnUrl = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/dist/umd/supabase.min.js";
const rows = [
  { id: "nishi-023", area: "西区", name: "farmer's kitchen BLACKBIRD", address: "新潟県新潟市西区黒鳥648-1" },
  { id: "chuo-001", area: "中央区", name: "<b>珈琲</b> & 本", address: "新潟県新潟市中央区古町1-1" },
  { id: "chuo-002", area: "中央区", name: "海辺のカフェ", address: "新潟県新潟市中央区西大畑町2-2" },
];

(async () => {
  const html = await fs.readFile(path.join(root, "niigata-cafes-list.html"), "utf8");
  assert(!html.includes("新潟県新潟市"), "No cafe address may remain in the public HTML");
  await fs.mkdir(output, { recursive: true });
  try { await fs.access(cdnFile); } catch {
    const response = await fetch(cdnUrl);
    assert(response.ok, "Unable to load supabase-js for the test");
    await fs.writeFile(cdnFile, await response.text());
  }

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const url = "http://127.0.0.1:" + server.address().port + "/niigata-cafes-list.html";

  async function open({ session, reply }) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const requests = [];
    const errors = [];
    if (session) {
      await context.addInitScript((value) => {
        localStorage.setItem("sb-qnmzjwgacnfxwlbgwxcr-auth-token", JSON.stringify(value));
      }, {
        access_token: "test-access-token", refresh_token: "test-refresh", token_type: "bearer",
        expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated" },
      });
    }
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === "127.0.0.1") return route.continue();
      if (u.hostname === "cdn.jsdelivr.net")
        return route.fulfill({ path: cdnFile, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
      if (!u.hostname.endsWith(".supabase.co")) return route.abort();
      requests.push({ path: u.pathname, auth: route.request().headers().authorization });
      const [status, body] = reply();
      return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("countBar").textContent !== "読み込み中…");
    return { context, page, requests, errors };
  }

  // Not logged in: no request for the list, and a way back to the top page.
  {
    const { context, page, requests, errors } = await open({ session: false, reply: () => [500, {}] });
    assert.equal(requests.filter((r) => r.path.endsWith("/admin_cafes")).length, 0);
    assert.match(await page.locator(".empty").innerText(), /管理者だけ/);
    assert.equal(await page.locator(".empty a").getAttribute("href"), "./");
    assert.equal(await page.locator(".card").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Admin session: the list renders, escaped, with map links built from name + address.
  {
    const { context, page, requests, errors } = await open({ session: true, reply: () => [200, rows] });
    const call = requests.find((r) => r.path.endsWith("/admin_cafes"));
    assert.equal(call?.auth, "Bearer test-access-token", "The list is read with the admin session");
    assert.equal(await page.locator(".card").count(), 3);
    assert.equal((await page.locator("#total").textContent()).trim(), "全3件");
    assert.equal(await page.locator(".card-name").nth(1).innerText(), "<b>珈琲</b> & 本", "Names are text, not HTML");
    assert.equal(await page.locator(".card-name b").count(), 0);
    assert.equal(
      await page.locator(".card-link").first().getAttribute("href"),
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(rows[0].name + " " + rows[0].address),
    );
    await page.locator('.tab[data-area="中央区"]').click();
    assert.equal(await page.locator(".card").count(), 2);
    await page.locator("#search").fill("海辺");
    assert.equal(await page.locator(".card").count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Logged in but the SQL has not been run yet.
  {
    const { context, page } = await open({ session: true, reply: () => [404, { code: "PGRST205", message: "missing" }] });
    assert.match(await page.locator(".empty").innerText(), /admin-cafes\.sql/);
    await context.close();
  }

  // Logged in as someone who is not in site_admins: RLS returns no rows.
  {
    const { context, page } = await open({ session: true, reply: () => [200, []] });
    assert.match(await page.locator(".empty").innerText(), /管理者のアカウント/);
    await context.close();
  }

  await browser.close();
  server.close();
  console.log("PASS: cafe list hidden from public HTML, admin-only load, escaping, map links, filters, setup/empty messages.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
