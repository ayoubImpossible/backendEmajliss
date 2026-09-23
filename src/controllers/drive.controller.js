'use strict';

const { http, asUser } = require('../services/humhub');

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

exports.folder = async (req, res, next) => {
  try {
    const { data } = await http.get(`/emajlis/drive/folder/${req.params.id}`, asUser(req.humhubToken));
    res.json(data);
  } catch (err) { next(err); }
};

exports.file = async (req, res, next) => {
  try {
    const { data } = await http.get(`/emajlis/drive/file/${req.params.id}`, asUser(req.humhubToken));
    res.json(rewriteDownloadPaths(data));
  } catch (err) { next(err); }
};

exports.settings = async (req, res, next) => {
  try {
    const { data } = await http.get(
      `/emajlis/drive/settings/container/${req.params.containerId}`,
      asUser(req.humhubToken),
    );
    res.json(data);
  } catch (err) { next(err); }
};

exports.download = async (req, res, next) => {
  try {
    const upstream = await http.get(`/emajlis/drive/file/${req.params.id}/download`, {
      ...asUser(req.humhubToken),
      params: req.query.inline ? { inline: 1 } : undefined,
      responseType: 'stream',
    });
    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    if (req.query.inline) {
      const fn = (upstream.headers['content-disposition'] || '')
        .match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '') || 'file';
      res.setHeader('Content-Disposition', `inline; filename="${fn}"`);
    }
    upstream.data.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'Téléchargement interrompu.' });
      else res.destroy(err);
    });
    upstream.data.pipe(res);
  } catch (err) {
    const s = err.response?.status;
    if (s === 404) return res.status(404).json({ error: 'Fichier introuvable.' });
    if (s === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    next(err);
  }
};

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
    if (err.response?.status === 403)
      return res.status(403).json({ error: "Vous n'avez pas le droit de créer un dossier ici." });
    next(err);
  }
};

exports.downloadCfile = async (req, res, next) => {
  const id = req.params.id;
  const inlineParam = req.query.inline ? { inline: 1 } : undefined;
  const attempts = [
    () => http.get(`/emajlis/drive/file/${id}/download`, { ...asUser(req.humhubToken), params: inlineParam, responseType: 'stream' }),
    () => http.get('/file/download', { ...asUser(req.humhubToken), params: { id, ...inlineParam }, responseType: 'stream' }),
    () => http.get(`/emajlis/cfiles/file/${id}/download`, { ...asUser(req.humhubToken), params: inlineParam, responseType: 'stream' }),
  ];
  let upstream = null, lastErr = null;
  for (const attempt of attempts) {
    try { upstream = await attempt(); break; }
    catch (e) { lastErr = e; if (e.response?.status === 401 || e.response?.status === 403) break; }
  }
  if (!upstream) {
    const s = lastErr?.response?.status;
    if (s === 401) return res.status(401).json({ error: 'Session expirée.' });
    if (s === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    return res.status(404).json({ error: 'Fichier introuvable.' });
  }
  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
  }
  if (req.query.inline) {
    const fn = (upstream.headers['content-disposition'] || '')
      .match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '') || 'file';
    res.setHeader('Content-Disposition', `inline; filename="${fn}"`);
  }
  upstream.data.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: 'Téléchargement interrompu.' });
    else res.destroy(err);
  });
  upstream.data.pipe(res);
};

// ── Thumbnail helpers ────────────────────────────────────────────────────────

/**
 * Start background generation for a file if not already cached/in-flight.
 * Never awaited — returns immediately so the HTTP response is instant.
 */
function _startBackgroundGeneration(id, token, cacheKey, filename, downloadPath) {
  const { generateThumbnail, thumbCache } = require('../services/thumbnail');
  if (thumbCache.get(cacheKey)) return; // already done
  // generateThumbnail handles in-flight dedup internally
  generateThumbnail(id, token, cacheKey, filename, downloadPath).catch(() => {});
}

// ── GET/HEAD /api/drive/file/:id/thumbnail ───────────────────────────────────
//
// BEHAVIOUR:
//   - Cache hit (real PDF render) → 200 image/jpeg
//   - Cache miss or not a PDF     → 204 (no content, no cover)
//
// HEAD requests are used by the app to probe without downloading the image.
exports.thumbnail = async (req, res, next) => {
  const { id } = req.params;
  const { thumbCache } = require('../services/thumbnail');
  const cacheKey = `thumb:drive:${id}`;

  // Fast path: already cached → return instantly (or HEAD with 200)
  const cached = thumbCache.get(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', cached.length);
    if (req.method === 'HEAD') return res.status(200).end();
    return res.send(cached);
  }

  // Not cached → 204 immediately, fire background generation
  res.setHeader('Cache-Control', 'no-store');
  res.status(204).end();

  // Background generation (after response sent)
  try {
    const { data } = await http.get(`/emajlis/drive/file/${id}`, {
      ...asUser(req.humhubToken), timeout: 8000,
    });
    const file = data?.file || data;
    if (!file) return;
    const filename = file.filename || file.file_name || '';
    const ext = filename.split('.').pop().toLowerCase();
    const supported = ['pdf','doc','docx','ppt','pptx','xls','xlsx','odt','odp','ods'];
    if (!supported.includes(ext)) return;
    _startBackgroundGeneration(id, req.humhubToken, cacheKey, filename);
  } catch (_) {}
};

// ── GET/HEAD /api/cfiles/file/:id/thumbnail ─────────────────────────────────
exports.thumbnailCfile = async (req, res, next) => {
  const { id } = req.params;
  const { thumbCache } = require('../services/thumbnail');
  const cacheKey = `thumb:cfile:${id}`;

  const cached = thumbCache.get(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', cached.length);
    if (req.method === 'HEAD') return res.status(200).end();
    return res.send(cached);
  }

  res.status(204).end();

  try {
    let filename = '';
    try {
      const meta = await http.get(`/cfiles/file/${id}`, { ...asUser(req.humhubToken), timeout: 8000 });
      const f = meta.data?.file || meta.data;
      filename = f?.file_name || f?.name || f?.title || '';
    } catch (_) {}
    const ext = (filename || '').split('.').pop().toLowerCase();
    const supported = ['pdf','doc','docx','ppt','pptx','xls','xlsx','odt','odp','ods'];
    if (filename && !supported.includes(ext)) return;
    _startBackgroundGeneration(id, req.humhubToken, cacheKey, filename, `/cfiles/file/${id}/download`);
  } catch (_) {}
};
