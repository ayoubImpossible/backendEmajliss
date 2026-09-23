'use strict';

const { http, asUser } = require('../services/humhub');
const { TtlCache } = require('../services/cache');

// Cache likes status 5 minutes per (model, pk, userId).
// Eliminates the flood of /api/likes/status requests when a feed loads:
// 20 ContentCards mounting simultaneously = 20 identical HumHub calls
// reduced to 1 fetch + 19 cache hits after the first card loads.
const likesCache = new TtlCache(5 * 60 * 1000, 5000);  // 5 minutes TTL

// ── Commentaires ──────────────────────────────────────────────────────────────

// GET /api/comments/content/:contentId
exports.listComments = async (req, res, next) => {
  try {
    const { data } = await http.get(`/comment/content/${req.params.contentId}`, {
      ...asUser(req.humhubToken),
      params: {
        page: Math.max(parseInt(req.query.page, 10) || 1, 1),
        limit: Math.min(parseInt(req.query.limit, 10) || 25, 100),
      },
    });
    res.json(data);
  } catch (err) {
    if (err.response?.status === 404) return res.json({ total: 0, results: [] });
    next(err);
  }
};

/**
 * POST /api/comments   { model, pk, message }
 *
 * Forme exacte attendue par HumHub, trouvée par sondage le 11/09/2026
 * (test/probe-comment3.js) : les identifiants de l'objet passent en paramètres
 * d'URL sous les noms `objectModel` et `objectId`, et le message doit être
 * enveloppé dans `Comment` — le nom de formulaire du modèle Yii.
 *
 * Ce que les autres formes donnent, mesuré :
 *   { model, pk, data: { message } }        -> 500 (objet non résolu)
 *   ?objectModel&objectId + { message }     -> 400 « le commentaire ne doit pas être vide »
 *   ?objectModel&objectId + { Comment: { message } } -> 200  ← la bonne
 *
 * Ce n'est documenté nulle part ; d'où le commentaire, pour que personne n'ait
 * à refaire la recherche.
 */
exports.createComment = async (req, res, next) => {
  const { model, pk, message } = req.body || {};
  if (!model || !pk) return res.status(400).json({ error: 'Les paramètres "model" et "pk" sont requis.' });
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'Le commentaire ne peut pas être vide.' });
  }

  try {
    const { data } = await http.post(
      '/comment',
      { Comment: { message: String(message).trim() } },
      { ...asUser(req.humhubToken), params: { objectModel: model, objectId: pk } },
    );
    res.status(201).json(data);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) return res.status(403).json({ error: 'Vous ne pouvez pas commenter ce contenu.' });
    if (status === 400) {
      return res.status(400).json({
        error: 'Commentaire refusé par le serveur.',
        details: err.response.data,
      });
    }
    if (status === 500) {
      // 500 sur cette route = objet introuvable côté HumHub, pas une panne.
      return res.status(404).json({
        error: "Le contenu commenté est introuvable (model ou pk incorrect).",
        model, pk,
      });
    }
    next(err);
  }
};

// DELETE /api/comments/:id
exports.deleteComment = async (req, res, next) => {
  try {
    const { data } = await http.delete(`/comment/${req.params.id}`, asUser(req.humhubToken));
    res.json(data);
  } catch (err) {
    if (err.response?.status === 403) {
      return res.status(403).json({ error: 'Vous ne pouvez pas supprimer ce commentaire.' });
    }
    next(err);
  }
};

// ── Likes ─────────────────────────────────────────────────────────────────────

// GET /api/likes/status?model=&pk=
exports.likeStatus = async (req, res, next) => {
  const { model, pk } = req.query;
  if (!model || !pk) return res.status(400).json({ error: 'Les paramètres "model" et "pk" sont requis.' });

  // Cache key includes userId so user A never sees user B's liked state
  const userId  = req.user?.id || 'anon';
  const cacheKey = `like:${model}:${pk}:${userId}`;
  const hit = likesCache.get(cacheKey);
  if (hit !== undefined) return res.json(hit);

  let result;
  try {
    const { data } = await http.get('/emajlis/like/status', {
      ...asUser(req.humhubToken),
      params: { model, pk },
      timeout: 5000, // fast timeout — like status is non-critical
    });
    result = data;
  } catch (err) {
    if (err.response?.status !== 404) return next(err);

    // Fallback: standard HumHub likes list
    try {
      const { data } = await http.get('/like/find-by-object', {
        ...asUser(req.humhubToken),
        params: { model, pk },
        timeout: 5000,
      });
      result = { counter: data.total ?? 0, currentUserLiked: null, degraded: true };
    } catch (err2) {
      if (err2.response?.status === 404) {
        result = { counter: 0, currentUserLiked: false };
      } else {
        return next(err2);
      }
    }
  }

  likesCache.set(cacheKey, result);
  res.json(result);
};

// POST /api/likes/batch   { items: [{model, pk}, ...] }
// Batch endpoint to fetch multiple like statuses in one request
exports.likeBatchStatus = async (req, res, next) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Parameter "items" must be a non-empty array of {model, pk}' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 items per batch request' });
  }

  const results = {};
  const token = req.humhubToken;
  
  // Fetch with concurrency limit to avoid overwhelming HumHub
  const { mapLimit } = require('../services/cache');
  await mapLimit(items, 5, async (item) => {
    const { model, pk } = item;
    if (!model || !pk) return;
    
    const key = `${model}:${pk}`;
    try {
      const { data } = await http.get('/emajlis/like/status', {
        ...asUser(token),
        params: { model, pk },
        timeout: 3000, // Faster timeout for batch
      });
      results[key] = data;
    } catch (err) {
      // Return zero counter on error so app doesn't break
      results[key] = { counter: 0, currentUserLiked: false, error: true };
    }
  });

  res.json({ results });
};

// POST /api/likes   { model, pk }
exports.like = async (req, res, next) => {
  const { model, pk } = req.body || {};
  if (!model || !pk) return res.status(400).json({ error: 'Les paramètres "model" et "pk" sont requis.' });

  try {
    const { data } = await http.post('/emajlis/like', { model, pk }, asUser(req.humhubToken));
    // Invalidate cached like status so next request reflects the new state
    const userId = req.user?.id || 'anon';
    likesCache.map.delete(`like:${model}:${pk}:${userId}`);
    res.status(data.code === 201 ? 201 : 200).json(data);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(501).json({ error: "L'ajout de like nécessite le module emajlis-api, actuellement indisponible." });
    if (status === 403) return res.status(403).json({ error: 'Vous ne pouvez pas aimer ce contenu.' });
    if (status === 400) return res.status(400).json({ error: 'Objet invalide.' });
    next(err);
  }
};

// DELETE /api/likes   { model, pk }
exports.unlike = async (req, res, next) => {
  const { model, pk } = req.body || {};
  if (!model || !pk) return res.status(400).json({ error: 'Les paramètres "model" et "pk" sont requis.' });

  try {
    const { data } = await http.delete('/emajlis/like', { ...asUser(req.humhubToken), data: { model, pk } });
    // Invalidate cached like status
    const userId = req.user?.id || 'anon';
    likesCache.map.delete(`like:${model}:${pk}:${userId}`);
    res.json(data);
  } catch (err) {
    if (err.response?.status === 404) return res.status(501).json({ error: 'Le retrait de like nécessite le module emajlis-api, actuellement indisponible.' });
    next(err);
  }
};

// Export cache for periodic cleanup in server.js
module.exports.likesCache = likesCache;
