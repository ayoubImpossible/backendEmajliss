'use strict';

/**
 * Agenda — mise en forme héritée, conservée le temps que les écrans mobiles
 * migrent vers /api/feed?contentType=…CalendarEntry, qui rend l'objet HumHub
 * complet.
 *
 * Modification du 10/09/2026 : passe par le client unique services/humhub.js
 * (vérification TLS, chaîne complétée, suffixe « / » retiré). Le mappage n'a
 * pas été touché.
 */

const { http, asUser } = require('../services/humhub');

/** Convertit un événement HumHub vers la forme attendue par l'application. */
function mapEvent(e) {
  const start = e.start_datetime || e.start_date || '';
  const end   = e.end_datetime   || e.end_date   || '';
  return {
    id:          e.id,
    title_fr:    e.title || e.title_fr || '',
    title_ar:    e.title_ar || '',
    place:       e.location || e.place || '',
    type:        e.type || '',
    color:       e.color || '#6B1A2A',
    start_date:  start.split(' ')[0] || start.split('T')[0] || '',
    start_time:  start.split(' ')[1] || start.split('T')[1]?.substring(0, 5) || '',
    end_time:    end.split(' ')[1]   || end.split('T')[1]?.substring(0, 5)   || '',
    description: e.description || '',
  };
}

exports.list = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const params = { limit: 100 };
    if (year && month) {
      params.from = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      params.until = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else if (year) {
      params.from  = `${year}-01-01`;
      params.until = `${year}-12-31`;
    }

    const { data } = await http.get('/calendar/entry', {
      params,
      ...(req.humhubToken ? asUser(req.humhubToken) : {}),
      timeout: 10000,
    });

    const results = (data.results || data.data || []).map(mapEvent);
    results.sort((a, b) => b.start_date.localeCompare(a.start_date));
    res.json({ data: results });
  } catch (err) {
    if (err.response?.status === 404) return res.json({ data: [] });
    next(err);
  }
};

exports.show = async (req, res, next) => {
  try {
    const { data } = await http.get(`/calendar/entry/${req.params.id}`, {
      ...(req.humhubToken ? asUser(req.humhubToken) : {}),
      timeout: 8000,
    });
    res.json({ data: mapEvent(data) });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Événement introuvable' });
    next(err);
  }
};

exports.create  = (req, res) => res.status(501).json({ error: 'Non implémenté' });
exports.update  = (req, res) => res.status(501).json({ error: 'Non implémenté' });
exports.destroy = (req, res) => res.status(501).json({ error: 'Non implémenté' });

/**
 * RSVP — répondre à un événement.
 * POST /api/calendar/:id/respond  { state: 1|2|3 }
 *   1 = Accepté (présentiel ou teams selon le champ `mode`)
 *   2 = Décliné
 *   3 = Peut-être
 * Proxifie POST /calendar/entry/:id/respond vers HumHub.
 */
exports.respond = async (req, res, next) => {
  const { id } = req.params;
  const { state, mode } = req.body; // mode: 'presentiel' | 'teams' (info only, stored in comment)

  if (![1, 2, 3].includes(Number(state))) {
    return res.status(400).json({ error: 'state doit être 1 (accepté), 2 (décliné) ou 3 (peut-être).' });
  }

  try {
    const { data } = await http.post(
      `/calendar/entry/${id}/respond`,
      { state: Number(state) },
      { ...asUser(req.humhubToken), timeout: 10000 },
    );
    res.json({ success: true, state: Number(state), mode: mode || null, data });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Événement introuvable.' });
    if (err.response?.status === 403) return res.status(403).json({ error: 'Accès refusé.' });
    next(err);
  }
};
