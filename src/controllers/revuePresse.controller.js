'use strict';

const revue = require('../services/revuePresse');

const toPage = (v) => Math.max(parseInt(v, 10) || 1, 1);
const toLimit = (v) => Math.min(Math.max(parseInt(v, 10) || 20, 1), 50);

function fail(err, res, next) {
  const s = err.response?.status;
  if (s === 401) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
  if (s === 403) {
    return res.status(403).json({
      error: "Les revues de presse sont réservées aux membres de l'espace « REVUES DE PRESSE ».",
      reason: 'not_member',
    });
  }
  if (s === 404) return res.status(404).json({ error: 'Revue de presse introuvable.' });
  if (!err.response) return res.status(502).json({ error: 'Serveur E-Majlis injoignable.' });
  return next(err);
}

// GET /api/revue-presse?page=&limit=
exports.list = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await revue.list(req.humhubToken, { page: toPage(req.query.page), limit: toLimit(req.query.limit) }));
  } catch (err) { fail(err, res, next); }
};

// GET /api/revue-presse/:id — HTML complet
exports.show = async (req, res, next) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'Identifiant invalide.' });
  try {
    const r = await revue.get(req.humhubToken, req.params.id);
    if (!r.html) console.warn(`[revue-presse] ${req.params.id} : aucun HTML dans la réponse HumHub.`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(r);
  } catch (err) { fail(err, res, next); }
};
