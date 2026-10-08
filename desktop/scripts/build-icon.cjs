const fs = require("fs");
const path = require("path");

const pngToIco = require("png-to-ico").default;
const { PNG } = require("pngjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const srcPng = path.join(repoRoot, "frontend", "public", "logo.png");
const dstPngs = [
  path.join(repoRoot, "desktop", "src", "icon.png"),
];
// Keep browser and desktop source icons on the same source image.
const dstIcos = [
  path.join(repoRoot, "frontend", "public", "favicon.ico"),
  path.join(repoRoot, "desktop", "src", "icon.ico"),
];

async function main() {
  if (!fs.existsSync(srcPng)) {
    // eslint-disable-next-line no-console
    console.error(`Logo not found: ${srcPng}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(srcPng);
  const input = PNG.sync.read(raw);
  const size = Math.max(input.width, input.height);

  const square = new PNG({ width: size, height: size });
  const dx = Math.floor((size - input.width) / 2);
  const dy = Math.floor((size - input.height) / 2);
  for (let y = 0; y < input.height; y += 1) {
    const srcStart = y * input.width * 4;
    const srcEnd = srcStart + input.width * 4;
    const dstStart = ((y + dy) * size + dx) * 4;
    input.data.copy(square.data, dstStart, srcStart, srcEnd);
  }

  const squarePng = PNG.sync.write(square);
  for (const dstPng of dstPngs) {
    fs.mkdirSync(path.dirname(dstPng), { recursive: true });
    fs.writeFileSync(dstPng, squarePng);
  }

  const buf = await pngToIco(squarePng);
  for (const dstIco of dstIcos) {
    fs.mkdirSync(path.dirname(dstIco), { recursive: true });
    fs.writeFileSync(dstIco, buf);
  }

  // eslint-disable-next-line no-console
  console.log(`Generated icon(s):\n${[...dstPngs, ...dstIcos].map((p) => `- ${p}`).join("\n")}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
