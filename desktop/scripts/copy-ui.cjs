const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const srcDir = path.join(repoRoot, "frontend", ".output", "public");
const dstDir = path.join(repoRoot, "desktop", "resources", "ui");

if (!fs.existsSync(path.join(srcDir, "index.html"))) {
  // eslint-disable-next-line no-console
  console.error(
    `Nuxt static output not found at ${srcDir}. Run: npm --prefix frontend run generate`
  );
  process.exit(1);
}

fs.mkdirSync(dstDir, { recursive: true });
for (const ent of fs.readdirSync(dstDir, { withFileTypes: true })) {
  if (ent.name === ".gitkeep") continue;
  fs.rmSync(path.join(dstDir, ent.name), { recursive: true, force: true });
}
fs.cpSync(srcDir, dstDir, { recursive: true });

// HTML exports need stable icon names; Nuxt imports emit hashed asset names.
// Preserve generated/public assets, matching the exporter's copy precedence.
const wechatIcons = path.join(repoRoot, "frontend", "assets", "images", "wechat");
if (fs.existsSync(wechatIcons)) {
  fs.cpSync(
    wechatIcons,
    path.join(dstDir, "assets", "images", "wechat"),
    { recursive: true, force: false }
  );
}

// eslint-disable-next-line no-console
console.log(`Copied UI: ${srcDir} -> ${dstDir}`);
