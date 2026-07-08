/**
 * Derive CrewSight Manager icon assets from the recorder color logos.
 * Swaps recorder cyan/gold accents so the manager icon is distinct
 * (gold ring + cyan pin vs recorder's cyan ring + gold pin).
 *
 * Usage: node scripts/generate-crewsight-manager-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'assets/crewsight');

/** @param {number} r @param {number} g @param {number} b */
function colorDist(r, g, b, target) {
  const [tr, tg, tb] = target;
  return Math.sqrt((r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2);
}

/**
 * @param {Buffer} data
 * @param {number} width
 * @param {number} height
 */
function remapManagerColors(data, width, height) {
  const CYAN = [0, 229, 255];
  const TEAL = [13, 148, 136];
  const GOLD = [251, 191, 36];
  const ORANGE = [249, 115, 22];
  const AMBER = [245, 158, 11];

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 16) continue;
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Swap recorder accents: cyan ring → gold, gold/orange pin → cyan.
    if (colorDist(r, g, b, CYAN) <= 120) {
      [r, g, b] = GOLD;
    } else if (colorDist(r, g, b, GOLD) <= 100 || colorDist(r, g, b, ORANGE) <= 110) {
      [r, g, b] = CYAN;
    } else if (colorDist(r, g, b, TEAL) <= 90) {
      [r, g, b] = AMBER;
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return data;
}

async function remapIcon(inFile, outFile) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(inFile)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const remapped = remapManagerColors(Buffer.from(data), info.width, info.height);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await sharp(remapped, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outFile);
  console.log('[generate-crewsight-manager-icon]', path.relative(root, outFile));
}

const pairs = [
  ['crewsight-logo-icon-only-color.png', 'crewsight-logo-icon-only-manager-color.png'],
  ['crewsight-logo-full-color.png', 'crewsight-logo-full-manager-color.png'],
];

for (const [srcName, outName] of pairs) {
  const inPath = path.join(srcDir, srcName);
  if (!fs.existsSync(inPath)) {
    console.warn('[generate-crewsight-manager-icon] skip missing', srcName);
    continue;
  }
  await remapIcon(inPath, path.join(srcDir, outName));
}

const managerIcon = path.join(srcDir, 'crewsight-logo-icon-only-manager-color.png');
const fallbackIcon = path.join(
  root,
  'apps/coach-pwa/public/assets/crewsight/crewsight-logo-icon-only-manager-color.png',
);
const iconSrc = fs.existsSync(managerIcon) ? managerIcon : fallbackIcon;
const coachIconsDir = path.join(root, 'apps/coach-pwa/public/icons');
if (fs.existsSync(iconSrc)) {
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(coachIconsDir, { recursive: true });
  for (const size of [192, 512]) {
    const outPath = path.join(coachIconsDir, `icon-${size}.png`);
    await sharp(iconSrc)
      .resize(size, size, { fit: 'contain', background: { r: 10, g: 22, b: 40, alpha: 1 } })
      .png()
      .toFile(outPath);
    console.log('[generate-crewsight-manager-icon]', path.relative(root, outPath));
  }
}

console.log('[generate-crewsight-manager-icon] done');
