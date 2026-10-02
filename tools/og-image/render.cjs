// og-image.html を 1200×630 の PNG にして ../../assets/og-image.png に書き出す。
// 使い方: PLAYWRIGHT_PATH=<playwright のある場所> [CHROMIUM_PATH=<chromium>] node render.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto("file://" + path.join(__dirname, "og-image.html"), { waitUntil: "networkidle" });
    // Webフォントは使われるまで読み込まれないので、使う文字で明示的に読み込んでから撮る
    const missing = await page.evaluate(async () => {
      const text = document.body.innerText;
      const faces = ['600 104px "Shippori Mincho B1"', '400 26px "Zen Kaku Gothic New"', '500 21px "Zen Kaku Gothic New"'];
      await Promise.all(faces.map((f) => document.fonts.load(f, text)));
      await document.fonts.ready;
      return faces.filter((f) => !document.fonts.check(f, text));
    });
    if (missing.length) throw new Error("フォントを読み込めませんでした: " + missing.join(", "));
    await page.screenshot({ path: path.join(__dirname, "..", "..", "assets", "og-image.png") });
    console.log("assets/og-image.png を書き出しました。");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
