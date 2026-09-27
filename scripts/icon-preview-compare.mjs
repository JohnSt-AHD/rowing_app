/**
 * Side-by-side launcher icon comparison PNG.
 * Usage: node scripts/icon-preview-compare.mjs <left.png> <right.png> <out.png> <leftLabel> <rightLabel>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [leftPath, rightPath, outPath, leftLabel = 'Current', rightLabel = '+25%'] = process.argv.slice(2);

if (!leftPath || !rightPath || !outPath) {
  console.error('Usage: node scripts/icon-preview-compare.mjs <left> <right> <out> [leftLabel] [rightLabel]');
  process.exit(1);
}

const sharp = (await import('sharp')).default;
const iconSize = 256;
const pad = 24;
const labelH = 36;
const gap = 32;
const width = pad * 2 + iconSize * 2 + gap;
const height = pad * 2 + labelH + iconSize;

const left = await sharp(path.resolve(root, leftPath)).resize(iconSize, iconSize).png().toBuffer();
const right = await sharp(path.resolve(root, rightPath)).resize(iconSize, iconSize).png().toBuffer();

const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#111827"/>
  <text x="${pad + iconSize / 2}" y="${pad + 22}" fill="#94a3b8" font-family="system-ui,sans-serif" font-size="14" font-weight="600" text-anchor="middle">${leftLabel}</text>
  <text x="${pad + iconSize + gap + iconSize / 2}" y="${pad + 22}" fill="#94a3b8" font-family="system-ui,sans-serif" font-size="14" font-weight="600" text-anchor="middle">${rightLabel}</text>
</svg>`;

fs.mkdirSync(path.dirname(path.resolve(root, outPath)), { recursive: true });
await sharp(Buffer.from(svg))
  .composite([
    { input: left, left: pad, top: pad + labelH },
    { input: right, left: pad + iconSize + gap, top: pad + labelH },
  ])
  .png()
  .toFile(path.resolve(root, outPath));

console.log('[icon-preview-compare]', path.relative(root, outPath));
