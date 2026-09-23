'use strict';

/**
 * Universal Document Thumbnail Service
 *
 * Strategy (after full analysis):
 *  - PDF  → pdfjs-dist renders real first page (fast, pure JS, no browser)
 *  - DOCX/PPTX/XLSX/ODT → canvas styled cover (instant, no Chrome, no hangs)
 *  - Fallback → same canvas styled cover
 *
 * WHY we dropped Puppeteer for Office files:
 *  page.screenshot() hangs on large DOCX files, blocking the shared browser
 *  instance and cascading timeouts to ALL subsequent Office renders.
 *  The Puppeteer HTML cover and the canvas cover are visually identical —
 *  both show colored gradient + text lines + ext badge + filename.
 *  Canvas never hangs. Puppeteer is only kept for PDF fallback if pdfjs fails.
 *
 * KEY: _inflight map — prewarm and app request share one promise per file.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { TtlCache }     = require('./cache');
const { http, asUser } = require('./humhub');
const { createCanvas } = require('canvas');

// ── Cache ─────────────────────────────────────────────────────────────────────
const thumbCache = new TtlCache(60 * 60 * 1000, 500); // 1 h, max 500 entries

// ── Disk persistence — survive server restarts ────────────────────────────────
const DISK_DIR = path.join(__dirname, '../../thumbnails');
if (!fs.existsSync(DISK_DIR)) fs.mkdirSync(DISK_DIR, { recursive: true });

function diskPath(cacheKey) {
  return path.join(DISK_DIR, cacheKey.replace(/[^a-z0-9_:-]/gi, '_') + '.jpg');
}

function loadFromDisk(cacheKey) {
  try {
    const p = diskPath(cacheKey);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if (buf.length < 1000) return null;
    thumbCache.set(cacheKey, buf);
    return buf;
  } catch (_) { return null; }
}

function saveToDisk(cacheKey, jpeg) {
  try { fs.writeFileSync(diskPath(cacheKey), jpeg); } catch (_) {}
}

// ── In-flight deduplication ───────────────────────────────────────────────────
// prewarm() fires generation before app requests. When app requests the same
// thumbnail, it joins the existing promise instead of starting a new race.
const _inflight = new Map(); // cacheKey → Promise<Buffer>

// ── PDF renderer (pdfjs + node-canvas) ───────────────────────────────────────
async function renderPdf(pdfBuffer) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);

    const doc = await Promise.race([
      pdfjsLib.getDocument({ data, stopAtErrors: false }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('pdfjs timeout')), 12000)),
    ]);

    if (!doc || doc.numPages < 1) return null;

    const page     = await doc.getPage(1);
    const scale    = 800 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas   = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx      = canvas.getContext('2d');

    await Promise.race([
      page.render({ canvasContext: ctx, viewport }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout')), 10000)),
    ]);

    const jpeg = canvas.toBuffer('image/jpeg', { quality: 0.82 });
    return jpeg.length > 5000 ? jpeg : null;
  } catch (err) {
    console.warn(`[thumbnail/pdf] ${err.message}`);
    return null;
  }
}

// ── Styled cover (canvas — instant, never hangs) ──────────────────────────────
// Used for ALL Office files and as PDF fallback.
// Visually: colored gradient background + decorative text lines + ext badge + filename
const EXT_COLOR = {
  pdf:  '#C62828',
  docx: '#1565C0', doc:  '#1565C0',
  xlsx: '#2E7D32', xls:  '#2E7D32',
  pptx: '#E65100', ppt:  '#E65100',
  odt:  '#4527A0', odp:  '#00695C', ods: '#558B2F',
};

function renderCover(ext, filename) {
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const bg     = EXT_COLOR[(ext || '').toLowerCase()] || '#37474F';

  // Gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#1a1a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Decorative text line strips
  const lineWidths = [0.78, 0.55, 0.85, 0.42, 0.70, 0.63, 0.80, 0.50, 0.75, 0.45];
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  lineWidths.forEach((w, i) => {
    ctx.beginPath();
    ctx.roundRect(32, 40 + i * 30, W * w, 11, 3);
    ctx.fill();
  });

  // Bottom bar
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  ctx.fillRect(0, H - 72, W, 72);

  // Extension badge
  const extLabel = (ext || '?').toUpperCase().slice(0, 5);
  const badgeW = Math.max(60, extLabel.length * 12 + 24);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.roundRect(24, H - 56, badgeW, 34, 8);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(extLabel, 24 + badgeW / 2, H - 39);

  // Filename
  if (filename) {
    const base = path.basename(filename);
    const name = base.length > 50 ? base.slice(0, 48) + '…' : base;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(name, 24 + badgeW + 14, H - 39);
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.85 });
}

// ── Core generator ────────────────────────────────────────────────────────────
const SUPPORTED = new Set(['pdf','doc','docx','ppt','pptx','xls','xlsx','odt','odp','ods']);

async function _doGenerate(fileId, token, ext, filename, downloadPath) {
  // Download the file
  let fileBuffer = null;

  const endpoints = downloadPath && downloadPath.includes('/cfiles/')
    ? [
        `/emajlis/drive/file/${fileId}/download`,
        `/file/download?id=${fileId}`,
        `/emajlis/cfiles/file/${fileId}/download`,
      ]
    : [downloadPath || `/emajlis/drive/file/${fileId}/download`];

  for (const ep of endpoints) {
    try {
      const r = await http.get(ep, {
        ...asUser(token),
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      fileBuffer = Buffer.from(r.data);
      console.log(`[thumb:${fileId}] downloaded ${fileBuffer.length} bytes from ${ep}`);
      break;
    } catch (e) {
      console.warn(`[thumb:${fileId}] download failed (${ep}): ${e.message}`);
      if (e.response?.status === 401 || e.response?.status === 403) break;
    }
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    // Download failed — return null so caller doesn't cache, allows retry
    return null;
  }

  // PDF → real first-page render via pdfjs
  if (ext === 'pdf') {
    const jpeg = await renderPdf(fileBuffer);
    if (jpeg) {
      console.log(`[thumb:${fileId}] PDF rendered (${jpeg.length} bytes)`);
      return jpeg;
    }
    // pdfjs failed — return canvas cover as fallback (still useful visual)
    console.warn(`[thumb:${fileId}] pdfjs failed — using canvas cover fallback`);
    return renderCover(ext, filename);
  }

  // Office files (DOCX/PPTX/XLSX) — return null → API returns 204 → app hides cover space
  console.log(`[thumb:${fileId}] Office file — no capture, returning null`);
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a JPEG thumbnail for fileId.
 *
 * Cache hit → instant.
 * In-flight → joins existing promise (prewarm + app share one generation).
 * New → starts generation, registers in _inflight so others can join.
 * Download failure → returns null (not cached, app retries via AuthedImage).
 */
async function generateThumbnail(fileId, token, cacheKey, filename, downloadPath) {
  // 1. Memory cache hit
  const hit = thumbCache.get(cacheKey);
  if (hit) return hit;

  // 1b. Disk cache hit (survives restarts)
  const diskHit = loadFromDisk(cacheKey);
  if (diskHit) return diskHit;

  // 2. In-flight — JOIN the existing promise
  if (_inflight.has(cacheKey)) {
    console.log(`[thumb:${fileId}] joining in-flight`);
    return _inflight.get(cacheKey);
  }

  filename  = filename || String(fileId);
  const ext = filename.split('.').pop().toLowerCase();

  // 3. Start new generation
  const promise = Promise.race([
    _doGenerate(fileId, token, ext, filename, downloadPath),
    new Promise(resolve => setTimeout(() => {
      console.warn(`[thumb:${fileId}] 45s timeout`);
      resolve(null);
    }, 45000)),
  ]).then(result => {
    _inflight.delete(cacheKey);
    if (!result) {
      // Download failed or timed out — do NOT cache so app can retry
      console.warn(`[thumb:${fileId}] ✗ failed — not caching`);
      return null; // caller returns 503, app retries
    }
    thumbCache.set(cacheKey, result);
    saveToDisk(cacheKey, result);
    console.log(`[thumb:${fileId}] ✓ cached ${result.length} bytes (${filename})`);
    return result;
  }).catch(err => {
    _inflight.delete(cacheKey);
    console.warn(`[thumb:${fileId}] unexpected error: ${err.message}`);
    return null;
  });

  _inflight.set(cacheKey, promise);
  return promise;
}

module.exports = { generateThumbnail, thumbCache };
