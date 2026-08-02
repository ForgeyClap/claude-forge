#!/usr/bin/env node
/**
 * WP11 — real pixel diff for the before/after screenshot pairs.
 *
 * The two PNGs of an unchanged view are NOT always byte-identical (PNG
 * re-encoding, and Chromium's own sub-pixel text rasterisation, can differ by
 * a few bytes between two separate process launches even when nothing visible
 * changed). A byte-equality check alone would therefore either produce false
 * "regressions" or require a lossless-recompression assumption this script
 * does not want to make. Real proof needs actual pixel comparison.
 *
 * No new npm dependency (no pixelmatch/pngjs install): this uses the
 * already-installed @playwright/test's `chromium` to open a real browser and
 * do the comparison with the browser's own native <canvas> 2D API — decode
 * both PNGs, draw them, read back ImageData, and diff channel-by-channel.
 * That is a real pixel-level comparison, not a byte-level guess.
 *
 * Usage: node scripts/wp11-pixel-diff.cjs <dir> <name-list-file-or-view,vp,view,vp,...>
 *   node scripts/wp11-pixel-diff.cjs ../mission/visual-review home,1440 home,375 ...
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

async function main() {
  const dir = process.argv[2];
  const pairs = process.argv.slice(3).map((s) => s.split(','));
  if (!dir || pairs.length === 0) {
    console.error('usage: node scripts/wp11-pixel-diff.cjs <dir> <view,vp> [<view,vp> ...]');
    process.exit(1);
  }

  const suffixA = process.env.WP11_SUFFIX_A || 'before';
  const suffixB = process.env.WP11_SUFFIX_B || 'after';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];
  for (const [view, vp] of pairs) {
    const beforePath = path.join(dir, `WP11-${view}-dark-${vp}-${suffixA}.png`);
    const afterPath = path.join(dir, `WP11-${view}-dark-${vp}-${suffixB}.png`);
    const beforeB64 = fs.readFileSync(beforePath).toString('base64');
    const afterB64 = fs.readFileSync(afterPath).toString('base64');

    const diff = await page.evaluate(
      async ({ beforeB64, afterB64 }) => {
        function loadImg(b64) {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/png;base64,${b64}`;
          });
        }
        const [imgA, imgB] = await Promise.all([loadImg(beforeB64), loadImg(afterB64)]);
        if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
          return { sizeMismatch: true, wA: imgA.width, hA: imgA.height, wB: imgB.width, hB: imgB.height };
        }
        const canvasA = document.createElement('canvas');
        canvasA.width = imgA.width;
        canvasA.height = imgA.height;
        const ctxA = canvasA.getContext('2d');
        ctxA.drawImage(imgA, 0, 0);
        const dataA = ctxA.getImageData(0, 0, imgA.width, imgA.height).data;

        const canvasB = document.createElement('canvas');
        canvasB.width = imgB.width;
        canvasB.height = imgB.height;
        const ctxB = canvasB.getContext('2d');
        ctxB.drawImage(imgB, 0, 0);
        const dataB = ctxB.getImageData(0, 0, imgB.width, imgB.height).data;

        let diffPixels = 0;
        let maxDelta = 0;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const THRESHOLD = 8; // per-channel tolerance for anti-aliasing/PNG re-encode noise

        for (let i = 0; i < dataA.length; i += 4) {
          const dr = Math.abs(dataA[i] - dataB[i]);
          const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
          const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
          const da = Math.abs(dataA[i + 3] - dataB[i + 3]);
          const delta = Math.max(dr, dg, db, da);
          if (delta > maxDelta) maxDelta = delta;
          if (delta > THRESHOLD) {
            diffPixels += 1;
            const pixelIdx = i / 4;
            const x = pixelIdx % imgA.width;
            const y = Math.floor(pixelIdx / imgA.width);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }

        return {
          sizeMismatch: false,
          width: imgA.width,
          height: imgA.height,
          totalPixels: imgA.width * imgA.height,
          diffPixels,
          maxDelta,
          bbox: diffPixels > 0 ? { minX, minY, maxX, maxY } : null,
        };
      },
      { beforeB64, afterB64 },
    );

    results.push({ view, vp, ...diff });
  }

  await browser.close();

  console.log('WP11 pixel-diff — real Canvas 2D comparison (threshold: 8/255 per channel)');
  console.log('');
  let anyRealDiff = false;
  for (const r of results) {
    if (r.sizeMismatch) {
      console.log(`${r.view.padEnd(10)} ${r.vp.padEnd(6)} SIZE MISMATCH before=${r.wA}x${r.hA} after=${r.wB}x${r.hB}`);
      anyRealDiff = true;
      continue;
    }
    const pct = ((r.diffPixels / r.totalPixels) * 100).toFixed(4);
    const flag = r.diffPixels > 0 ? (r.diffPixels > r.totalPixels * 0.0005 ? ' <-- REVIEW' : ' (noise-level)') : '';
    if (r.diffPixels > r.totalPixels * 0.0005) anyRealDiff = true;
    console.log(
      `${r.view.padEnd(10)} ${r.vp.padEnd(6)} diffPixels=${r.diffPixels}/${r.totalPixels} (${pct}%) maxDelta=${r.maxDelta} bbox=${r.bbox ? JSON.stringify(r.bbox) : 'none'}${flag}`,
    );
  }
  console.log('');
  console.log(anyRealDiff ? 'RESULT: at least one view has a diff above the noise threshold — REVIEW NEEDED.' : 'RESULT: every view is pixel-equivalent within anti-aliasing/PNG-noise tolerance.');
}

main().catch((err) => {
  console.error('wp11-pixel-diff failed:', err);
  process.exit(1);
});
