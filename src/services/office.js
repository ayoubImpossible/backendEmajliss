'use strict';

/**
 * Conversion des documents bureautiques (Word, Excel, PowerPoint, OpenDocument)
 * en PDF avec LibreOffice, et rendu de la première page d'un PDF en image.
 *
 * Les binaires `soffice` et `gs` (Ghostscript) sont installés par le
 * Dockerfile. Absents (poste de développement Windows), les fonctions
 * renvoient null au lieu d'échouer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const WORK_DIR = path.join(os.tmpdir(), 'emajlis-office');
const CACHE_DIR = path.resolve(process.env.OFFICE_CACHE_DIR || path.join(__dirname, '../../thumbnails/pdf'));
fs.mkdirSync(WORK_DIR, { recursive: true });
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

const SOFFICE = process.env.SOFFICE_PATH || 'soffice';
const GS = process.env.GS_PATH || 'gs';

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(stdout);
    });
  });
}

// Une seule conversion LibreOffice à la fois : chaque instance prend
// plusieurs centaines de Mo de mémoire.
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

let sofficeAvailable = null;
async function hasSoffice() {
  if (sofficeAvailable !== null) return sofficeAvailable;
  try { await run(SOFFICE, ['--version'], 20000); sofficeAvailable = true; } catch (_) { sofficeAvailable = false; }
  if (!sofficeAvailable) console.warn('[office] LibreOffice (soffice) introuvable : conversion désactivée.');
  return sofficeAvailable;
}

/**
 * @param {Buffer} buffer contenu du document
 * @param {string} ext extension d'origine (docx, xlsx…)
 * @param {string} [cacheKey] clé stable (source:id:taille) pour réutiliser la conversion
 * @returns {Promise<string|null>} chemin du PDF produit
 */
async function convertToPdf(buffer, ext, cacheKey) {
  const keyHash = cacheKey ? crypto.createHash('sha1').update(cacheKey).digest('hex') : null;
  const cached = keyHash ? path.join(CACHE_DIR, `${keyHash}.pdf`) : null;
  if (cached && fs.existsSync(cached)) return cached;
  if (!(await hasSoffice())) return null;

  return serialize(async () => {
    if (cached && fs.existsSync(cached)) return cached;
    const job = crypto.randomBytes(8).toString('hex');
    const dir = path.join(WORK_DIR, job);
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, `input.${String(ext || 'docx').replace(/[^a-z0-9]/gi, '')}`);
    fs.writeFileSync(input, buffer);
    try {
      await run(SOFFICE, [
        `-env:UserInstallation=file://${path.join(WORK_DIR, 'profile').replace(/\\/g, '/')}`,
        '--headless', '--norestore', '--nolockcheck',
        '--convert-to', 'pdf', '--outdir', dir, input,
      ], 90000);
      const out = path.join(dir, 'input.pdf');
      if (!fs.existsSync(out)) return null;
      if (!cached) return out;
      fs.copyFileSync(out, cached);
      return cached;
    } catch (err) {
      console.warn(`[office] conversion ${ext} échouée : ${err.message}`);
      return null;
    } finally {
      if (cached) fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  });
}

/** Première page d'un PDF en JPEG via Ghostscript. */
async function pdfFirstPageJpeg(pdfPath, width = 600) {
  const out = path.join(WORK_DIR, `${crypto.randomBytes(8).toString('hex')}.jpg`);
  try {
    await run(GS, [
      '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dFirstPage=1', '-dLastPage=1',
      '-sDEVICE=jpeg', '-dJPEGQ=82', `-r${Math.round(72 * width / 595)}`,
      '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
      `-sOutputFile=${out}`, pdfPath,
    ], 30000);
    if (!fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    return buf.length > 1000 ? buf : null;
  } catch (err) {
    console.warn(`[office] rendu Ghostscript échoué : ${err.message}`);
    return null;
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

module.exports = { convertToPdf, pdfFirstPageJpeg, hasSoffice, WORK_DIR };
