'use strict';

/**
 * Universal Document Thumbnail Service
 *
 * Rendering strategy:
 *  - PDF  → pdfjs-dist + node-canvas (local) OR @sparticuz/chromium (Vercel)
 *  - DOCX/PPTX/XLSX/ODT → canvas styled cover (local only)
 *  - On Vercel: only PDFs via chromium headless screenshot
 *
 * On Vercel: canvas native binaries are unavailable.
 * We use @sparticuz/chromium + puppeteer-core to render PDF first page.
 */

const fs   = require('fs');
const path = require('path');

const { TtlCache }     = require('./cache');
const { http, asUser } = require('./humhub');

// ── canvas — optional, only available on local server ────────────────────────
let createCanvas = null;
try { createCanvas = require('canvas').createCanvas; } catch (_) {}

// ── Cache ─────────────────────────────────────────────────────────────────────
const thumbCache = new TtlCache(60 * 60 * 1000, 500); // 1 h, max 500 entries

// ── Disk persistence — local only ─────────────────────────────────────────────
const DISK_DIR = path.join(__dirname, '../../thumbnails');
let diskEnabled = false;
try {
  if (!fs.existsSync(DISK_DIR)) fs.mkdirSync(DISK_DIR, { recursive: true });
  diskEnabled = true;
} catch (_) {}

function diskPath(key) {
  return path.join(DISK_DIR, 'v3_' + key.replace(/[^a-z0-9_:-]/gi, '_') + '.jpg');
}
function loadFromDisk(key) {
  if (!diskEnabled) return null;
  try {
    const p = diskPath(key);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if (buf.length < 1000) return null;
    thumbCache.set(key, buf);
    return buf;
  } catch (_) { return null; }
}
function saveToDisk(key, jpeg) {
  if (!diskEnabled) return;
  try { fs.writeFileSync(diskPath(key), jpeg); } catch (_) {}
}

// ── In-flight deduplication ───────────────────────────────────────────────────
const _inflight = new Map();

// ── PDF via pdfjs + node-canvas (local server) ────────────────────────────────
async function renderPdfLocal(pdfBuffer) {
  if (!createCanvas) return null;
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

    // NodeCanvasFactory required for pdfjs to work with node-canvas
    const NodeCanvasFactory = {
      create(width, height) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
      },
      reset(canvasAndCtx, width, height) {
        canvasAndCtx.canvas.width  = width;
        canvasAndCtx.canvas.height = height;
      },
      destroy(canvasAndCtx) {
        canvasAndCtx.canvas.width  = 0;
        canvasAndCtx.canvas.height = 0;
      },
    };

    const data = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
    const doc = await Promise.race([
      pdfjsLib.getDocument({
        data,
        stopAtErrors: false,
        CanvasFactory: NodeCanvasFactory,
      }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('pdfjs timeout')), 12000)),
    ]);
    if (!doc || doc.numPages < 1) return null;
    const page     = await doc.getPage(1);
    const scale    = 800 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas   = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx      = canvas.getContext('2d');
    await Promise.race([
      page.render({
        canvasContext: ctx,
        viewport,
        canvasFactory: NodeCanvasFactory,
      }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout')), 10000)),
    ]);
    const jpeg = canvas.toBuffer('image/jpeg', { quality: 0.82 });
    console.log(`[thumbnail/pdfjs] rendered ${jpeg.length} bytes`);
    return jpeg.length > 5000 ? jpeg : null;
  } catch (err) {
    console.warn(`[thumbnail/pdfjs] ${err.message}`);
    return null;
  }
}

// ── PDF via @sparticuz/chromium + puppeteer-core (Vercel) ────────────────────
async function renderPdfChromium(pdfBuffer) {
  let browser = null;
  try {
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    // Build a data URL for the PDF
    const base64 = pdfBuffer.toString('base64');
    const dataUrl = `data:application/pdf;base64,${base64}`;

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 800, height: 600 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(dataUrl, { waitUntil: 'networkidle0', timeout: 20000 });

    // Wait for PDF to render
    await new Promise(r => setTimeout(r, 1500));

    const jpeg = await page.screenshot({ type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: 800, height: 600 } });
    await browser.close();
    browser = null;

    return jpeg?.length > 5000 ? jpeg : null;
  } catch (err) {
    console.warn(`[thumbnail/chromium] ${err.message}`);
    if (browser) { try { await browser.close(); } catch (_) {} }
    return null;
  }
}

// ── Styled cover (canvas — local only) ────────────────────────────────────────
const EXT_COLOR = {
  pdf:  '#C62828',
  docx: '#1565C0', doc:  '#1565C0',
  xlsx: '#2E7D32', xls:  '#2E7D32',
  pptx: '#E65100', ppt:  '#E65100',
  odt:  '#4527A0', odp:  '#00695C', ods: '#558B2F',
};

function renderCover(ext, filename) {
  if (!createCanvas) return null;
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const bg     = EXT_COLOR[(ext || '').toLowerCase()] || '#37474F';
  const grad   = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#1a1a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const lineWidths = [0.78, 0.55, 0.85, 0.42, 0.70, 0.63, 0.80, 0.50, 0.75, 0.45];
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  lineWidths.forEach((w, i) => {
    ctx.beginPath();
    ctx.roundRect(32, 40 + i * 30, W * w, 11, 3);
    ctx.fill();
  });
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  ctx.fillRect(0, H - 72, W, 72);
  const extLabel = (ext || '?').toUpperCase().slice(0, 5);
  const badgeW   = Math.max(60, extLabel.length * 12 + 24);
  ctx.fillStyle  = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.roundRect(24, H - 56, badgeW, 34, 8);
  ctx.fill();
  ctx.fillStyle    = '#FFFFFF';
  ctx.font         = 'bold 14px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(extLabel, 24 + badgeW / 2, H - 39);
  if (filename) {
    const base = path.basename(filename);
    const name = base.length > 50 ? base.slice(0, 48) + '…' : base;
    ctx.font      = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(name, 24 + badgeW + 14, H - 39);
  }
  return canvas.toBuffer('image/jpeg', { quality: 0.85 });
}

// ── Core generator ─────────────────────────────────────────────────────────────
async function _doGenerate(fileId, token, ext, filename, downloadPath) {
  // Download the file
  let fileBuffer = null;
  const endpoints = downloadPath && downloadPath.includes('/cfiles/')
    ? [`/emajlis/drive/file/${fileId}/download`, `/file/download?id=${fileId}`, `/emajlis/cfiles/file/${fileId}/download`]
    : [downloadPath || `/emajlis/drive/file/${fileId}/download`];

  for (const ep of endpoints) {
    try {
      const r = await http.get(ep, { ...asUser(token), responseType: 'arraybuffer', timeout: 30000 });
      fileBuffer = Buffer.from(r.data);
      console.log(`[thumb:${fileId}] downloaded ${fileBuffer.length} bytes from ${ep}`);
      break;
    } catch (e) {
      console.warn(`[thumb:${fileId}] download failed (${ep}): ${e.message}`);
      if (e.response?.status === 401 || e.response?.status === 403) break;
    }
  }

  if (!fileBuffer || fileBuffer.length === 0) return null;

  // Only generate real thumbnails for PDFs via pdfjs or chromium.
  // No colored fake covers for any file type.
  if (ext !== 'pdf') return null;

  const local = await renderPdfLocal(fileBuffer);
  if (local) {
    console.log(`[thumb:${fileId}] PDF rendered via pdfjs (${local.length} bytes)`);
    return local;
  }

  const chromium = await renderPdfChromium(fileBuffer);
  if (chromium) {
    console.log(`[thumb:${fileId}] PDF rendered via chromium (${chromium.length} bytes)`);
    return chromium;
  }

  console.log(`[thumb:${fileId}] PDF render failed — no thumbnail`);
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────────
async function generateThumbnail(fileId, token, cacheKey, filename, downloadPath) {
  const hit = thumbCache.get(cacheKey);
  if (hit) return hit;

  const diskHit = loadFromDisk(cacheKey);
  if (diskHit) return diskHit;

  if (_inflight.has(cacheKey)) {
    console.log(`[thumb:${fileId}] joining in-flight`);
    return _inflight.get(cacheKey);
  }

  filename  = filename || String(fileId);
  const ext = filename.split('.').pop().toLowerCase();

  const promise = Promise.race([
    _doGenerate(fileId, token, ext, filename, downloadPath),
    new Promise(resolve => setTimeout(() => { console.warn(`[thumb:${fileId}] 50s timeout`); resolve(null); }, 50000)),
  ]).then(result => {
    _inflight.delete(cacheKey);
    if (!result) { console.warn(`[thumb:${fileId}] ✗ failed — not caching`); return null; }
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
