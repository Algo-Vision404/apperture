#!/usr/bin/env node
// Render the apperture "Open Iris" mark into multi-size Windows/mac/linux icons.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const toIco = require('to-ico');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build-resources');

// Signal Desk palette — matches renderer/styles.css + .tb-logo treatment.
const PALETTE = {
  ink: '#14100a',
  inkDeep: '#07080b',
  accent: '#D4A017',
  accentHi: '#E8B84A',
  accentGlow: '#F6E08A',
  rim: 'rgba(255,255,255,0.38)'
};

const MASTER = 1024;
const CORNER = 224; // ~22% — modern app-icon silhouette
const MARK_FILL = 0.64; // iris occupies ~64% of tile width

function buildSvg(size) {
  const compact = size <= 32;
  const corner = Math.round((CORNER / MASTER) * size);
  const ringDiameter = 18.7; // 2 × 9.35 in the 24×24 logo viewBox
  const markScale = (size * (compact ? 0.68 : MARK_FILL)) / ringDiameter;
  const cx = size / 2;
  const cy = size / 2;
  const strokeW = Math.max(1.5, (compact ? 1.85 : 1.4) * markScale / 24);
  const markRotate = compact ? 0 : 12;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="gold" x1="8%" y1="6%" x2="92%" y2="94%">
      <stop offset="0%" stop-color="${PALETTE.accentHi}"/>
      <stop offset="52%" stop-color="${PALETTE.accent}"/>
      <stop offset="100%" stop-color="#B8890F"/>
    </linearGradient>
    <radialGradient id="shine" cx="32%" cy="26%" r="58%">
      <stop offset="0%" stop-color="${PALETTE.accentGlow}" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="${PALETTE.accentGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="depth" cx="72%" cy="80%" r="52%">
      <stop offset="0%" stop-color="${PALETTE.inkDeep}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${PALETTE.inkDeep}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.42"/>
      <stop offset="18%" stop-color="#fff" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.16"/>
    </linearGradient>
    <filter id="markShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${Math.max(1, size * 0.007)}" stdDeviation="${Math.max(1.2, size * 0.011)}"
        flood-color="${PALETTE.inkDeep}" flood-opacity="0.32"/>
    </filter>
  </defs>

  <rect width="${size}" height="${size}" rx="${corner}" fill="url(#gold)"/>
  <rect width="${size}" height="${size}" rx="${corner}" fill="url(#shine)"/>
  <rect width="${size}" height="${size}" rx="${corner}" fill="url(#depth)"/>
  <rect x="${size * 0.018}" y="${size * 0.018}" width="${size * 0.964}" height="${size * 0.964}"
    rx="${corner * 0.94}" fill="none" stroke="url(#rim)" stroke-width="${Math.max(1.5, size * 0.006)}"/>

  <g transform="translate(${cx} ${cy}) rotate(${markRotate})" filter="url(#markShadow)">
    <g transform="scale(${markScale.toFixed(4)}) translate(-12 -12)" fill="${PALETTE.ink}" stroke="none">
      <circle cx="12" cy="12" r="9.35" fill="none" stroke="${PALETTE.ink}" stroke-width="${(strokeW / markScale).toFixed(4)}" opacity="0.92"/>
      <path d="M12 3.1 15.05 8.55 12 9.7 8.95 8.55Z"/>
      <path d="M20.9 12 15.45 15.05 14.3 12 15.45 8.95Z"/>
      <path d="M12 20.9 8.95 15.45 12 14.3 15.05 15.45Z"/>
      <path d="M3.1 12 8.55 8.95 9.7 12 8.55 15.05Z"/>
      <path d="M18.85 5.15 15.55 9.85 13.85 8.65 16.45 4.55Z"/>
      <path d="M5.15 18.85 8.45 14.15 10.15 15.35 7.55 19.45Z"/>
      <circle cx="12" cy="12" r="3.55" fill="${PALETTE.ink}" opacity="0.14"/>
      <circle cx="12" cy="12" r="${compact ? 2.45 : 2.15}" fill="${PALETTE.ink}"/>
      ${
        compact
          ? ''
          : '<circle cx="10.7" cy="12" r="0.62" fill="' +
            PALETTE.ink +
            '" opacity="0.42"/>' +
            '<circle cx="13.3" cy="12" r="0.62" fill="' +
            PALETTE.ink +
            '" opacity="0.42"/>'
      }
    </g>
  </g>

  <ellipse cx="${size * 0.28}" cy="${size * 0.16}" rx="${size * 0.18}" ry="${size * 0.07}"
    fill="#fff" opacity="0.16" transform="rotate(-18 ${size * 0.28} ${size * 0.16})"/>
</svg>`;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function renderPng(size) {
  const svg = buildSvg(size);
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pngBuffers = await Promise.all(ICO_SIZES.map((s) => renderPng(s)));
  const ico = await toIco(pngBuffers);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const png512 = await renderPng(512);
  const png1024 = await renderPng(1024);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
  fs.writeFileSync(path.join(OUT_DIR, 'icon@2x.png'), png1024);

  console.log('wrote', icoPath, ico.length, 'bytes', `(${ICO_SIZES.join(', ')}px)`);
  console.log('wrote', path.join(OUT_DIR, 'icon.png'), png512.length, 'bytes');
  console.log('wrote', path.join(OUT_DIR, 'icon@2x.png'), png1024.length, 'bytes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
