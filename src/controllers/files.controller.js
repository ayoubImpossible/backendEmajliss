'use strict';

/**
 * Ouverture des fichiers dans l'application, au premier clic.
 *
 *   POST /api/files/ticket   { source: 'drive' | 'cfile', id }
 *        → vérifie l'accès auprès de HumHub, renvoie une URL de lecture
 *          valable 15 minutes, et le type de visionneuse à utiliser.
 *   GET  /api/files/view/:ticket          le fichier, en ligne
 *   GET  /api/files/view/:ticket?as=pdf   le document converti en PDF
 *
 * L'URL de lecture ne contient qu'un identifiant aléatoire : aucun jeton.
 */

const fs = require('fs');
const files = require('../services/files');
const tickets = require('../services/tickets');
const office = require('../services/office');

function publicBase(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

exports.createTicket = async (req, res, next) => {
  const source = req.body?.source === 'cfile' ? 'cfile' : 'drive';
  const id = String(req.body?.id ?? '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Identifiant de fichier invalide.' });

  try {
    let info = await files.fileInfo(source, id, req.humhubToken);
    if (!info && source === 'drive') return res.status(404).json({ error: 'Fichier introuvable ou accès refusé.' });
    // cfiles : l'API de métadonnées n'est pas toujours exposée ; le
    // téléchargement, lui, vérifie l'accès.
    info = info || { filename: String(req.body?.filename || ''), mimeType: String(req.body?.mimeType || ''), size: null };

    const kind = files.viewKind(info.filename, info.mimeType);
    const ticket = tickets.issue({
      humhubToken: req.humhubToken,
      userId: req.user?.id,
      source, id, ...info, kind,
    });
    const base = `${publicBase(req)}/api/files/view/${ticket}`;
    res.json({
      kind: kind === 'office' ? 'pdf' : kind,
      originalKind: kind,
      viewUrl: kind === 'office' ? `${base}?as=pdf` : base,
      downloadUrl: `${base}?download=1`,
      filename: info.filename,
      mimeType: info.mimeType,
      size: info.size,
      expiresIn: tickets.TTL_MS / 1000,
    });
  } catch (err) { next(err); }
};

exports.view = async (req, res) => {
  const t = tickets.read(req.params.ticket);
  if (!t) return res.status(410).json({ error: 'Lien expiré. Rouvrez le document.' });

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    // Document bureautique → PDF (conversion mise en cache sur disque).
    if (req.query.as === 'pdf' && t.kind === 'office') {
      const upstream = await files.fetchUpstream(t.source, t.id, t.humhubToken, { responseType: 'arraybuffer', timeout: 120000 });
      const buffer = Buffer.from(upstream.data);
      const ext = files.extOf(t.filename) || 'docx';
      const pdfPath = await office.convertToPdf(buffer, ext, `${t.source}:${t.id}:${buffer.length}`);
      if (!pdfPath) {
        return res.status(415).json({ error: 'Conversion indisponible pour ce document.', reason: 'conversion_unavailable' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', files.inlineDisposition(t.filename.replace(/\.[^.]+$/, '') + '.pdf'));
      return fs.createReadStream(pdfPath).pipe(res);
    }

    const upstream = await files.fetchUpstream(t.source, t.id, t.humhubToken, {
      responseType: 'stream',
      range: req.headers.range,
    });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    const name = t.filename || files.filenameFromDisposition(upstream.headers['content-disposition']) || 'document';
    res.setHeader('Content-Disposition', files.inlineDisposition(name, !req.query.download));
    upstream.data.on('error', (err) => { if (!res.headersSent) res.status(502).end(); else res.destroy(err); });
    return upstream.data.pipe(res);
  } catch (err) {
    const s = err.response?.status;
    if (s === 401) return res.status(401).json({ error: 'Session expirée.' });
    if (s === 403) return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
    if (s === 404) return res.status(404).json({ error: 'Fichier introuvable.' });
    console.warn(`[files] lecture ${t.source}:${t.id} échouée : ${err.message}`);
    return res.status(502).json({ error: 'Le fichier n’a pas pu être chargé.' });
  }
};
