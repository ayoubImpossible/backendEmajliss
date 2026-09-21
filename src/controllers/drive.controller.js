'use strict';

/**
 * Drive Manager — relais fidèle vers /emajlis/drive/*.
 *
 * Comble BG-04. L'ancienne implémentation (/api/feed/drive/:cid) interrogeait
 * le module `cfiles`, qui est un module DIFFÉRENT :
 *     cfiles/files/container/37   ->  0 fichier
 *     emajlis/drive/container/37  ->  arborescence complète
 * Les 3 587 documents du Drive étaient donc invisibles depuis le mobile.
 *
 * Principe : on ne remodèle pas les réponses de HumHub. Elles portent déjà
 * `breadcrumb`, `permissions`, `human_size`, `api_download_url`. Toute
 * transformation ici serait une occasion de diverger.
 */

const { http, asUser } = require('../services/humhub');

/** Réécrit les chemins de téléchargement HumHub vers les routes Express. */
function rewriteDownloadPaths(payload) {
  const fix = (file) => {
    if (file && typeof file === 'object' && file.id != null) {
      file.api_download_url = `/api/drive/file/${file.id}/download`;
    }
    return file;
  };

  if (Array.isArray(payload?.files)) payload.files.forEach(fix);
  if (payload?.file) fix(payload.file);
  return payload;
}

// GET /api/drive/container/:containerId
exports.browse = async (req, res, next) => {
  const params = {};
  for (const key of ['folderId', 'q', 'sort', 'dir']) {
    if (req.query[key]) params[key] = req.query[key];
  }

  try {
    const { data } = await http.get(`/emajlis/drive/container/${req.params.containerId}`, {
      ...asUser(req.humhubToken), params,
    });
    res.json(rewriteDownloadPaths(data));
  } catch (err) { next(err); }
};

// GET /api/drive/folder/:id
exports.folder = async (req, res, next) => {
  try {
    const { data } = await http.get(`/emajlis/drive/folder/${req.params.id}`, asUser(req.humhubToken));
    res.json(data);
  } catch (err) { next(err); }
};

// GET /api/drive/file/:id
exports.file = async (req, res, next) => {
  try {
    const { data } = await http.get(`/emajlis/drive/file/${req.params.id}`, asUser(req.humhubToken));
    res.json(rewriteDownloadPaths(data));
  } catch (err) { next(err); }
};

// GET /api/drive/settings/container/:containerId
exports.settings = async (req, res, next) => {
  try {
    const { data } = await http.get(
      `/emajlis/drive/settings/container/${req.params.containerId}`,
      asUser(req.humhubToken),
    );
    res.json(data);
  } catch (err) { next(err); }
};

// GET /api/drive/file/:id/download
exports.download = async (req, res, next) => {
  try {
    const upstream = await http.get(`/emajlis/drive/file/${req.params.id}/download`, {
      ...asUser(req.humhubToken),
      params: req.query.inline ? { inline: 1 } : undefined,
      responseType: 'stream',
    });

    for (const header of ['content-type', 'content-length', 'content-disposition']) {
      const value = upstream.headers[header];
      if (value) res.setHeader(header, value);
    }

    // Si le client demande ?inline=1, on force Content-Disposition: inline
    // pour que la WebView affiche le fichier au lieu de le télécharger.
    if (req.query.inline) {
      const ct = upstream.headers['content-type'] || '';
      const filename = (upstream.headers['content-disposition'] || '').match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '') || `file`;
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }

    upstream.data.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'Téléchargement interrompu.' });
      else res.destroy(err);
    });

    upstream.data.pipe(res);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Fichier introuvable.' });
    if (status === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    next(err);
  }
};

// POST /api/drive/container/:containerId/folder
exports.createFolder = async (req, res, next) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Le paramètre "name" est requis.' });

  try {
    const { data } = await http.post(
      `/emajlis/drive/container/${req.params.containerId}/folder`,
      { name, parentId: req.body.parentId || null },
      asUser(req.humhubToken),
    );
    res.status(201).json(data);
  } catch (err) {
    if (err.response?.status === 403) {
      return res.status(403).json({ error: "Vous n'avez pas le droit de créer un dossier ici." });
    }
    next(err);
  }
};

/**
 * GET /api/cfiles/file/:id/download
 *
 * Proxy for cfiles module attachments.
 * HumHub's cfiles download URL is the absolute api_download_url from the file
 * object — typically https://host/index.php?r=file/file/download&id=:id
 * We proxy it with the user's token so the app never needs to handle auth.
 */
/**
 * GET /api/cfiles/file/:id/download
 *
 * Proxy for cfiles attachments. Tries multiple HumHub download endpoints
 * in order — stops at first success.
 */
exports.downloadCfile = async (req, res, next) => {
  const id = req.params.id;
  const inlineParam = req.query.inline ? { inline: 1 } : undefined;

  // Try every known HumHub file download pattern in order.
  const attempts = [
    () => http.get(`/emajlis/drive/file/${id}/download`, {
      ...asUser(req.humhubToken),
      params: inlineParam,
      responseType: 'stream',
    }),
    () => http.get(`/file/download`, {
      ...asUser(req.humhubToken),
      params: { id, ...inlineParam },
      responseType: 'stream',
    }),
    () => http.get(`/emajlis/cfiles/file/${id}/download`, {
      ...asUser(req.humhubToken),
      params: inlineParam,
      responseType: 'stream',
    }),
  ];

  let upstream = null;
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      upstream = await attempt();
      break;
    } catch (e) {
      console.warn(`[downloadCfile] fail -> ${e.response?.status} ${e.config?.url}`);
      lastErr = e;
      // Stop trying on auth errors — no point retrying with same token
      if (e.response?.status === 401 || e.response?.status === 403) break;
    }
  }

  if (!upstream) {
    const status = lastErr?.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Session expirée.' });
    if (status === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    return res.status(404).json({ error: 'Fichier introuvable.' });
  }

  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
  }
  if (req.query.inline) {
    const fname = (upstream.headers['content-disposition'] || '')
      .match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '') || 'file';
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
  }

  upstream.data.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: 'Téléchargement interrompu.' });
    else res.destroy(err);
  });
  upstream.data.pipe(res);
};

// GET /api/drive/file/:id/thumbnail
// Generates a real PNG capture of the first page using Chromium + Google Docs Viewer.
// Works on Vercel (via @sparticuz/chromium) and Railway/VPS.
exports.thumbnail = async (req, res, next) => {
  const { id } = req.params;
  const { BASE, httpsAgent } = require('../services/humhub');
  const axios = require('axios');
  const { generateThumbnail } = require('../services/thumbnail');

  try {
    // Step 1: Get the real download URL of the file from HumHub
    const { data } = await http.get(`/emajlis/drive/file/${id}`, {
      ...asUser(req.humhubToken),
      timeout: 8000,
    });

    const file = data?.file || data;
    if (!file) return res.status(404).json({ error: 'Fichier introuvable.' });

    const mimeType = file.mime_type || file.mimeType || '';
    const ext = (file.filename || file.file_name || '').split('.').pop().toLowerCase();

    // Only generate thumbnails for supported types
    const supported = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods'];
    if (!supported.includes(ext)) {
      return res.status(415).json({ error: 'Type non supporté pour la prévisualisation.' });
    }

    // Step 2: Build the authenticated download URL
    // We need to construct an absolute URL that Google Docs Viewer can access.
    // Since our files are behind auth, we proxy through our own endpoint with a token.
    const downloadUrl = `${BASE}/api/v1/emajlis/drive/file/${id}/download`;
    const cacheKey = `thumb:drive:${id}`;

    // Step 3: Generate thumbnail
    const png = await generateThumbnail(downloadUrl, cacheKey);

    if (!png) {
      // Fallback: return 204 so app shows placeholder
      return res.status(204).end();
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(png);

  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Fichier introuvable.' });
    if (status === 403) return res.status(403).json({ error: 'Accès refusé.' });
    next(err);
  }
};
