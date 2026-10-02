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
let bbsStatus = 422, bbsResponse = { error: "not_allowed" };
const bbsSubmissions = [];
const diary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "夜のひとりごと",
  content: "今日も、ゆっくり。",
  created_at: "2026-09-26T15:00:00Z",
  view_count: 4,
};
// Diary edits and paging. Older generated entries have no view_count column,
// matching a production DB where the optional counter SQL has not been run.
let failDiaryUpdate = false,
  manyDiaries = false,
  viewIncrements = 0;
const diaryUpdates = [];
const diaryPageRequests = [];
const olderDiaries = Array.from({ length: 102 }, (_, i) => ({
  id: `10000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`,
  title: `むかしの日記 ${i + 2}`,
  content: "少し前の、ひとりごと。",
  created_at: new Date(Date.UTC(2026, 5, 1) - i * 86400000).toISOString(),
}));
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
      if (url.hostname === "127.0.0.1" && url.pathname === "/api/bulletin") {
        bbsSubmissions.push(route.request().postDataJSON());
        return route.fulfill({ status: bbsStatus, contentType: "application/json", body: JSON.stringify(bbsResponse) });
      }
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
        if (route.request().method() === "PATCH") {
          assert(
            route.request().headers().authorization?.startsWith("Bearer "),
            "Authenticated diary edit required",
          );
          const body = route.request().postDataJSON();
          diaryUpdates.push({ id: url.searchParams.get("id"), body });
          assert.notEqual(url.searchParams.get("id"), "eq." + profileId, "Diary edit must never touch the profile");
          assert.deepEqual(Object.keys(body).sort(), ["content", "title"], "Edit sends only title and content");
          // PostgREST answers .single() with 406 when RLS lets no row through.
          if (failDiaryUpdate)
            return send({ code: "PGRST116", message: "Test: no rows updated" }, 406);
          assert.equal(url.searchParams.get("id"), "eq." + diary.id);
          Object.assign(diary, body);
          return send(diary);
        }
        if (url.searchParams.get("id") === "eq." + diary.id) return send([diary]);
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
        if (!manyDiaries) return send([diary]);
        const all = [diary, ...olderDiaries];
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || all.length);
        diaryPageRequests.push(offset);
        const rows = all.slice(offset, offset + limit);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "content-range",
            "content-range": `${offset}-${offset + rows.length - 1}/${all.length}`,
          },
          body: JSON.stringify(rows),
        });
      }
      if (url.pathname.endsWith("/site_visits")) return send({ count: visits });
      if (url.pathname.endsWith("/increment_visit_count")) {
        if (failCounter) return send({ message: "Test: offline" }, 503);
        increments++;
        return send(++visits);
      }
      if (url.pathname.endsWith("/increment_post_views")) {
        viewIncrements++;
        return send(5);
      }
      if (url.pathname.endsWith("/bulletin_messages")) {
        assert.equal(route.request().method(), "GET", "BBS must never write directly to Supabase");
        return send([
          {
            id: "30000000-0000-4000-8000-000000000001",
            edited_at: null,
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
      }
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
    // Rejected/failed posts and replies must preserve drafts and never appear in the feed.
    const draft = 'テスト用の未公開メッセージ';
    await page.locator('#msg-name').fill('テスト投稿者');
    await page.locator('#msg-content').fill(draft);
    await page.locator('#msg-submit').click();
    await page.waitForFunction(() => document.querySelector('#msg-error').textContent.includes('掲載できません'));
    assert.equal(await page.locator('#msg-content').inputValue(), draft);
    assert(!(await page.locator('#messages-container').textContent()).includes(draft));
    bbsStatus = 503; bbsResponse = { error: 'unavailable' };
    await page.locator('#msg-submit').click();
    await page.waitForFunction(() => document.querySelector('#msg-error').textContent.includes('受け付けていません'));
    assert.equal(await page.locator('#msg-content').inputValue(), draft);
    const parentId = '30000000-0000-4000-8000-000000000001';
    await page.evaluate(id => openReply(id), parentId);
    await page.locator('#reply-name-' + parentId).fill('返信テスト');
    await page.locator('#reply-content-' + parentId).fill(draft);
    bbsStatus = 422; bbsResponse = { error: 'not_allowed' };
    await page.locator('#reply-submit-' + parentId).click();
    await page.waitForFunction(id => document.getElementById('reply-error-' + id)?.textContent.includes('掲載できません'), parentId);
    assert.equal(await page.locator('#reply-content-' + parentId).inputValue(), draft);
    assert.equal(bbsSubmissions.at(-1).parent_id, parentId);
    await page.evaluate(() => cancelReply());
    bbsStatus = 201; bbsResponse = { message: { id: '30000000-0000-4000-8000-000000000099',
      author_name: 'テスト投稿者', content: '確認を通過した書き込み', parent_id: null, edited_at: null, created_at: '2026-10-02T00:00:00Z' } };
    await page.locator('#msg-content').fill('確認を通過した書き込み');
    await page.locator('#msg-submit').click();
    await page.waitForFunction(() => document.querySelector('#messages-container').textContent.includes('確認を通過した書き込み'));
    assert.equal(await page.locator('#msg-content').inputValue(), '');
    assert.equal(bbsSubmissions.length, 4);
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
    // Admin diary editing: from the detail view, failure keeps the draft, success updates everywhere.
    const viewsBeforeAdmin = viewIncrements;
    await page.locator("#posts-container article h3 button").first().click();
    await page.locator("#detail-modal").waitFor({ state: "visible" });
    assert.equal(viewIncrements, viewsBeforeAdmin, "Admin reading must not count as a view");
    await page.getByRole("button", { name: "この日記を編集する" }).click();
    await page.locator("#post-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#detail-modal").isVisible(), false);
    await page.waitForFunction(() => !document.querySelector("#post-submit").disabled);
    assert.equal(await page.locator("#post-modal-title").textContent(), "日記を編集する");
    assert.equal(await page.locator("#post-title").inputValue(), "夜のひとりごと");
    assert.equal(await page.locator("#post-content").inputValue(), "今日も、ゆっくり。");
    assert(await page.locator("#post-edit-note").isVisible());
    const editedTitle = "夜のひとりごと（なおしました）";
    const editedBody = "今日も、ゆっくり。\n<img src=x onerror=alert(1)>\n誤字をなおしました。";
    await page.locator("#post-title").fill(editedTitle);
    await page.locator("#post-content").fill(editedBody);
    await page.screenshot({ path: path.join(output, "diary-editor.png") });
    failDiaryUpdate = true;
    const popupsBefore = context.pages().length;
    await page.locator("#post-submit").click();
    await page.waitForFunction(() => document.querySelector("#post-error").textContent.includes("保存できません"));
    assert.equal(await page.locator("#post-title").inputValue(), editedTitle, "Failed save keeps the title");
    assert.equal(await page.locator("#post-content").inputValue(), editedBody, "Failed save keeps the text");
    assert.equal(diary.title, "夜のひとりごと", "Failed write must not change the diary");
    failDiaryUpdate = false;
    await page.locator("#post-submit").click();
    await page.locator("#post-modal").waitFor({ state: "hidden" });
    assert.equal(context.pages().length, popupsBefore, "Editing must not open an X compose tab");
    assert.equal(diaryUpdates.at(-1).id, "eq." + diary.id);
    // Saving from the detail view returns to the updated entry.
    await page.locator("#detail-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#detail-title").textContent(), editedTitle);
    assert.equal(await page.locator("#detail-content").textContent(), editedBody);
    assert.equal(await page.locator("#detail-content img").count(), 0, "Diary text must never become HTML");
    await page.keyboard.press("Escape");
    await page.locator("#detail-modal").waitFor({ state: "hidden" });
    assert((await page.locator("#posts-container").textContent()).includes(editedTitle));
    assert.equal(await page.locator("#posts-container img").count(), 0);
    assert((await page.locator("#post-saved").textContent()).includes("保存しました"));
    assert((await page.locator("#news-list").textContent()).includes(editedTitle));
    // From the list: closing with unsaved changes asks first, and keeps them when declined.
    await page.getByRole("button", { name: `「${editedTitle}」を編集` }).click();
    await page.waitForFunction(() => !document.querySelector("#post-submit").disabled);
    await page.locator("#post-content").fill("書きかけ");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.keyboard.press("Escape");
    assert(await page.locator("#post-modal").isVisible(), "Declined discard keeps the editor open");
    assert.equal(await page.locator("#post-content").inputValue(), "書きかけ");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#post-modal button[aria-label='閉じる']").click();
    await page.locator("#post-modal").waitFor({ state: "hidden" });
    assert.equal(diary.content, editedBody, "Discarded draft must not be saved");
    // A new diary after an edit starts empty, in new-post mode.
    await page.locator("#new-post-btn").click();
    assert.equal(await page.locator("#post-modal-title").textContent(), "新規ブログ投稿");
    assert.equal(await page.locator("#post-title").inputValue(), "");
    assert.equal(await page.locator("#post-edit-note").isVisible(), false);
    await page.keyboard.press("Escape");
    await page.locator("#post-modal").waitFor({ state: "hidden" });
    await page.locator("#admin-btn").click();
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await page.locator("#admin-menu").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#edit-profile-btn").isVisible(), false);
    assert.equal(
      await page.locator('#posts-container [aria-label$="を編集"]').count(),
      0,
      "Visitors never see diary edit buttons",
    );
    const viewsBeforeVisitor = viewIncrements;
    await page.locator("#news-list [data-news-post]").click();
    assert.equal(
      await page.locator("#detail-title").textContent(),
      diary.title,
    );
    assert.equal(await page.locator("#detail-admin").isVisible(), false);
    for (let i = 0; i < 50 && viewIncrements === viewsBeforeVisitor; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(viewIncrements, viewsBeforeVisitor + 1, "Visitor reading counts once");
    await page.keyboard.press("Escape");
    // A separate anonymous browser must read the saved public profile.
    const visitor = await newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
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
    for (const largeText of [false, true]) {
      await phone.evaluate(
        (value) =>
          document.documentElement.classList.toggle("large-text", value),
        largeText,
      );
      for (const width of [320, 390, 480, 639, 640, 768, 1023, 1024, 1440]) {
        await phone.setViewportSize({ width, height: 900 });
        const layout = await phone.evaluate(() => {
          const selectors =
            ".retro-nav > a, .nav-tools button, .hero-actions a, .ticker-toggle, .mood-btn, #msg-submit, .quick-actions > a, #sos-btn";
          const controls = [...document.querySelectorAll(selectors)]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                name:
                  element.getAttribute("aria-label") ||
                  element.textContent.trim(),
                width: rect.width,
                height: rect.height,
                left: rect.left,
                right: rect.right,
              };
            })
            .filter((rect) => rect.width && rect.height);
          return {
            width: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls,
            sidebar: getComputedStyle(document.querySelector(".sidebar"))
              .display,
            bodyText: parseFloat(
              getComputedStyle(document.querySelector(".profile-bio")).fontSize,
            ),
          };
        });
        assert.equal(
          layout.width,
          width,
          "Mobile viewport must stay at device width",
        );
        assert.equal(
          layout.overflow,
          false,
          `Horizontal overflow at ${width}, large text ${largeText}`,
        );
        assert.equal(
          layout.sidebar === "none",
          width < 1024,
          "Sidebar requires room for a readable main column",
        );
        assert(
          layout.bodyText >= 16,
          "Main content must be readable without zoom",
        );
        for (const control of layout.controls) {
          assert(
            control.width >= 43.5 && control.height >= 43.5,
            `Touch target too small at ${width}: ${JSON.stringify(control)}`,
          );
          assert(
            control.left >= -1 && control.right <= width + 1,
            `Clipped control at ${width}: ${JSON.stringify(control)}`,
          );
        }
      }
    }
    await phone.evaluate(() =>
      document.documentElement.classList.remove("large-text"),
    );
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator("#bulletin").scrollIntoViewIfNeeded();
    await phone.screenshot({ path: path.join(output, "mobile-bbs.png") });
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
    // Short heights cover landscape and the reduced room while entering text.
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 460 },
      { width: 844, height: 390 },
    ]) {
      await phone.setViewportSize(viewport);
      await phone
        .locator("#edit-profile-bio")
        .fill("スマホでも、横向きでも。\n読みやすいホームページに。");
      await phone.locator("#profile-save-btn").scrollIntoViewIfNeeded();
      const editor = await phone.evaluate(() => {
        const dialog = document.querySelector("#profile-editor");
        const rect = dialog.getBoundingClientRect();
        const save = document
          .querySelector("#profile-save-btn")
          .getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          scroll: dialog.scrollWidth > dialog.clientWidth,
          saveTop: save.top,
          saveBottom: save.bottom,
          font: parseFloat(
            getComputedStyle(document.querySelector("#edit-profile-bio"))
              .fontSize,
          ),
        };
      });
      assert(
        editor.top >= 0 && editor.bottom <= viewport.height + 1,
        "Editor must fit the visible screen",
      );
      assert(
        !editor.scroll && editor.width <= viewport.width,
        "Editor must not scroll sideways",
      );
      assert(
        editor.saveTop >= 0 && editor.saveBottom <= viewport.height + 1,
        "Save must remain reachable",
      );
      assert(editor.font >= 16, "Inputs must not trigger automatic zoom");
    }
    await phone.screenshot({
      path: path.join(output, "mobile-editor-landscape.png"),
    });
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator("#edit-profile-likes").fill("");
    await phone.locator("#edit-profile-since").fill("");
    await phone.locator("#profile-save-btn").click();
    await phone.locator("#profile-editor").waitFor({ state: "hidden" });
    assert.equal(await phone.locator("#profile-likes-row").isVisible(), false);
    assert.equal(await phone.locator("#profile-since-row").isVisible(), false);
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.locator("#admin-btn").click();
    await phone.getByRole("button", { name: "DIARY / 日記を書く" }).click();
    await phone.locator("#post-title").fill("横向きからの日記");
    await phone
      .locator("#post-content")
      .fill("画面が低くても投稿ボタンまでスクロールできます。");
    const publish = phone.locator("#post-form button[type=submit]");
    await publish.scrollIntoViewIfNeeded();
    const publishBox = await publish.boundingBox();
    assert(
      publishBox.y >= 0 && publishBox.y + publishBox.height <= 391,
      "Diary submit must be reachable in landscape",
    );
    await phone.keyboard.press("Escape");
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
    // More than 100 diaries: older ones load on demand instead of disappearing.
    manyDiaries = true;
    const archive = await (await newContext()).newPage();
    await archive.goto(base);
    await settle(archive);
    await archive.waitForFunction(() =>
      document.querySelector("#posts-container").textContent.includes("103件のうち 5件"),
    );
    assert.equal(
      (await archive.locator("#posts-container").textContent()).includes("回閲覧"),
      true,
      "Entries with a view count show it",
    );
    for (let i = 0; i < 20; i++) await archive.getByRole("button", { name: /もっと見る/ }).click();
    await archive.waitForFunction(() => document.querySelectorAll("#posts-container article").length === 103);
    assert.deepEqual(diaryPageRequests, [0, 100], "Second page is requested only when needed");
    assert.equal(await archive.getByRole("button", { name: /もっと見る/ }).count(), 0);
    assert.equal(
      await archive.locator("#posts-container article").last().locator("text=回閲覧").count(),
      0,
      "No invented view count when the column is missing",
    );
    manyDiaries = false;
    assert.deepEqual(errors, [], "Uncaught browser errors");
    console.log(
      "PASS: profile login/edit/save/error/reload/public read/logout, diary edit/save/error/discard/paging/view counts, XSS escaping, diary isolation, counter/retry, navigation, mobile widths, support/settings.",
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
