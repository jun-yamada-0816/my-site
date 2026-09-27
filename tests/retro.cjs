// Run with Node and Playwright. All Supabase requests are intercepted: no live writes.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const profileId = "00000000-0000-4000-8000-000000000095";
const output =
  process.env.TEST_OUTPUT || path.join(os.tmpdir(), "my-site-check");
let profile = null,
  failSave = false,
  failRead = false,
  failCounter = false,
  increments = 0,
  visits = 999;
const errors = [];
const diary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "夜のひとりごと",
  content: "今日も、ゆっくり。",
  created_at: "2026-09-26T15:00:00Z",
  view_count: 4,
};
const user = {
  id: "20000000-0000-4000-8000-000000000001",
  email: "admin@example.test",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
};
const token = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  ),
  Buffer.from(
    JSON.stringify({
      sub: user.id,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url"),
  "test-signature",
].join(".");
const assets = [
  ["https://cdn.tailwindcss.com/", "tailwind.js"],
  [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49/dist/umd/supabase.min.js",
    "supabase.js",
  ],
];

(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const [url, name] of assets) {
    const file = path.join(output, name);
    try {
      await fs.access(file);
    } catch {
      const response = await fetch(url);
      assert(response.ok, "Unable to load test dependency " + name);
      await fs.writeFile(file, await response.text());
    }
  }
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function newContext(options = {}) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
      ...options,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1") return route.continue();
      if (url.hostname === "cdn.tailwindcss.com")
        return route.fulfill({
          path: path.join(output, "tailwind.js"),
          contentType: "text/javascript",
        });
      if (url.hostname === "cdn.jsdelivr.net")
        return route.fulfill({
          path: path.join(output, "supabase.js"),
          contentType: "text/javascript",
        });
      if (!url.hostname.endsWith(".supabase.co")) return route.abort();
      const send = (body, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (url.pathname.endsWith("/token"))
        return send({
          access_token: token,
          refresh_token: "test-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        });
      if (url.pathname.endsWith("/logout"))
        return route.fulfill({ status: 204 });
      if (url.pathname.endsWith("/user")) return send(user);
      if (url.pathname.endsWith("/blog_posts")) {
        if (route.request().method() === "POST") {
          if (failSave)
            return send(
              { message: "Test: permission denied", code: "42501" },
              403,
            );
          assert(
            route.request().headers().authorization?.startsWith("Bearer "),
            "Authenticated write required",
          );
          profile = route.request().postDataJSON();
          assert.equal(profile.id, profileId);
          return send({ id: profile.id }, 201);
        }
        if (url.searchParams.get("id") === "eq." + profileId) {
          if (failRead) return send({ message: "Test: offline" }, 503);
          return send(profile ? [profile] : []);
        }
        assert.equal(
          url.searchParams.get("id"),
          "neq." + profileId,
          "Profile must be filtered on the server before diary limit",
        );
        return send([diary]);
      }
      if (url.pathname.endsWith("/site_visits")) return send({ count: visits });
      if (url.pathname.endsWith("/increment_visit_count")) {
        if (failCounter) return send({ message: "Test: offline" }, 503);
        increments++;
        return send(++visits);
      }
      if (url.pathname.endsWith("/increment_post_views")) return send(5);
      if (url.pathname.endsWith("/bulletin_messages"))
        return send([
          {
            id: "30000000-0000-4000-8000-000000000001",
            author_name: "夜ふかしさん",
            content: "こんばんは。足あとを残していきます。",
            created_at: "2026-09-26T14:42:00Z",
            parent_id: null,
          },
          {
            id: "30000000-0000-4000-8000-000000000002",
            author_name: "管理人",
            content: "来てくれて、ありがとうございます。",
            created_at: "2026-09-26T15:00:00Z",
            parent_id: "30000000-0000-4000-8000-000000000001",
          },
        ]);
      return send([]);
    });
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    return context;
  }
  async function settle(page) {
    await page.waitForFunction(
      () =>
        document.querySelector("#visit-counter span") ||
        document.querySelector("#visit-counter")?.title,
    );
    await page.waitForFunction(() =>
      document.querySelector("#posts-container article"),
    );
  }
  try {
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(base);
    await settle(page);
    assert.equal(
      await page.locator("#visit-counter").textContent(),
      "00001000",
    );
    assert(await page.locator("#kiriban-message").isVisible());
    assert.equal(increments, 1);
    assert.equal(await page.locator("#edit-profile-btn").isVisible(), false);
    await page.screenshot({ path: path.join(output, "desktop.png") });
    await page.reload();
    await settle(page);
    assert.equal(increments, 1, "Reload must not count twice");
    await page.locator("#admin-btn").click();
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-pw").fill("test-password");
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#admin-menu").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "PROFILE / プロフィールを編集する" })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#profile-save-btn").disabled,
    );
    await page.locator("#edit-profile-name").fill("星の管理人 <script>");
    await page
      .locator("#edit-profile-tagline")
      .fill("1995年からの、小さな居場所。");
    await page
      .locator("#edit-profile-bio")
      .fill("はじめまして。\n<img src=x onerror=alert(1)>\n改行も保存します。");
    await page.locator("#edit-profile-likes").fill("星と海、音楽");
    await page.screenshot({ path: path.join(output, "profile-editor.png") });
    failSave = true;
    await page.locator("#profile-save-btn").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#profile-error")
        .textContent.includes("保存できません"),
    );
    assert.equal(
      await page.locator("#edit-profile-name").inputValue(),
      "星の管理人 <script>",
    );
    assert.equal(profile, null, "Failed write must not claim success");
    failSave = false;
    await page.locator("#profile-save-btn").click();
    await page.locator("#profile-editor").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#profile-name").textContent(),
      "星の管理人 <script>",
    );
    assert.equal(
      await page.locator("#profile-bio img").count(),
      0,
      "Profile text must never become HTML",
    );
    await page.reload();
    await settle(page);
    await page.waitForFunction(() =>
      document
        .querySelector("#profile-name")
        .textContent.includes("星の管理人"),
    );
    assert(
      !(await page.locator("#posts-container").textContent()).includes(
        "__site_profile",
      ),
    );
    assert(
      (await page.locator("#news-list").textContent()).includes(
        "プロフィールを更新",
      ),
    );
    await page.locator("#admin-btn").click();
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await page.locator("#admin-menu").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#edit-profile-btn").isVisible(), false);
    await page.locator("#news-list [data-news-post]").click();
    assert.equal(
      await page.locator("#detail-title").textContent(),
      diary.title,
    );
    await page.keyboard.press("Escape");
    // A separate anonymous browser must read the saved public profile.
    const visitor = await newContext({ viewport: { width: 390, height: 844 } });
    const phone = await visitor.newPage();
    await phone.goto(base + "?utm_source=youtube");
    await settle(phone);
    await phone.waitForFunction(() =>
      document
        .querySelector("#profile-name")
        .textContent.includes("星の管理人"),
    );
    assert(await phone.locator("#from-video").isVisible());
    await phone.screenshot({
      path: path.join(output, "mobile.png"),
      fullPage: false,
    });
    for (const width of [320, 390, 768, 1024, 1440]) {
      await phone.setViewportSize({ width, height: 900 });
      const overflow = await phone.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false, "Horizontal overflow at " + width);
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator("#mobile-menu-btn").click();
    assert.equal(
      await phone.locator("#mobile-menu-btn").getAttribute("aria-expanded"),
      "true",
    );
    await phone.locator('#mobile-menu a[href="#music"]').click();
    assert.equal(
      await phone.locator("#mobile-menu-btn").getAttribute("aria-expanded"),
      "false",
    );
    const missingAnchors = await phone.evaluate(() =>
      [...document.querySelectorAll('a[href^="#"]')]
        .map((a) => a.getAttribute("href").slice(1))
        .filter((id) => id && !document.getElementById(id)),
    );
    assert.deepEqual(missingAnchors, []);
    const duplicateIds = await phone.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((x) => x.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    assert.deepEqual(duplicateIds, []);
    await phone.locator("#settings-btn").click();
    assert(await phone.locator("#settings-modal").isVisible());
    await phone.keyboard.press("Escape");
    await phone.locator("#sos-btn").click();
    assert(await phone.locator("#sos-modal").isVisible());
    await phone.keyboard.press("Escape");
    await phone.locator("#admin-btn").click();
    await phone.locator("#login-email").fill(user.email);
    await phone.locator("#login-pw").fill("test-password");
    await phone.locator("#login-form button[type=submit]").click();
    await phone.locator("#admin-menu").waitFor({ state: "visible" });
    await phone
      .getByRole("button", { name: "PROFILE / プロフィールを編集する" })
      .click();
    await phone.waitForFunction(
      () => !document.querySelector("#profile-save-btn").disabled,
    );
    await phone.locator("#edit-profile-likes").fill("");
    await phone.locator("#edit-profile-since").fill("");
    await phone.locator("#profile-save-btn").click();
    await phone.locator("#profile-editor").waitFor({ state: "hidden" });
    assert.equal(await phone.locator("#profile-likes-row").isVisible(), false);
    assert.equal(await phone.locator("#profile-since-row").isVisible(), false);
    // A failed profile read must block edits instead of overwriting saved data with defaults.
    await page.locator("#admin-btn").click();
    await page.locator("#login-email").fill(user.email);
    await page.locator("#login-pw").fill("test-password");
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#admin-menu").waitFor({ state: "visible" });
    failRead = true;
    await page
      .getByRole("button", { name: "PROFILE / プロフィールを編集する" })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#profile-error")
        .textContent.includes("読み込めません"),
    );
    assert(await page.locator("#profile-save-btn").isDisabled());
    failRead = false;
    await page.keyboard.press("Escape");
    // Failed counter calls remain retryable on reload.
    const fresh = await newContext();
    const retry = await fresh.newPage();
    failCounter = true;
    await retry.goto(base);
    await settle(retry);
    assert.equal(
      await retry.evaluate(() => localStorage.getItem("hoshiumi_visit_day")),
      null,
    );
    failCounter = false;
    const before = increments;
    await retry.reload();
    await settle(retry);
    assert.equal(increments, before + 1);
    assert.deepEqual(errors, [], "Uncaught browser errors");
    console.log(
      "PASS: profile login/edit/save/error/reload/public read/logout, XSS escaping, diary isolation, counter/retry, navigation, mobile widths, support/settings.",
    );
    console.log("Screenshots: " + output);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
