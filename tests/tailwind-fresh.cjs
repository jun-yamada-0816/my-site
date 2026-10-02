// tailwind.css が index.html の今のクラスと合っているかを確かめる。
// index.html でクラスを足したのに作り直し忘れると、そのクラスだけ黙って効かなくなるため。
// tools/tailwind で `npm install` 済みのときだけ動く（未インストールなら SKIP と表示して成功扱い）。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tools = path.join(root, "tools", "tailwind");
const bin = path.join(tools, "node_modules", ".bin", "tailwindcss");

if (!fs.existsSync(bin)) {
  console.log("SKIP: tools/tailwind で npm install すると、tailwind.css が最新かを確かめられます。");
  process.exit(0);
}
const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tailwind-")), "tailwind.css");
execFileSync(bin, ["-c", "tailwind.config.js", "-i", "input.css", "-o", fresh, "--minify"], {
  cwd: tools,
  stdio: "ignore",
});
if (fs.readFileSync(fresh, "utf8") !== fs.readFileSync(path.join(root, "tailwind.css"), "utf8")) {
  console.error("FAIL: tailwind.css が index.html と合っていません。tools/tailwind で `npm run build` を実行してください。");
  process.exit(1);
}
console.log("PASS: tailwind.css は index.html と合っています。");
