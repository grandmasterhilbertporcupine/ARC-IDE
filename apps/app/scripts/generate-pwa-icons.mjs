import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(appDir, "public");
const checkOnly = process.argv.includes("--check");
const artwork = await readFile(resolve(appDir, "../../assets/arc-icon.png"));
const variants = {
  "": null,
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};
const mismatches = [];

async function png(size, color, background = null) {
  let image = sharp(artwork).resize(size, size, { fit: "contain" });
  if (color) image = image.grayscale().tint(color);
  if (background) image = image.flatten({ background });
  return image.png().toBuffer();
}

async function writeOrCheck(fileName, content) {
  const filePath = join(publicDir, fileName);
  if (!checkOnly) {
    await writeFile(filePath, content);
    return;
  }
  if (!existsSync(filePath) || !(await readFile(filePath)).equals(content)) mismatches.push(fileName);
}

const manifest = JSON.parse(await readFile(join(publicDir, "manifest.webmanifest"), "utf8"));
Object.assign(manifest, { name: "ARC", short_name: "ARC", background_color: "#151515", theme_color: "#151515" });
for (const [variant, color] of Object.entries(variants)) {
  const suffix = variant ? `-${variant}` : "";
  for (const size of [192, 512]) {
    const image = await png(size, color, "#151515");
    await writeOrCheck(`icon-${size}${suffix}.png`, image);
    await writeOrCheck(`icon-${size}-maskable${suffix}.png`, image);
  }
  await writeOrCheck(`apple-touch-icon${suffix}.png`, await png(180, color, "#151515"));
  const themed = {
    ...manifest,
    icons: manifest.icons.map((icon) => icon.purpose === "monochrome" ? icon : { ...icon, src: icon.src.replace(/\.png$/u, `${suffix}.png`) }),
  };
  await writeOrCheck(`manifest${suffix}.webmanifest`, Buffer.from(`${JSON.stringify(themed, null, 2)}\n`));
}
for (const size of [192, 512]) {
  await writeOrCheck(`icon-monochrome-${size}.png`, await png(size, "#FFFFFF"));
}
for (const size of [16, 32]) {
  for (const suffix of ["", "-dark", "-dev"]) {
    await writeOrCheck(`favicon-${size}x${size}${suffix}.png`, await png(size, null));
  }
}
if (mismatches.length) {
  console.error(`Generated ARC PWA assets are out of date:\n${mismatches.join("\n")}\nRun corepack pnpm --filter @bb/app generate:pwa-icons.`);
  process.exitCode = 1;
} else {
  console.log(`ARC PWA assets ${checkOnly ? "verified" : "generated"}: 53 PNGs and 9 manifests.`);
}
