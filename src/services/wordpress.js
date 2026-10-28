'use strict';

/**
 * WordPress de l'intranet (intranet.csefrs.ma) — source réelle des articles
 * du Journal (MajlissPost / ImportArticle) et des revues de presse.
 *
 * Les revues de presse sont des PAGES WordPress, pas des articles : il faut
 * chercher dans les deux types. L'appariement se fait d'abord par titre (le
 * fil HumHub fournit `preview.title`), puis, à défaut, par l'heure de
 * publication la plus proche le même jour — jamais au hasard.
 */

const axios = require('axios');
const { TtlCache } = require('./cache');

const WP_BASE = (process.env.WP_BASE_URL || 'https://intranet.csefrs.ma').replace(/\/+$/, '');
const WP_API = `${WP_BASE}/wp-json/wp/v2`;
const TYPES = ['posts', 'pages'];

// Intranet protégé par connexion : WordPress accepte un « mot de passe
// d'application » (Profil → Mots de passe d'application) en authentification
// Basic sur l'API REST. Utilisez un compte en lecture seule.
const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const WP_AUTH = WP_USER && WP_APP_PASSWORD
  ? { Authorization: `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64')}` }
  : {};
let warnedAuth = false;

const listCache = new TtlCache(10 * 60 * 1000, 2000);
const matchCache = new TtlCache(30 * 60 * 1000, 5000);

// ── Texte ─────────────────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function plain(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Clé de comparaison : minuscules, sans accents, sans ponctuation. */
function normalizeTitle(str) {
  return plain(str)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

/**
 * HTML prêt à afficher : scripts et gestionnaires retirés, shortcodes
 * WPBakery (« [vc_row …] ») supprimés, images paresseuses rendues visibles.
 * Les styles en ligne sont conservés : les revues de presse sont des
 * newsletters en tableaux qui en dépendent.
 */
function cleanHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/\[\/?(vc_|et_pb_|fusion_)[^\]]*\]/gi, '')
    .replace(/<img([^>]*?)\sdata-(?:lazy-)?src=(["'])([^"']+)\2([^>]*)>/gi, (m, a, q, src, b) =>
      `<img${a.replace(/\ssrc=(["'])[^"']*\1/i, '')} src="${src}"${b.replace(/\ssrc=(["'])[^"']*\1/i, '')}>`)
    .replace(/\s+(srcset|sizes|loading|decoding)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .trim();
}

function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  return m ? m[1] : null;
}

// ── Accès WordPress ──────────────────────────────────────────────────────────

async function wpList(type, params) {
  const key = `${type}:${JSON.stringify(params)}`;
  return listCache.getOrSet(key, async () => {
    try {
      const { data } = await axios.get(`${WP_API}/${type}`, {
        params: { _embed: 'wp:featuredmedia', ...params },
        headers: WP_AUTH,
        timeout: 10000,
      });
      return Array.isArray(data) ? data.map((d) => ({ ...d, _wpType: type })) : [];
    } catch (err) {
      const s = err.response?.status;
      if (s === 401 && !warnedAuth) {
        warnedAuth = true;
        console.warn('[wp] l\'intranet exige une connexion : renseignez WP_USER et WP_APP_PASSWORD.');
      }
      console.warn(`[wp] ${type} ${JSON.stringify(params)} : ${s || err.message}`);
      // Erreur passagère : ne pas mémoriser une liste vide.
      throw err;
    }
  });
}

let lastSearchFailed = false;
async function searchAll(params) {
  const lists = await Promise.all(TYPES.map((t) => wpList(t, params).catch(() => { lastSearchFailed = true; return []; })));
  return lists.flat();
}

/** « 2026-10-26 18:25:00 » ou ISO → millisecondes (heure locale traitée comme UTC des deux côtés). */
function toMs(value) {
  if (!value) return NaN;
  const s = String(value).trim().replace(' ', 'T').replace(/([+-]\d{2}:?\d{2}|Z)$/, '');
  return Date.parse(`${s}Z`);
}

function pickByTime(candidates, createdAt) {
  const target = toMs(createdAt);
  if (!candidates.length) return null;
  if (!Number.isFinite(target)) return candidates[0];
  return [...candidates].sort((a, b) => Math.abs(toMs(a.date) - target) - Math.abs(toMs(b.date) - target))[0];
}

function dayWindow(createdAt, days = 0) {
  const ms = toMs(createdAt);
  if (!Number.isFinite(ms)) return null;
  const from = new Date(ms - days * 86400000).toISOString().slice(0, 10);
  const to = new Date(ms + days * 86400000).toISOString().slice(0, 10);
  return { after: `${from}T00:00:00`, before: `${to}T23:59:59` };
}

/**
 * Retrouve l'entrée WordPress (article ou page) correspondant à un contenu HumHub.
 * @param {{title?: string, createdAt?: string}} hint
 */
async function findEntry({ title, createdAt } = {}) {
  const cacheKey = `${normalizeTitle(title || '')}|${String(createdAt || '').slice(0, 16)}`;
  const cached = matchCache.get(cacheKey);
  if (cached !== undefined) return cached === TtlCache.NULL_SENTINEL ? null : cached;

  let found = null;
  lastSearchFailed = false;
  const wanted = normalizeTitle(title || '');

  // 1. Par titre : correspondance exacte, puis approchée, proche de la date.
  if (wanted && wanted.length > 3) {
    const candidates = await searchAll({ search: plain(title).slice(0, 100), per_page: 20 });
    const exact = candidates.filter((c) => normalizeTitle(c.title?.rendered) === wanted);
    if (exact.length) {
      found = pickByTime(exact, createdAt);
    } else {
      const close = candidates
        .map((c) => ({ c, score: similarity(c.title?.rendered, title) }))
        .filter((x) => x.score >= 0.8)
        .map((x) => x.c);
      if (close.length) found = pickByTime(close, createdAt);
    }
  }

  // 2. Par date : même jour, heure de publication la plus proche.
  if (!found && createdAt) {
    const win = dayWindow(createdAt, 0);
    if (win) {
      const sameDay = await searchAll({ ...win, per_page: 20 });
      const filtered = wanted ? sameDay.filter((c) => similarity(c.title?.rendered, title) >= 0.5) : sameDay;
      found = pickByTime(filtered.length ? filtered : (wanted ? [] : sameDay), createdAt);
    }
  }

  // WordPress injoignable ou refus : ne pas mémoriser l'échec.
  if (found || !lastSearchFailed) matchCache.set(cacheKey, found ?? TtlCache.NULL_SENTINEL);
  return found;
}

/** Forme commune renvoyée à l'application. */
function toArticle(entry) {
  if (!entry) return null;
  const media = entry._embedded?.['wp:featuredmedia']?.[0];
  const body = cleanHtml(entry.content?.rendered || '');
  const featured = media?.source_url || null;
  const title = plain(entry.title?.rendered) || 'Article';
  return {
    title,
    excerpt: plain(entry.excerpt?.rendered || body).slice(0, 220),
    body,
    bodyFormat: 'html',
    imageUrl: featured || firstImage(body),
    externalUrl: entry.link || null,
    isRevueDePresse: /revue\s+de\s+presse/i.test(title) || /revue-de-presse/i.test(entry.slug || ''),
    extra: { wpId: entry.id, wpType: entry._wpType, wpUrl: entry.link },
  };
}

module.exports = { findEntry, toArticle, cleanHtml, decodeEntities, normalizeTitle, plain };
