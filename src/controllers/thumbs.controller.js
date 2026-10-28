'use strict';

/**
 * GET|HEAD /api/thumbs/:source/:id?name=fichier.pdf
 *   200 image/jpeg  miniature prête
 *   202             en cours de génération : réessayer dans quelques secondes
 *   403 / 404       fichier inaccessible pour cet utilisateur
 */

const thumbs = require('../services/thumbnail');

const WAIT_MS = 8000;

async function serve(req, res, source, id) {
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'Identifiant invalide.' });
  const token = req.humhubToken;

  if (!(await thumbs.canAccess(source, id, token))) {
    return res.status(403).json({ error: 'Accès refusé à ce fichier.' });
  }

  let buf = thumbs.cached(source, id);
  if (!buf) {
    const job = thumbs.generate(source, id, token, String(req.query.name || '').slice(0, 255));
    buf = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
  }

  if (!buf) {
    res.setHeader('Retry-After', '4');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(202).end();
  }

  res.setHeader('Content-Type', buf[0] === 0x89 ? 'image/png' : 'image/jpeg');
  res.setHeader('Content-Length', buf.length);
  // Privé : la miniature d'un fichier restreint ne doit pas être mise en cache par un intermédiaire.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.send(buf);
}

exports.thumb = (req, res, next) => {
  const source = req.params.source === 'cfile' ? 'cfile' : 'drive';
  serve(req, res, source, req.params.id).catch(next);
};

// Anciennes adresses, conservées pour les versions de l'application déjà installées.
exports.legacyDrive = (req, res, next) => serve(req, res, 'drive', req.params.id).catch(next);
exports.legacyCfile = (req, res, next) => serve(req, res, 'cfile', req.params.id).catch(next);
