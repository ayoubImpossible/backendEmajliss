'use strict';

/**
 * Accès aux fichiers HumHub (Drive Manager et cfiles) — point unique.
 *
 * Toujours avec le jeton de l'utilisateur : c'est HumHub qui décide si le
 * fichier lui est accessible.
 */

const path = require('path');
const { http, asUser } = require('./humhub');

const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const TEXT_EXT = new Set(['txt', 'md', 'json', 'xml', 'log']);

function extOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

/**
 * Comment afficher un fichier dans l'application.
 *  - pdf    : visionneuse PDF intégrée
 *  - office : converti en PDF par le serveur, puis visionneuse PDF
 *  - image  : visionneuse d'image
 *  - text   : texte brut
 *  - other  : téléchargement puis application du téléphone
 */
function viewKind(filename, mime = '') {
  const ext = extOf(filename);
  if (ext === 'pdf' || /pdf/i.test(mime)) return 'pdf';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (IMAGE_EXT.has(ext) || /^image\//i.test(mime)) return 'image';
  if (TEXT_EXT.has(ext) || /^text\//i.test(mime)) return 'text';
  return 'other';
}

/** Chemins de téléchargement à essayer, dans l'ordre, selon la source. */
function downloadPaths(source, id) {
  const sid = encodeURIComponent(String(id));
  if (source === 'cfile') {
    // Pièces jointes et module Fichiers : route REST du cœur HumHub, l'identifiant
    // est celui de l'enregistrement File (vérifié : /file/download?id= et
    // /emajlis/cfiles/… n'existent pas sur ce serveur).
    return [`/file/download/${sid}`];
  }
  return [`/emajlis/drive/file/${sid}/download`];
}

/**
 * Ouvre le flux (ou le tampon) du fichier chez HumHub.
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function fetchUpstream(source, id, token, { inline = true, responseType = 'stream', range, timeout = 60000 } = {}) {
  let lastErr = null;
  for (const p of downloadPaths(source, id)) {
    try {
      const sep = p.includes('?') ? '&' : '?';
      const res = await http.get(inline ? `${p}${sep}inline=1` : p, {
        ...asUser(token),
        headers: { ...asUser(token).headers, ...(range ? { Range: range } : {}) },
        responseType,
        timeout,
        maxContentLength: 200 * 1024 * 1024,
        validateStatus: (s) => s === 200 || s === 206,
      });
      // Une page HTML ou une erreur JSON n'est pas le fichier demandé.
      const ct = String(res.headers['content-type'] || '');
      if (/^(text\/html|application\/json)/i.test(ct) && !/\.(html?|json)\b/i.test(String(res.headers['content-disposition'] || ''))) {
        if (res.data?.destroy) res.data.destroy();
        const e = new Error(`réponse ${ct} au lieu du fichier`);
        e.response = { status: 404 };
        throw e;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const s = err.response?.status;
      if (s === 401 || s === 403) break; // refus : inutile d'essayer ailleurs
    }
  }
  throw lastErr || new Error('Fichier introuvable');
}

/** Métadonnées du fichier (et vérification d'accès). Renvoie null si inaccessible. */
async function fileInfo(source, id, token) {
  try {
    if (source === 'cfile') {
      // Pas d'API de métadonnées par identifiant de File : on lit l'en-tête du
      // téléchargement (1 octet), qui prouve aussi l'accès.
      const r = await fetchUpstream('cfile', id, token, { responseType: 'stream', range: 'bytes=0-0', timeout: 15000 });
      r.data.destroy();
      const total = String(r.headers['content-range'] || '').split('/')[1];
      return {
        filename: filenameFromDisposition(r.headers['content-disposition']),
        mimeType: String(r.headers['content-type'] || '').split(';')[0],
        size: Number(total || r.headers['content-length']) || null,
      };
    }
    const { data } = await http.get(`/emajlis/drive/file/${encodeURIComponent(id)}`, { ...asUser(token), timeout: 8000 });
    const f = data?.file || data || {};
    return {
      filename: f.filename || f.file_name || f.title || '',
      mimeType: f.mime_type || '',
      size: Number(f.size) || null,
    };
  } catch (err) {
    const s = err.response?.status;
    if (s === 401 || s === 403 || s === 404) return null;
    throw err;
  }
}

/** Nom de fichier issu de l'en-tête Content-Disposition (RFC 5987 compris). */
function filenameFromDisposition(header) {
  const h = String(header || '');
  const star = h.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch (_) {} }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

/** En-tête Content-Disposition sûr (pas de guillemets ni de retours à la ligne injectés). */
function inlineDisposition(name, inline = true) {
  const safe = String(name || 'document').replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

module.exports = { viewKind, extOf, fetchUpstream, fileInfo, filenameFromDisposition, inlineDisposition, OFFICE_EXT, IMAGE_EXT };
