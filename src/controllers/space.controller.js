'use strict';

/**
 * Espaces : membres, modules activés, pages personnalisées.
 *
 * À ne pas confondre avec l'ancien `espaces.controller.js`, qui renvoie une
 * liste de 8 espaces CODÉE EN DUR (la plateforme en compte 17) et lit Firestore.
 * Ce contrôleur-ci ne parle qu'à HumHub.
 *
 * Comble BG-08 (membres) et BG-09 (pages personnalisées).
 */

const { http, asUser, tryGet } = require('../services/humhub');
const { TtlCache } = require('../services/cache');

const shortcutCache = new TtlCache(10 * 60 * 1000, 500);

// ── GET /api/spaces/:id/members ───────────────────────────────────────────────
// L'application appelait /api/membres — l'annuaire général, sans rapport avec
// l'espace consulté. On interroge ici la vraie composition de l'espace.
exports.members = async (req, res, next) => {
  try {
    const { data } = await http.get(`/space/${req.params.id}/membership`, {
      ...asUser(req.humhubToken),
      params: {
        page: Math.max(parseInt(req.query.page, 10) || 1, 1),
        limit: Math.min(parseInt(req.query.limit, 10) || 50, 100),
      },
    });
    res.json(data);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Espace introuvable.' });
    if (status === 403) return res.status(403).json({ error: 'Accès refusé à cet espace.' });
    next(err);
  }
};

// ── GET /api/spaces/user-image/:userId ───────────────────────────────────────
// Proxifie l'image de profil HumHub (requiert auth — HumHub retourne 401 sans token).
// Retourne l'image directement (pas JSON) pour usage dans <Image source={uri}>.
exports.userImage = async (req, res, next) => {
  const { userId } = req.params;
  if (!userId || !/^\d+$/.test(userId)) return res.status(400).end();
  try {
    const { BASE } = require('../services/humhub');
    const axios = require('axios');
    const { httpsAgent, asUser } = require('../services/humhub');
    const imageUrl = `${BASE}/index.php?r=user%2Fprofile-image%2Fimage&userId=${userId}`;
    const response = await axios.get(imageUrl, {
      ...asUser(req.humhubToken),
      responseType: 'stream',
      timeout: 8000,
      httpsAgent,
      maxRedirects: 3,
      validateStatus: (s) => s < 400,
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    response.data.pipe(res);
  } catch (err) {
    // Return 204 (no content) so the app falls back to initials gracefully
    res.status(204).end();
  }
};

/**
 * La plupart des « pages » du menu d'un espace ne sont pas des pages : ce sont
 * des raccourcis vers un dossier du Drive, un dossier cfiles, ou une recherche
 * filtrée (voir docs/MOBILE_SPEC.md §8.3).
 *
 * On analyse `page_content` pour en extraire la cible, afin que le mobile
 * n'ait qu'à router — sans écran dédié à développer pour ces pages.
 */
function resolveShortcut(page) {
  const raw = String(page?.page_content || '').trim();
  if (!raw) return null;

  const drive = raw.match(/drive-manager\/browse\/index\?folderId=(\d+)/i);
  if (drive) return { kind: 'drive', folderId: Number(drive[1]) };

  const cfiles = raw.match(/cfiles\/browse\/index\?fid=(\d+)/i);
  if (cfiles) return { kind: 'cfiles', folderId: Number(cfiles[1]) };

  const search = raw.match(/content\/search\?[^\s]*contentContainer(?:%5B%5D|\[\])=([0-9a-f-]{36})/i);
  if (search) return { kind: 'search', containerGuid: search[1] };

  if (/content\/search/i.test(raw)) return { kind: 'search', containerGuid: null };

  const external = raw.match(/^(https?:\/\/[^\s)]+)$/m);
  if (external) {
    const url = external[1];
    const isInternal = /emajlis-dev\.csefrs\.ma|emajlis\.csefrs\.ma/i.test(url);
    return { kind: isInternal ? 'internal' : 'external', url };
  }

  const relative = raw.match(/^(\/[^\s)]+)$/m);
  if (relative) return { kind: 'internal', url: relative[1] };

  return null;
}

// GET /api/spaces/:containerId/pages
exports.pages = async (req, res, next) => {
  const { containerId } = req.params;

  try {
    const { data } = await http.get(`/custom-pages/container/${containerId}`, asUser(req.humhubToken));
    const rows = data.results || data.data || [];

    const results = rows.map((row) => {
      const page = row.page || row;
      return {
        id: page.id,
        title: page.title || '',
        type: page.type ?? null,
        icon: page.icon || null,
        hidden: !!page.hide_menu,
        sortOrder: page.sort_order ?? 0,
        shortcut: resolveShortcut(page),
      };
    });

    res.json({ total: results.length, results });
  } catch (err) {
    if (err.response?.status === 404) return res.json({ total: 0, results: [], degraded: true });
    next(err);
  }
};

// ── GET /api/spaces/:containerId/modules ─────────────────────────────────────
/**
 * Ce que cet endpoint mesure — et ce qu'il ne mesure pas.
 *
 * HumHub n'expose AUCUN moyen, par l'API REST, de savoir quels modules sont
 * activés dans un espace : il n'existe pas de `GET /space/{id}/modules`.
 * Mesuré le 10/09/2026 sur les 14 espaces visibles (test/probe-modules.js) :
 * `/calendar/container/{cid}`, `/cfiles/files/container/{cid}`,
 * `/tasks/container/{cid}`, `/polls/container/{cid}` et
 * `/custom-pages/container/{cid}` répondent 200 avec une liste vide dans TOUS
 * les espaces, y compris là où le module n'est manifestement pas utilisé.
 * Sonder le code HTTP ne distingue donc rien — deux signatures seulement sur
 * quatorze espaces, et la seule différence venait de `drive-manager`.
 *
 * Conséquence : on ne prétend pas répondre « modules activés ». On renvoie deux
 * signaux distincts, chacun étiqueté par ce qu'il vaut :
 *
 *   basis: 'activation' — le module répond 404 quand il est absent. Fiable.
 *                          Aujourd'hui : drive-manager (module emajlis-api).
 *   basis: 'content'    — le contrôleur répond toujours 200 ; on ne peut
 *                          observer que la présence de contenu. Un module activé
 *                          mais vide est donc indiscernable d'un module éteint.
 *
 * `menu` est la liste que le mobile doit afficher : les modules dont
 * l'activation est prouvée, plus ceux qui ont du contenu réel. C'est une
 * construction dynamique, mesurée espace par espace — jamais une liste en dur,
 * jamais un test sur le nom de l'espace. Elle peut omettre un onglet activé
 * mais vide : la limite est côté API HumHub, pas côté mobile.
 *
 * La levée de cette limite est décrite dans
 * docs/EMajlis-Mobile-Backend-Gaps.md, BG-12 : une route
 * `GET /emajlis/space/{cid}/modules` dans le module emajlis-api rendrait la
 * vraie liste (`$space->moduleManager->getEnabled()`), et cet endpoint-ci s'en
 * servirait en priorité. Elle n'a pas été écrite : consigne de ne pas toucher
 * au serveur.
 *
 * `containerId` est le contentcontainer_id, PAS l'identifiant d'espace.
 */
const MODULE_PROBES = [
  { id: 'drive-manager', basis: 'activation', path: (cid) => `/emajlis/drive/container/${cid}` },
  { id: 'calendar', basis: 'content', path: (cid) => `/calendar/container/${cid}` },
  { id: 'cfiles', basis: 'content', path: (cid) => `/cfiles/files/container/${cid}` },
  { id: 'tasks', basis: 'content', path: (cid) => `/tasks/container/${cid}` },
  { id: 'polls', basis: 'content', path: (cid) => `/polls/container/${cid}` },
  { id: 'custom_pages', basis: 'content', path: (cid) => `/custom-pages/container/${cid}` },
];

/** Nombre d'éléments dans une réponse de conteneur, quelle qu'en soit la forme. */
function countItems(data) {
  if (!data || typeof data !== 'object') return 0;
  if (typeof data.total === 'number') return data.total;
  if (Array.isArray(data.results)) return data.results.length;
  if (Array.isArray(data.folders) || Array.isArray(data.files)) {
    return (data.folders || []).length + (data.files || []).length;
  }
  if (Array.isArray(data)) return data.length;
  return 0;
}

exports.modules = async (req, res, next) => {
  const { containerId } = req.params;
  const token = req.humhubToken;
  const cacheKey = `modules:${containerId}`;

  try {
    const payload = await shortcutCache.getOrSet(cacheKey, async () => {
      const probed = await Promise.all(
        MODULE_PROBES.map(async (probe) => {
          let status = null;
          let data = null;
          try {
            const r = await http.get(probe.path(containerId), asUser(token));
            status = r.status;
            data = r.data;
          } catch (err) {
            status = err.response?.status ?? null;
          }

          const reachable = status !== null && status >= 200 && status < 300;
          const count = reachable ? countItems(data) : 0;

          return {
            id: probe.id,
            basis: probe.basis,
            // `available` n'a de sens que pour basis === 'activation'.
            available: probe.basis === 'activation' ? reachable : null,
            hasContent: count > 0,
            count,
            httpStatus: status,
          };
        }),
      );

      const menu = probed
        .filter((m) => (m.basis === 'activation' ? m.available : m.hasContent))
        .map((m) => m.id);

      return {
        modules: probed,
        menu,
        note: "menu = activation prouvée ou contenu réel. HumHub n'expose pas la liste des modules activés par l'API REST ; voir BG-12.",
      };
    });

    res.json({ containerId: Number(containerId), ...payload });
  } catch (err) { next(err); }
};

exports.resolveShortcut = resolveShortcut;
