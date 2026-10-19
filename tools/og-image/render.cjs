// og-image.html を 1200×630 の PNG にして ../../assets/og-image.png に書き出す。
// 使い方: PLAYWRIGHT_PATH=<playwright のある場所> [CHROMIUM_PATH=<chromium>] node render.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");

(async () => {
  // file: URLを禁止するクラウド環境でも、外部配信に依存せず描画する。
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    let file;
    if (pathname === "/og-image.html") file = path.join(__dirname, "og-image.html");
    else if (pathname === "/assets/starlit-sea.svg") file = path.join(__dirname, "../../assets/starlit-sea.svg");
    else if (/^\/node_modules\/@fontsource\/(shippori-mincho-b1|zen-kaku-gothic-new)\/(?:files\/)?[a-z0-9.-]+\.(css|woff2?)$/.test(pathname)) file = path.join(__dirname, pathname);
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const data = await fs.readFile(file);
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/og-image.html`, { waitUntil: "networkidle" });
    // Webフォントは使われるまで読み込まれないので、使う文字で明示的に読み込んでから撮る
    const missing = await page.evaluate(async () => {
      const text = document.body.innerText;
      const faces = ['600 104px "Shippori Mincho B1"', '400 26px "Zen Kaku Gothic New"', '500 21px "Zen Kaku Gothic New"'];
      const loaded = await Promise.all(faces.map((f) => document.fonts.load(f, text)));
      await document.fonts.ready;
      return faces.filter((f, i) => !loaded[i].length || !document.fonts.check(f, text));
    });
    if (missing.length) throw new Error("フォントを読み込めませんでした: " + missing.join(", "));
    await page.screenshot({ path: path.join(__dirname, "..", "..", "assets", "og-image.png") });
    console.log("assets/og-image.png を書き出しました。");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
