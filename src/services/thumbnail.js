'use strict';

/**
 * Miniatures de documents — tous les types de fichiers.
 *
 *  - PDF                     : vraie première page (Ghostscript, sinon pdf-to-img)
 *  - Word / Excel / PowerPoint / OpenDocument : conversion LibreOffice en PDF,
 *                              puis première page
 *  - Images                  : l'image elle-même, réduite
 *  - Autres (zip, audio…)    : couverture stylée (couleur du type, extension, nom)
 *
 * Toute miniature est servie après vérification de l'accès de l'utilisateur
 * auprès de HumHub : le cache est partagé, l'autorisation ne l'est pas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { TtlCache } = require('./cache');
const files = require('./files');
const office = require('./office');

let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch (_) {}

const VERSION = 'v5';
const MAX_DOWNLOAD = 60 * 1024 * 1024;
const thumbCache = new TtlCache(6 * 60 * 60 * 1000, 800);
const accessCache = new TtlCache(10 * 60 * 1000, 20000);
const inflight = new Map();

// ── Disque ────────────────────────────────────────────────────────────────────
const DISK_DIR = path.resolve(process.env.THUMB_CACHE_DIR || path.join(__dirname, '../../thumbnails'));
let diskEnabled = false;
try { fs.mkdirSync(DISK_DIR, { recursive: true }); diskEnabled = true; } catch (_) {}

const keyOf = (source, id) => `${VERSION}_${source}_${String(id).replace(/[^0-9a-z]/gi, '')}`;
const diskPath = (key) => path.join(DISK_DIR, `${key}.jpg`);

function readDisk(key) {
  if (!diskEnabled) return null;
  try {
    const buf = fs.readFileSync(diskPath(key));
    if (buf.length > 500) { thumbCache.set(key, buf); return buf; }
  } catch (_) {}
  return null;
}
function writeDisk(key, buf) {
  if (diskEnabled) fs.writeFile(diskPath(key), buf, () => {});
}

// ── Accès ─────────────────────────────────────────────────────────────────────
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);
}

/** L'utilisateur peut-il lire ce fichier ? Une requête « 1 octet » chez HumHub, mise en cache 10 min. */
async function canAccess(source, id, token) {
  const k = `${tokenKey(token)}:${source}:${id}`;
  const hit = accessCache.get(k);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const r = await files.fetchUpstream(source, id, token, { responseType: 'stream', range: 'bytes=0-0', timeout: 10000 });
    r.data.destroy();
    ok = true;
  } catch (err) {
    const s = err.response?.status;
    if (s && s !== 401 && s !== 403 && s !== 404) {
      // Panne passagère : ne pas mémoriser un refus.
      return false;
    }
  }
  accessCache.set(k, ok);
  return ok;
}

// ── Rendus ────────────────────────────────────────────────────────────────────
const EXT_COLOR = {
  pdf: '#C62828', doc: '#1565C0', docx: '#1565C0', rtf: '#1565C0', odt: '#4527A0',
  xls: '#2E7D32', xlsx: '#2E7D32', csv: '#2E7D32', ods: '#558B2F',
  ppt: '#E65100', pptx: '#E65100', odp: '#00695C',
  zip: '#6D4C41', rar: '#6D4C41', mp3: '#AD1457', mp4: '#6A1B9A', mov: '#6A1B9A',
};

function renderCover(ext, filename) {
  if (!canvasLib) return null;
  const W = 600, H = 400;
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const bg = EXT_COLOR[ext] || '#37474F';
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#1a1a2e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  [0.78, 0.55, 0.85, 0.42, 0.7, 0.63].forEach((w, i) => ctx.fillRect(32, 40 + i * 30, (W - 64) * w, 10));
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, H - 80, W, 80);
  const label = (ext || 'FICHIER').toUpperCase().slice(0, 6);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(label, 28, H - 32);
  if (filename) {
    const base = path.basename(filename);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(base.length > 44 ? `${base.slice(0, 42)}…` : base, 28 + label.length * 22 + 18, H - 34);
  }
  return canvas.toBuffer('image/jpeg', 85);
}

async function resizeImage(buffer, width = 600) {
  if (!canvasLib) return buffer.length < 1.5 * 1024 * 1024 ? buffer : null;
  try {
    const img = await canvasLib.loadImage(buffer);
    const scale = Math.min(1, width / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = canvasLib.createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toBuffer('image/jpeg', 82);
  } catch (err) {
    console.warn(`[thumb] image illisible : ${err.message}`);
    return null;
  }
}

async function renderPdfBuffer(pdfBuffer) {
  // 1. Ghostscript : gère les PDF arabes et les polices complexes.
  const tmp = path.join(office.WORK_DIR, `${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tmp, pdfBuffer);
    const gs = await office.pdfFirstPageJpeg(tmp);
    if (gs) return gs;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
  // 2. pdf-to-img (pdf.js) si Ghostscript est absent.
  try {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(pdfBuffer, { scale: 1 });
    for await (const page of doc) {
      if (page && page.length > 3000) return (await resizeImage(page)) || page;
      break;
    }
  } catch (err) {
    console.warn(`[thumb] pdf-to-img : ${err.message}`);
  }
  return null;
}

async function download(source, id, token) {
  const r = await files.fetchUpstream(source, id, token, { responseType: 'arraybuffer', timeout: 90000 });
  const buf = Buffer.from(r.data);
  if (buf.length > MAX_DOWNLOAD) throw new Error('fichier trop volumineux pour une miniature');
  return { buf, disposition: r.headers['content-disposition'], contentType: r.headers['content-type'] || '' };
}

async function produce(source, id, token, filenameHint) {
  let filename = filenameHint || '';
  let kind = files.viewKind(filename);

  // Nom inconnu : on le lit dans les métadonnées.
  if (!filename) {
    const info = await files.fileInfo(source, id, token).catch(() => null);
    filename = info?.filename || '';
    kind = files.viewKind(filename, info?.mimeType);
  }
  const ext = files.extOf(filename);

  if (kind === 'other') return renderCover(ext, filename);

  try {
    const { buf, disposition, contentType } = await download(source, id, token);
    if (!filename) {
      filename = files.filenameFromDisposition(disposition);
      kind = files.viewKind(filename, contentType);
    }
    let out = null;
    if (kind === 'pdf') out = await renderPdfBuffer(buf);
    else if (kind === 'image') out = await resizeImage(buf);
    else if (kind === 'office') {
      const pdfPath = await office.convertToPdf(buf, files.extOf(filename) || ext, `${source}:${id}:${buf.length}`);
      if (pdfPath) out = await office.pdfFirstPageJpeg(pdfPath);
    }
    return out || renderCover(files.extOf(filename) || ext, filename);
  } catch (err) {
    const s = err.response?.status;
    if (s === 401 || s === 403 || s === 404) throw err;
    console.warn(`[thumb] ${source}:${id} : ${err.message}`);
    return renderCover(ext, filename);
  }
}

// Deux générations à la fois (LibreOffice est déjà sérialisé à part).
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < 2) start(); else queue.push(start);
  });
}

/** Miniature en cache (mémoire ou disque), sans rien générer. */
function cached(source, id) {
  const key = keyOf(source, id);
  return thumbCache.get(key) || readDisk(key);
}

/** Génère (ou rejoint la génération en cours) ; renvoie le JPEG ou null. */
function generate(source, id, token, filenameHint) {
  const key = keyOf(source, id);
  const hit = cached(source, id);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);

  const p = limited(() => produce(source, id, token, filenameHint))
    .then((buf) => {
      if (buf) { thumbCache.set(key, buf); writeDisk(key, buf); }
      return buf || null;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = { generate, cached, canAccess, thumbCache, VERSION };
