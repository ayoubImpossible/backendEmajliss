'use strict';

/**
 * Revues de presse — route HumHub /emajlis/revue-presse (module E-Majlis).
 *
 *   GET /emajlis/revue-presse?page=&limit=   liste, la plus récente d'abord
 *   GET /emajlis/revue-presse/{id}           une revue, avec son HTML complet
 *
 * Toujours avec le jeton de l'utilisateur : HumHub réserve les revues aux
 * membres de l'espace « REVUES DE PRESSE » (403 sinon).
 *
 * La mise en forme ci-dessous accepte plusieurs noms de champs (html,
 * content, body…) pour ne pas dépendre d'un détail de sérialisation.
 */

const { http, asUser, BASE } = require('./humhub');
const { cleanHtml, plain } = require('./wordpress');

const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((acc, p) => (acc == null ? acc : acc[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/** Adresse absolue (les chemins HumHub « /uploads/… » deviennent complets). */
function absolute(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${BASE}${url}`;
  return null;
}

/** Le plus long texte HTML de l'objet : repli si le champ porte un nom inattendu. */
function longestHtml(obj, depth = 0) {
  if (depth > 4 || obj == null) return '';
  if (typeof obj === 'string') return /<[a-z][\s\S]*>/i.test(obj) ? obj : '';
  if (typeof obj !== 'object') return '';
  let best = '';
  for (const v of Object.values(obj)) {
    const h = longestHtml(v, depth + 1);
    if (h.length > best.length) best = h;
  }
  return best;
}

function unwrap(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data.revue || data.revuePresse || data.item || data.data || data.result || data;
  }
  return data;
}

function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? absolute(m[1]) : null;
}

/**
 * Si HumHub renvoie la page web complète (menus, en-tête…), ne garder que le
 * document de la revue : le bloc « document-container » / « imported-document-content ».
 */
function documentOnly(html) {
  const s = String(html || '');
  const start = s.search(/<div[^>]+class=["'][^"']*(document-container|imported-document-content)/i);
  if (start < 0) return s;
  let out = s.slice(start);
  const end = out.search(/<\/body>|<footer[\s>]/i);
  if (end > 0) out = out.slice(0, end);
  return out;
}

/** Rend les adresses relatives de HumHub absolues dans le HTML. */
function absolutizeHtml(html) {
  return String(html || '').replace(/(\s(?:src|href)=["'])(\/(?!\/)[^"']*)(["'])/gi, (m, a, p, b) => `${a}${BASE}${p}${b}`);
}

function mapSummary(x) {
  if (!x || typeof x !== 'object') return null;
  const id = pick(x, ['id', 'revue_id', 'revueId', 'object_id', 'objectId', 'content_id']);
  if (id == null) return null;
  const html = pick(x, ['html', 'content_html', 'contentHtml', 'content', 'body', 'message']) || '';
  return {
    id: String(id),
    title: plain(pick(x, ['title', 'titre', 'name', 'subject']) || '') || 'Revue de presse',
    date: pick(x, ['date', 'published_at', 'publishedAt', 'created_at', 'createdAt', 'metadata.created_at']) || null,
    imageUrl: absolute(pick(x, ['image_url', 'imageUrl', 'image', 'cover', 'cover_url', 'thumbnail', 'thumbnail_url']))
      || firstImage(html),
    excerpt: plain(pick(x, ['excerpt', 'summary', 'description', 'chapeau']) || '').slice(0, 220)
      || plain(html).slice(0, 220),
    contentId: pick(x, ['content_id', 'contentId', 'metadata.id']) ?? null,
  };
}

async function list(token, { page = 1, limit = 20 } = {}) {
  const { data } = await http.get('/emajlis/revue-presse', {
    ...asUser(token),
    params: { page, limit },
    timeout: 20000,
  });
  const rows = Array.isArray(data) ? data : (data?.results || data?.items || data?.data || data?.revues || []);
  const results = rows.map(mapSummary).filter(Boolean);
  const total = Number(data?.total ?? data?.totalCount ?? results.length) || results.length;
  const pages = Number(data?.pages ?? data?.pageCount ?? (data?.total ? Math.ceil(data.total / limit) : page)) || page;
  return { results, total, page, pages, hasMore: page < pages || results.length >= limit };
}

async function get(token, id) {
  const r = await http.get(`/emajlis/revue-presse/${encodeURIComponent(id)}`, { ...asUser(token), timeout: 30000 });
  const data = r.data;

  // La route peut aussi renvoyer directement la page HTML.
  if (typeof data === 'string') {
    const body = cleanHtml(absolutizeHtml(documentOnly(data)));
    const title = plain((data.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') || 'Revue de presse';
    return { id: String(id), title, date: null, imageUrl: firstImage(body), html: body };
  }

  const x = unwrap(data);
  const summary = mapSummary({ id, ...x }) || { id: String(id), title: 'Revue de presse' };
  const html = pick(x, ['html', 'content_html', 'contentHtml', 'content', 'body', 'message']) || longestHtml(x);
  const body = cleanHtml(absolutizeHtml(documentOnly(typeof html === 'string' ? html : '')));
  return { ...summary, html: body, imageUrl: summary.imageUrl || firstImage(body) };
}

/**
 * Identifiant de revue cité par un texte (billet du fil, lien) :
 *   …/revue-presse?id=123, …/revue-presse/123,
 *   …/external-html-stream/majliss-post/view?id=123
 */
function revuePresseIdFrom(text) {
  const s = String(text || '');
  const m = s.match(/\/revue-presse(?:\/view)?(?:\/|\?(?:[^"'\s)]*&)?id=)(\d+)/i)
    || s.match(/\/external-html-stream\/majliss-post\/view\?(?:[^"'\s)]*&)?id=(\d+)/i);
  return m ? m[1] : null;
}

module.exports = { list, get, revuePresseIdFrom, mapSummary };
