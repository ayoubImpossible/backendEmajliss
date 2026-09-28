'use strict';

/**
 * Authentification : le jeton du mobile est un JWT émis par HumHub.
 *
 * Express ne décide JAMAIS des permissions à la place de HumHub : il relaie le
 * jeton et laisse le serveur arbitrer. Ce middleware ne fait que résoudre
 * l'identité derrière le jeton.
 *
 * Deux corrections par rapport à la version précédente :
 *
 * 1. CACHE — /auth/current était appelé à CHAQUE requête, doublant la latence
 *    de toute l'API. Le résultat est désormais mémorisé 60 secondes par jeton.
 *
 * 2. RÔLE — le rôle administrateur était déduit de `account.tags.includes(
 *    'Administration')`. Vérification faite sur le serveur : `account.tags` vaut
 *    [] pour tous les comptes. `isAdmin` était donc TOUJOURS faux et
 *    requireAdmin renvoyait 403 à tout le monde, y compris aux administrateurs.
 *    Cette déduction est supprimée. La seule habilitation que l'API sache
 *    établir de façon fiable est celle de gestionnaire E-Services, exposée par
 *    /emajlis/eservice/catalog -> is_manager.
 */

const { http, asUser, tryGet } = require('../services/humhub');
const { TtlCache } = require('../services/cache');

const userCache = new TtlCache(60 * 1000, 500);
const managerCache = new TtlCache(5 * 60 * 1000, 500);

/**
 * Clé de cache dérivée du jeton, jamais le jeton lui-même.
 * Utilise la longueur + les 24 derniers caractères (signature JWT) :
 * suffisamment unique pour un cache local tout en évitant les collisions
 * du hash 32 bits précédent.
 */
function tokenKey(token) {
  // Use token length + last 24 chars — unique enough for a local cache
  // Never log or expose the token value itself
  return `${token.length}:${token.slice(-24)}`;
}

function mapUser(data) {
  const account = data.account || {};
  const profile = data.profile || {};
  return {
    id: data.id,
    guid: data.guid,
    username: account.username,
    email: account.email,
    display_name: data.display_name,
    firstname: profile.firstname,
    lastname: profile.lastname,
    image_url: profile.image_url || null,
    // Champs métier propres au Conseil (voir docs/MOBILE_SPEC.md §17.1)
    categorie: profile.categorie || null,
    commission: profile.commission_fr || null,
    fonction: profile.fonction_fr || null,
    groupespecial: profile.groupespecial || null,
    language: account.language || null,
    raw: data,
  };
}

async function resolveHumHubUser(token) {
  return userCache.getOrSet(tokenKey(token), async () => {
    const { data } = await http.get('/auth/current', { ...asUser(token), timeout: 8000 });
    return mapUser(data);
  });
}

/**
 * Gestionnaire E-Services : habilitation réelle, lue côté serveur.
 * Renvoie false si le module custom est indisponible — jamais true par défaut.
 */
async function isEserviceManager(token) {
  return managerCache.getOrSet(`mgr:${tokenKey(token)}`, async () => {
    const catalog = await tryGet('/emajlis/eservice/catalog', token);
    return catalog ? !!catalog.is_manager : false;
  });
}

async function requireAuth(req, res, next) {
  // Accept token from Authorization header OR ?token= query param (for WebView file viewing)
  const headerMatch = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = headerMatch?.[1] || req.query.token || null;

  if (!token) return res.status(401).json({ error: "Jeton d'authentification requis." });

  try {
    req.humhubToken = token;
    req.user = await resolveHumHubUser(token);
    return next();
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
    }
    // Une panne réseau vers HumHub n'est PAS un problème d'identifiants :
    // elle doit être signalée comme telle, pas déguisée en 401.
    console.error('[auth] HumHub injoignable :', err.message);
    return res.status(502).json({ error: 'Service d\'authentification indisponible.' });
  }
}

/** Réserve une route aux gestionnaires E-Services. */
async function requireEserviceManager(req, res, next) {
  await requireAuth(req, res, async () => {
    try {
      if (!(await isEserviceManager(req.humhubToken))) {
        return res.status(403).json({ error: 'Accès réservé aux gestionnaires E-Services.' });
      }
      req.isEserviceManager = true;
      next();
    } catch (err) { next(err); }
  });
}

function optionalAuth(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return next();

  resolveHumHubUser(match[1])
    .then((user) => {
      req.user = user;
      req.humhubToken = match[1];
      next();
    })
    .catch(() => next());
}

/**
 * Conservé pour les routes héritées qui l'utilisent encore
 * (actualites, calendar, membres, notifications).
 *
 * ATTENTION : aucune source fiable de rôle « administrateur système » n'est
 * exposée par l'API REST HumHub. Cette garde refuse donc systématiquement.
 * C'est volontaire : mieux vaut un refus explicite qu'une autorisation
 * accordée sur un champ vide. Voir BG-10.
 */
function requireAdmin(req, res, next) {
  return res.status(403).json({
    error: "Cette action n'est pas disponible depuis l'application mobile.",
    detail: 'Aucune habilitation administrateur n\'est exposée par l\'API HumHub (BG-10).',
  });
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireEserviceManager,
  optionalAuth,
  isEserviceManager,
  resolveHumHubUser,
  userCache,
  managerCache,
};
