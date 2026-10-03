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

// ── canvas — optional, only available when @napi-rs/canvas is installed ───────
let createCanvas = null;
try { createCanvas = require('@napi-rs/canvas').createCanvas; } catch (_) {
  try { createCanvas = require('canvas').createCanvas; } catch (_) {}
}

// ── Patch pdfjs NodeCanvasFactory to not crash with @napi-rs/canvas ───────────
// pdfjs calls canvas.width = 0 in destroy() which @napi-rs/canvas rejects.
// We monkey-patch it once at startup before any rendering.
try {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  if (pdfjsLib.NodeCanvasFactory && pdfjsLib.NodeCanvasFactory.prototype) {
    pdfjsLib.NodeCanvasFactory.prototype.destroy = function(canvasAndContext) {
      // Do NOT set width/height to 0 — @napi-rs/canvas crashes on this
      canvasAndContext.canvas  = null;
      canvasAndContext.context = null;
    };
    pdfjsLib.NodeCanvasFactory.prototype.reset = function(canvasAndContext, width, height) {
      // Safe reset
      if (canvasAndContext.canvas) {
        try {
          canvasAndContext.canvas.width  = width;
          canvasAndContext.canvas.height = height;
        } catch (_) {}
      }
    };
    console.log('[thumbnail] pdfjs NodeCanvasFactory patched for @napi-rs/canvas');
  }
} catch (_) {}

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

// ── PDF via pdf-to-img (uses pdfjs internally with proper canvas handling) ────
async function renderPdfLocal(pdfBuffer) {
  try {
    // pdf-to-img uses ESM top-level await — must use dynamic import(), not require()
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(pdfBuffer, { scale: 2 });
    // Get first page
    for await (const page of doc) {
      // page is a Buffer (PNG)
      if (page && page.length > 5000) {
        console.log(`[thumbnail/pdf-to-img] rendered ${page.length} bytes`);
        return page; // Return PNG directly — browser/RN handles it fine
      }
      break; // only first page
    }
    return null;
  } catch (err) {
    console.warn(`[thumbnail/pdf-to-img] ${err.message}`);
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
  return canvas.toBuffer('image/jpeg', { quality: 85 });
}

// ── Extract first embedded JPEG from PDF binary ───────────────────────────────
// PDFs store embedded images as raw JPEG streams between FF D8 ... FF D9 markers.
// This extracts the largest one (likely the cover page image).
function extractFirstJpegFromPdf(pdfBuffer) {
  try {
    const SOI = Buffer.from([0xFF, 0xD8]); // JPEG start
    const EOI = Buffer.from([0xFF, 0xD9]); // JPEG end
    let best = null;
    let pos = 0;
    while (pos < pdfBuffer.length - 4) {
      const start = pdfBuffer.indexOf(SOI, pos);
      if (start === -1) break;
      const end = pdfBuffer.indexOf(EOI, start + 2);
      if (end === -1) break;
      const jpeg = pdfBuffer.slice(start, end + 2);
      if (jpeg.length > 10000 && (!best || jpeg.length > best.length)) {
        best = jpeg;
      }
      pos = end + 2;
    }
    return best;
  } catch (_) { return null; }
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

  // Try pdfjs + canvas first
  const local = await renderPdfLocal(fileBuffer);
  if (local) {
    console.log(`[thumb:${fileId}] ✓ pdfjs render OK (${local.length} bytes)`);
    return local;
  }

  // pdfjs produced blank canvas (napi-rs/canvas missing features) — skip chromium
  // Instead use a simple approach: extract embedded JPEG from PDF if present
  const embedded = extractFirstJpegFromPdf(fileBuffer);
  if (embedded) {
    console.log(`[thumb:${fileId}] ✓ embedded JPEG extracted (${embedded.length} bytes)`);
    return embedded;
  }

  console.log(`[thumb:${fileId}] all render methods failed`);
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
