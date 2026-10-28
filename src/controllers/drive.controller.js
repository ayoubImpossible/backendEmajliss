'use strict';

const { http, asUser } = require('../services/humhub');
const files = require('../services/files');

function rewriteDownloadPaths(payload) {
  const fix = (file) => {
    if (file && typeof file === 'object' && file.id != null) {
      file.api_download_url = `/api/drive/file/${file.id}/download`;
      const name = file.filename || file.file_name || '';
      file.thumbnail_url = `/api/thumbs/drive/${file.id}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
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

/** Relais d'un téléchargement HumHub vers l'application. */
async function relay(req, res, source) {
  try {
    const inline = !!req.query.inline;
    const upstream = await files.fetchUpstream(source, req.params.id, req.humhubToken, {
      inline, responseType: 'stream', range: req.headers.range,
    });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    const name = files.filenameFromDisposition(upstream.headers['content-disposition']) || 'document';
    res.setHeader('Content-Disposition', files.inlineDisposition(name, inline));
    upstream.data.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'Téléchargement interrompu.' });
      else res.destroy(err);
    });
    upstream.data.pipe(res);
  } catch (err) {
    const s = err.response?.status;
    if (s === 401) return res.status(401).json({ error: 'Session expirée.' });
    if (s === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    return res.status(404).json({ error: 'Fichier introuvable.' });
  }
}

exports.download = (req, res) => relay(req, res, 'drive');
exports.downloadCfile = (req, res) => relay(req, res, 'cfile');

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

