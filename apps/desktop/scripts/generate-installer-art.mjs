import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { animationFile, bitmapFile } from "./installer-art.mjs";

const output = new URL("../assets/installer/generated/", import.meta.url);
const source = await readFile(
  new URL("../../../assets/arc-icon.png", import.meta.url),
);
const mark = await sharp(source)
  .trim()
  .resize(148, 108, { fit: "inside" })
  .png()
  .toBuffer();
const metadata = await sharp(mark).metadata();
const image = `data:image/png;base64,${mark.toString("base64")}`;
const fps = 20;
const count = 80;
const variants = [];
await mkdir(output, { recursive: true });
for (const scale of [100, 125, 150, 200]) {
  const size = (220 * scale) / 100;
  const frames = [];
  let poster;
  for (let frame = 0; frame < count; frame++) {
    const phase = frame / count;
    const wave = Math.sin(phase * Math.PI * 2);
    const t = phase;
    const x =
      (1 - t) ** 3 * -22 +
      3 * (1 - t) ** 2 * t * 88 +
      3 * (1 - t) * t * t * 140 +
      t ** 3 * 242;
    const y =
      (1 - t) ** 3 * 192 +
      3 * (1 - t) ** 2 * t * 192 +
      3 * (1 - t) * t * t * 99 +
      t ** 3 * 18;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 220 220"><defs><radialGradient id="glow"><stop stop-color="#155EFF" stop-opacity="${0.13 + 0.025 * wave}"/><stop offset="1" stop-color="#101722" stop-opacity="0"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="220" height="220" fill="#101722"/><ellipse cx="114" cy="117" rx="108" ry="88" fill="url(#glow)"/><path d="M-22 192C88 192 140 99 242 18" fill="none" stroke="#6389C1" stroke-opacity=".18"/><path d="M-16 220C116 220 190 142 248 70" fill="none" stroke="#6389C1" stroke-opacity=".09"/><circle cx="${x}" cy="${y}" r="5" fill="#3482FF" filter="url(#soft)" opacity=".55"/><circle cx="${x}" cy="${y}" r="1.6" fill="#79ACFF"/><image href="${image}" x="${(220 - metadata.width) / 2}" y="${(220 - metadata.height) / 2 - 4 + wave * 2}" width="${metadata.width}" height="${metadata.height}"/></svg>`;
    const rgb = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
    frames.push(rgb);
    if (frame === 0) poster = await sharp(Buffer.from(svg)).png().toBuffer();
  }
  const suffix = scale === 100 ? "" : `-${scale}`;
  const avi = animationFile(frames, size, size, fps);
  const bmp = bitmapFile(frames[0], size, size);
  await writeFile(new URL(`arc-motion${suffix}.avi`, output), avi);
  await writeFile(new URL(`arc-still${suffix}.bmp`, output), bmp);
  await writeFile(new URL(`arc-preview${suffix}.png`, output), poster);
  variants.push({
    scale,
    size,
    frames: count,
    fps,
    bytes: avi.length,
    sha256: createHash("sha256").update(avi).digest("hex"),
  });
}
await writeFile(
  new URL("manifest.json", output),
  JSON.stringify(
    {
      format: "BI_RGB",
      audio: false,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      variants,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Generated ARC installer motion and still assets in ${fileURLToPath(output)}`,
);
