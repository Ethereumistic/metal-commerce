import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Run from any directory: node artifacts/zodiac-products/vector-sets/build.mjs
const output = path.dirname(fileURLToPath(import.meta.url));
const source = path.dirname(output);
const signs = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'];
const SIZE = 704;
const CENTER = SIZE / 2;
const OLD_ICON_VIEWPORT = 260;
const ENLARGEMENT = 1.5;
const ICON_SCALE = OLD_ICON_VIEWPORT * ENLARGEMENT / 24;
const number = value => String(Number(value.toFixed(10)));
const title = sign => sign[0].toUpperCase() + sign.slice(1);
const hash = text => createHash('sha256').update(text).digest('hex');
const records = [];
const images = { icons: [], constellations: [] };
const browser = await chromium.launch({ executablePath: process.env.ZODIAC_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  for (const kind of Object.keys(images)) await fs.mkdir(path.join(output, kind), { recursive: true });

  async function readGeometry(file, isIcon) {
    const original = await fs.readFile(file, 'utf8');
    await page.setContent(original);
    const result = await page.evaluate(isIcon => {
      const root = document.querySelector('svg');
      if (!root || document.querySelector('parsererror')) throw new Error('Invalid source SVG');
      if (root.querySelector('image, foreignObject, script')) throw new Error('Source must be vector geometry only');
      const bbox = root.getBBox();
      const attributes = isIcon
        ? 'fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="#ffffff" stroke="none"';
      // These icons use only round caps and joins: their painted bounds expand
      // by exactly half the stroke width around the native path bounds.
      const radius = isIcon ? 1 : 0;
      return {
        box: { x: bbox.x - radius, y: bbox.y - radius, width: bbox.width + radius * 2, height: bbox.height + radius * 2 },
        content: `<g ${attributes}>${root.innerHTML}</g>`,
        paths: [...root.querySelectorAll('path')].map(el => el.getAttribute('d')),
        transforms: [...root.querySelectorAll('[transform]')].map(el => el.getAttribute('transform')),
      };
    }, isIcon);
    assert(result.box.width > 0 && result.box.height > 0);
    return { ...result, file, sourceHash: hash(original) };
  }

  async function writeDesign(sign, kind, geometry, scale) {
    const { box } = geometry;
    const tx = CENTER - scale * (box.x + box.width / 2);
    const ty = CENTER - scale * (box.y + box.height / 2);
    const bounds = { x: tx + box.x * scale, y: ty + box.y * scale, width: box.width * scale, height: box.height * scale };
    const label = `${title(sign)} ${kind === 'icons' ? 'zodiac icon' : 'constellation'}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-labelledby="title description">
  <title id="title">${label}</title>
  <desc id="description">Centered vector artwork on a matte black square. White areas represent the design openings. Original source proportions preserved.</desc>
  <rect width="${SIZE}" height="${SIZE}" fill="#151515"/>
  <g id="artwork-bounds"><g transform="translate(${number(tx)} ${number(ty)}) scale(${number(scale)})">
    ${geometry.content}
  </g></g>
</svg>\n`;
    const file = path.join(output, kind, `${sign}.svg`);
    await fs.writeFile(file, svg);

    // Validate the saved SVG in the browser, independently of the layout formula.
    await page.setContent(await fs.readFile(file, 'utf8'));
    const actual = await page.evaluate(() => {
      const root = document.querySelector('svg');
      const artwork = root.querySelector('#artwork-bounds');
      const b = artwork.getBBox();
      return {
        box: { x: b.x, y: b.y, width: b.width, height: b.height },
        paths: [...artwork.querySelectorAll('path')].map(el => el.getAttribute('d')),
        transforms: [...artwork.querySelectorAll('[transform]')].slice(1).map(el => el.getAttribute('transform')),
        vectorOnly: !root.querySelector('image, foreignObject, script'),
        viewBox: root.getAttribute('viewBox'),
      };
    });
    const radius = kind === 'icons' ? scale : 0;
    actual.box.x -= radius;
    actual.box.y -= radius;
    actual.box.width += radius * 2;
    actual.box.height += radius * 2;
    for (const key of Object.keys(bounds)) assert(Math.abs(actual.box[key] - bounds[key]) < 0.01, `${label}: incorrect ${key}`);
    assert(Math.abs(actual.box.x + actual.box.width / 2 - CENTER) < 0.01, `${label}: not centered on X`);
    assert(Math.abs(actual.box.y + actual.box.height / 2 - CENTER) < 0.01, `${label}: not centered on Y`);
    assert.deepEqual(actual.paths, geometry.paths, `${label}: original paths changed`);
    assert.deepEqual(actual.transforms, geometry.transforms, `${label}: original transforms changed`);
    assert(actual.vectorOnly);
    assert.equal(actual.viewBox, `0 0 ${SIZE} ${SIZE}`);
    assert.equal(hash(await fs.readFile(geometry.file, 'utf8')), geometry.sourceHash, 'Source modified');
    const longEdge = Math.max(bounds.width, bounds.height);
    images[kind].push({ sign, svg });
    return {
      file: `${kind}/${sign}.svg`,
      source: path.relative(source, geometry.file),
      sourceSha256: geometry.sourceHash,
      scale,
      bounds,
      center: { x: CENTER, y: CENTER },
      longEdge,
      minimumPadding: (SIZE - longEdge) / 2,
      margins: { left: bounds.x, right: SIZE - bounds.x - bounds.width, top: bounds.y, bottom: SIZE - bounds.y - bounds.height },
    };
  }

  for (const sign of signs) {
    const icon = await readGeometry(path.join(source, 'icons', `zodiac-${sign}.svg`), true);
    const constellation = await readGeometry(path.join(source, 'constellations', `${sign}.svg`), false);
    const iconResult = await writeDesign(sign, 'icons', icon, ICON_SCALE);
    const constellationScale = iconResult.longEdge / Math.max(constellation.box.width, constellation.box.height);
    const constellationResult = await writeDesign(sign, 'constellations', constellation, constellationScale);
    assert(Math.abs(iconResult.minimumPadding - constellationResult.minimumPadding) < 1e-8);
    assert.equal(iconResult.scale / (OLD_ICON_VIEWPORT / 24), ENLARGEMENT);
    records.push({ sign, icon: iconResult, constellation: constellationResult });
  }

  for (const [kind, designs] of Object.entries(images)) {
    const cells = designs.map(({ sign, svg }, i) => {
      const x = 28 + (i % 4) * 240;
      const y = 90 + Math.floor(i / 4) * 258;
      const thumbnail = svg.replace(/<svg[^>]*>/, `<svg x="${x}" y="${y}" width="216" height="216" viewBox="0 0 ${SIZE} ${SIZE}">`)
        .replace('aria-labelledby="title description"', '')
        .replaceAll('id="title"', `id="${kind}-${sign}-title"`)
        .replaceAll('id="description"', `id="${kind}-${sign}-description"`)
        .replaceAll('id="artwork-bounds"', `id="${kind}-${sign}-artwork"`);
      return `${thumbnail}<text x="${x + 108}" y="${y + 242}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#222">${title(sign)}</text>`;
    }).join('\n');
    await fs.writeFile(path.join(output, `${kind}-preview.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="988" height="874" viewBox="0 0 988 874"><rect width="988" height="874" fill="#fafafa"/><text x="28" y="48" font-family="Arial, sans-serif" font-size="26" fill="#222">${kind === 'icons' ? 'Zodiac icons — 1.5× scale' : 'Constellations — matched minimum padding'}</text>${cells}</svg>\n`);
  }
  await fs.copyFile(path.join(source, 'icons', 'TABLER-LICENSE.md'), path.join(output, 'TABLER-LICENSE.md'));
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify({ canvas: SIZE, oldIconViewport: OLD_ICON_VIEWPORT, iconViewport: OLD_ICON_VIEWPORT * ENLARGEMENT, enlargement: ENLARGEMENT, centeringTolerance: 0.01, paddingRule: 'Same longest visible dimension and minimum edge padding for each corresponding icon/constellation pair. Original aspect ratios preserved.', records }, null, 2) + '\n');
  console.log(`Created and validated ${records.length * 2} vector SVGs; exact 1.5× icon scale, centered painted bounds, matched padding in all 12 pairs.`);
} finally {
  await browser.close();
}
