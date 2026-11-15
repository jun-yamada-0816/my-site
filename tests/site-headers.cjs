// 本番（Vercel）と同じ応答ヘッダーを、テスト用のローカルサーバーにも付ける。
// vercel.json の Content-Security-Policy が厳しすぎてページが壊れる・ゆるめ忘れる、を
// どのテストでも気づけるようにするため（違反はブラウザーのコンソールにエラーとして出る）。
// vercel.json の source は、ここで使っている範囲（正規表現として読める書き方）に限る。
const fs = require("node:fs");
const path = require("node:path");

const rules = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"),
).headers.map((rule) => ({
  pattern: new RegExp("^" + rule.source + "$"),
  headers: rule.headers,
}));

// pathname（"/" や "/shorts.html"）に当てはまるヘッダーを { 名前: 値 } で返す。
function headersFor(pathname) {
  const out = {};
  for (const rule of rules) {
    if (!rule.pattern.test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      // 同じヘッダーが2つの決まりから付くと、ブラウザーは両方を同時に満たすものしか通さない。
      // Content-Security-Policy でそれが起きると意図しない締め出しになるので、設定の誤りとして止める。
      if (key in out) throw new Error(`vercel.json: ${key} が ${pathname} に二重に付きます`);
      out[key] = value;
    }
  }
  return out;
}

function applyHeaders(res, pathname) {
  for (const [key, value] of Object.entries(headersFor(pathname))) res.setHeader(key, value);
}

module.exports = { headersFor, applyHeaders };

// Content-Security-Policy に止められた読み込みを errors に積む（どのテストも errors が空であることを確かめている）。
function watchCsp(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error" && /Content[ -]Security[ -]Policy/i.test(message.text()))
      errors.push("CSP: " + message.text());
  });
}
module.exports.watchCsp = watchCsp;
