'use strict';

/**
 * Enrichissement des elements de flux.
 *
 * GET /api/v1/emajlis/feed renvoie pour chaque element :
 *   { id, metadata, comments, likes, topics, files }
 * sans titre ni extrait. Ce module interroge l'endpoint specifique du type
 * pour completer chaque element avant de le renvoyer a l'app.
 *
 * CORRECTION ROOT CAUSE (socket starvation) :
 * --------------------------------------------
 * tryGet utilisait le timeout global de 30 s. Avec 6 requetes concurrentes
 * d'enrichissement x plusieurs appels feed simultanes (scroll + filtre), les
 * 20 sockets se remplissaient de requetes bloquees pendant 30 s chacune.
 * Toute nouvelle requete etait mise en file, declenchant le timeout de 2 min.
 *
 * Fixes appliques :
 *   1. tryGetFast() — timeout 5 s dedie enrichissement, libere les sockets vite.
 *   2. inflightEnrich — deduplique les fetches : si 2 requetes feed demandent
 *      le meme objectId au meme moment, une seule ouverture de socket se fait.
 *   3. maxSockets 20 -> 50 dans humhub.js — plus de starvation pool.
 *   4. limit feed 20 -> 10 dans feed.controller — moitie moins de fetches/page.
 */

const { tryGetFast } = require('./humhub');
const { TtlCache, mapLimit } = require('./cache');

/** Adresse de la miniature d'un fichier ; le nom aide à choisir le rendu. */
function thumbPath(source, id, filename) {
  if (id == null) return null;
  const name = filename ? `?name=${encodeURIComponent(filename)}` : '';
  return `/api/thumbs/${source}/${id}${name}`;
}
const axios = require('axios');

const previewCache = new TtlCache(15 * 60 * 1000, 3000); // 15 min — reduces HumHub calls on repeat visits
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY) || 6;

// Deduplication: evite d'ouvrir 2 sockets pour le meme objectId en parallele.
const inflightEnrich = new Map();

// ── WordPress : articles du Journal et revues de presse ─────────────────────
const wordpress = require('./wordpress');

/** Aperçu de carte pour un article : titre HumHub d'abord, WordPress pour l'image et le chapeau. */
async function articlePreview(raw) {
  const hint = { title: raw?.preview?.title || '', createdAt: raw?.metadata?.created_at || null };
  const entry = await wordpress.findEntry(hint);
  const art = wordpress.toArticle(entry);
  if (!art) return null;
  return {
    title: hint.title || art.title,
    excerpt: art.excerpt,
    imageUrl: art.imageUrl,
    externalUrl: null,
    extra: { ...art.extra, isRevueDePresse: art.isRevueDePresse },
  };
}

// ── Type normalisation ────────────────────────────────────────────────────────

const TYPE_BY_MODEL = [
  ['driveManager\\models\\DriveFile',               'drive_file'],
  ['driveManager\\models\\DriveFolder',             'drive_folder'],
  ['calendar\\models\\CalendarEntry',               'calendar'],
  ['post\\models\\Post',                            'post'],
  ['externalHtmlStream\\models\\MajlissPost',       'article'],
  ['import_article\\models\\ImportArticle',         'article'],
  ['custom_pages\\models\\CustomPage',              'page'],
  ['cfiles\\models\\File',                          'cfile'],
  ['cfiles\\models\\Folder',                        'cfolder'],
  ['tasks\\models\\Task',                           'task'],
  ['polls\\models\\Poll',                           'poll'],
  ['gallery\\models\\Media',                        'media'],
  ['wiki\\models\\WikiPage',                        'wiki'],
];

function normalizeType(objectModel = '') {
  for (const [needle, type] of TYPE_BY_MODEL) {
    if (objectModel.includes(needle)) return type;
  }
  return 'other';
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function toPlainText(str, maxLength = 220) {
  if (!str) return '';
  return String(str)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#8230;|&hellip;/gi, '\u2026')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[*_`>#]/g, '')
    .replace(/^\s*[-+]\s/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function titleFromText(str) {
  if (!str) return '';
  const heading = String(str).match(/^\s*#{1,6}\s+(.+?)\s*$/m);
  if (heading) return toPlainText(heading[1], 160);
  const plain = toPlainText(str, 400);
  if (!plain) return '';
  const sentence = plain.match(/^(.{0,120}?[.!?\u2026])(\s|$)/);
  return (sentence ? sentence[1] : plain.slice(0, 120)).trim();
}

function imageFromText(str) {
  if (!str) return null;
  const md = String(str).match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return md[1];
  const html = String(str).match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  return html ? html[1] : null;
}

function imageFromFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const IMAGE_MIME = /^image\//i;
  const IMAGE_EXT  = /\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$/i;
  for (const f of files) {
    const mime = f.mime_type || f.mimeType || '';
    const url  = f.url || f.download_url || f.downloadUrl || '';
    if (!url) continue;
    if (IMAGE_MIME.test(mime) || IMAGE_EXT.test(url)) return url;
  }
  return null;
}

function linkFromText(str) {
  if (!str) return null;
  const md = String(str).match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/);
  return md ? md[1] : null;
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!n || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} Mo`;
  return `${(n / 1073741824).toFixed(1)} Go`;
}

// ── Preview builders (use tryGetFast — 5 s timeout each) ─────────────────────

async function fetchPreview(type, objectId, token) {
  switch (type) {
    case 'post': {
      const p = await tryGetFast(`/post/${objectId}`, token);
      if (!p) return null;
      const raw = p.message || '';
      return {
        title:       titleFromText(raw) || 'Publication',
        excerpt:     toPlainText(raw),
        imageUrl:    imageFromText(raw) || imageFromFiles(p.files),
        externalUrl: linkFromText(raw),
        extra: {},
      };
    }

    case 'calendar': {
      const e = await tryGetFast(`/calendar/entry/${objectId}`, token);
      if (!e) return null;
      return {
        title:   e.title || 'Evenement',
        excerpt: toPlainText(e.description),
        imageUrl: null,
        extra: {
          startDatetime:     e.start_datetime || null,
          endDatetime:       e.end_datetime   || null,
          allDay:            !!e.all_day,
          location:          e.location       || '',
          participationMode: e.participation_mode ?? null,
        },
      };
    }

    case 'drive_file': {
      const d = await tryGetFast(`/emajlis/drive/file/${objectId}`, token);
      const f = d?.file;
      if (!f) return null;
      return {
        title:   f.title || f.filename || 'Document',
        excerpt: toPlainText(f.description) || f.human_size || '',
        imageUrl: null,
        extra: {
          filename:      f.filename,
          mimeType:      f.mime_type,
          size:          f.size,
          humanSize:     f.human_size || humanSize(f.size),
          folderId:      f.folder_id,
          downloadPath:  `/drive/file/${objectId}/download`,
          thumbnailPath: thumbPath('drive', objectId, f.filename),
        },
      };
    }

    case 'drive_folder': {
      const d = await tryGetFast(`/emajlis/drive/folder/${objectId}`, token);
      const f = d?.folder;
      if (!f) return null;
      return {
        title:   f.name || 'Dossier',
        excerpt: toPlainText(f.description),
        imageUrl: null,
        extra: { folderId: f.id, parentId: f.parent_id },
      };
    }

    case 'cfile': {
      const f = await tryGetFast(`/cfiles/file/${objectId}`, token);
      if (!f) return null;
      const file   = f.file || f;
      const fileId = file.id || file.guid || objectId;
      return {
        title:   file.title || file.file_name || file.name || 'Fichier',
        excerpt: toPlainText(file.description) || humanSize(file.size),
        imageUrl: null,
        extra: {
          mimeType:     file.mime_type,
          size:         file.size,
          humanSize:    humanSize(file.size),
          filename:     file.file_name || file.name,
          downloadPath: `/cfiles/file/${fileId}/download`,
          thumbnailPath: thumbPath('cfile', fileId, file.file_name || file.name),
        },
      };
    }

    case 'cfolder': {
      const f = await tryGetFast(`/cfiles/folder/${objectId}`, token);
      if (!f) return null;
      const folder = f.folder || f;
      return {
        title:   folder.title || folder.name || 'Dossier',
        excerpt: toPlainText(folder.description),
        imageUrl: null,
        extra: {},
      };
    }

    case 'page': {
      const p = await tryGetFast(`/custom-pages/page/${objectId}`, token);
      if (!p) return null;
      const page = p.page || p;
      return {
        title:   page.title || 'Page',
        excerpt: toPlainText(page.abstract || page.page_content),
        imageUrl: null,
        extra: { pageType: page.type ?? null },
      };
    }

    case 'task': {
      const t = await tryGetFast(`/tasks/task/${objectId}`, token);
      if (!t) return null;
      const task = t.task || t;
      return {
        title:   task.title || 'Tache',
        excerpt: toPlainText(task.description),
        imageUrl: null,
        extra: { status: task.status ?? null, endDatetime: task.end_datetime || null },
      };
    }

    case 'poll': {
      const p = await tryGetFast(`/polls/poll/${objectId}`, token);
      if (!p) return null;
      const poll = p.poll || p;
      return {
        title:   poll.question || 'Sondage',
        excerpt: toPlainText(poll.description),
        imageUrl: null,
        extra: { closed: !!poll.closed, answerCount: poll.answers?.length ?? null },
      };
    }

    case 'article':
      return null; // géré par articlePreview()

    default:
      return null;
  }
}

const GENERIC_TITLE = {
  article: 'Article du Journal',
  media:   'Media',
  wiki:    'Page wiki',
  other:   'Contenu',
};

// ── baseItem ─────────────────────────────────────────────────────────────────

function baseItem(raw) {
  const meta = raw.metadata || {};
  const type = normalizeType(meta.object_model || '');
  return {
    id:         raw.id ?? meta.id ?? null,
    objectModel: meta.object_model || '',
    objectId:   meta.object_id ?? null,
    type,
    title:       '',
    excerpt:     '',
    imageUrl:    null,
    externalUrl: null,
    url:         meta.url || '',
    createdAt:   meta.created_at || null,
    updatedAt:   meta.updated_at || null,
    author: meta.created_by ? {
      id:       meta.created_by.id,
      name:     meta.created_by.display_name || '',
      url:      meta.created_by.url          || '',
      imageUrl: meta.created_by.profile?.image_url
             || meta.created_by.image_url
             || null,
    } : null,
    containerId:        meta.contentcontainer_id ?? null,
    pinned:             !!meta.pinned,
    comments:           { total: raw.comments?.total ?? 0 },
    likes:              { total: raw.likes?.total    ?? 0 },
    topics:             raw.topics || [],
    files:              raw.files  || [],
    extra:              {},
    needsServerSupport: false,
    metadata:           meta,
  };
}

// ── enrichItems ───────────────────────────────────────────────────────────────

/**
 * @param {Array}  rawItems  elements bruts de /emajlis/feed ou /emajlis/search
 * @param {string} token     jeton HumHub de l'utilisateur
 * @returns {Promise<Array>} elements enrichis
 */
async function enrichItems(rawItems, token) {
  const sources = (rawItems || []).filter(Boolean);
  const items   = sources.map(baseItem);

  await mapLimit(items, CONCURRENCY, async (item, index) => {
    const raw = sources[index];

    // Server already provides preview (BG-01 deployed) — skip WP fetch.
    // EXCEPT for 'article' type when WP can match: we try WP first for rich content.
    // If WP match fails, we fall back to HumHub's preview title.
    if (raw?.preview?.title && item.type !== 'article') {
      Object.assign(item, {
        title:    raw.preview.title,
        excerpt:  raw.preview.excerpt   || '',
        imageUrl: raw.preview.image_url || null,
        extra:    { ...raw.preview },
      });
      ensureFileExtras(item, raw);
      return;
    }

    // Articles (Journal, revues de presse) : titre HumHub, image et chapeau WordPress.
    if (item.type === 'article') {
      if (raw?.preview?.title) {
        item.title = raw.preview.title;
        item.excerpt = raw.preview.excerpt || '';
        item.imageUrl = raw.preview.image_url || null;
      }
      const key = `article:${item.objectId}`;
      let preview = previewCache.get(key);
      if (preview === undefined) {
        preview = await articlePreview(raw).catch(() => null);
        previewCache.set(key, preview ?? TtlCache.NULL_SENTINEL);
      }
      if (preview && preview !== TtlCache.NULL_SENTINEL) {
        item.title = item.title || preview.title;
        item.excerpt = item.excerpt || preview.excerpt;
        item.imageUrl = item.imageUrl || preview.imageUrl;
        item.extra = preview.extra;
      } else if (!item.title) {
        item.title = GENERIC_TITLE.article || 'Article';
      }
      return;
    }

    if (item.objectId == null) return;

    // cfile: metadata already in raw.files[0] — no extra fetch needed.
    if (item.type === 'cfile') {
      const f = (raw.files || [])[0];
      if (f) {
        item.title   = f.file_name || f.title || 'Fichier';
        item.excerpt = humanSize(f.size) || '';
        item.extra   = {
          filename:      f.file_name || f.name,
          mimeType:      f.mime_type,
          size:          f.size,
          humanSize:     humanSize(f.size),
          downloadPath:  `/cfiles/file/${f.id}/download`,
          thumbnailPath: thumbPath('cfile', f.id, f.file_name || f.name),
        };
      } else {
        item.extra = {
          downloadPath:  `/cfiles/file/${item.objectId}/download`,
          thumbnailPath: thumbPath('cfile', item.objectId),
        };
      }
      return;
    }

    // ── DEDUPLICATION ────────────────────────────────────────────────────────
    // If this objectId is already cached: zero sockets used.
    // If another concurrent enrichItems is already fetching it: share the
    // in-flight promise instead of opening a second socket.
    let preview;
    const key = `${item.objectModel}:${item.objectId}`;
    const cachedVal = previewCache.get(key);

    if (cachedVal !== undefined) {
      // Cache hit — no network at all.
      preview = cachedVal === TtlCache.NULL_SENTINEL ? null : cachedVal;

    } else if (inflightEnrich.has(key)) {
      // Another request is already fetching — share its result.
      preview = await inflightEnrich.get(key);

    } else {
      // First request — fetch, deduplicate, cache.
      const fetchPromise = (async () => {
        try {
          return await fetchPreview(item.type, item.objectId, token);
        } catch (_) {
          return null;
        } finally {
          inflightEnrich.delete(key);
        }
      })();

      inflightEnrich.set(key, fetchPromise);
      const result = await fetchPromise;

      // Cache result (including null) so future pages cost zero sockets.
      previewCache.set(key, result ?? TtlCache.NULL_SENTINEL);
      preview = result;
    }

    if (preview) {
      item.title       = preview.title       || '';
      item.excerpt     = preview.excerpt     || '';
      item.imageUrl    = preview.imageUrl    || imageFromFiles(raw.files) || null;
      item.externalUrl = preview.externalUrl || null;
      item.extra       = preview.extra       || {};
    } else {
      item.imageUrl          = imageFromFiles(raw.files) || null;
      item.title             = GENERIC_TITLE[item.type] || GENERIC_TITLE.other;
      item.needsServerSupport = true;
    }
  });

  for (let i = 0; i < items.length; i += 1) ensureFileExtras(items[i], sources[i]);
  prewarmThumbnails(items, token);

  return items;
}

/**
 * Complète un élément fichier (Drive ou cfiles) avec ses chemins de
 * téléchargement et de miniature, même quand HumHub a fourni l'aperçu.
 */
function ensureFileExtras(item, raw) {
  if (item.type !== 'drive_file' && item.type !== 'cfile') return;
  const e = item.extra || (item.extra = {});
  if (item.type === 'drive_file') {
    e.filename = e.filename || e.file_name || item.title || '';
    e.downloadPath = e.downloadPath || `/drive/file/${item.objectId}/download`;
    e.thumbnailPath = e.thumbnailPath || thumbPath('drive', item.objectId, e.filename);
  } else {
    const f = (raw?.files || [])[0] || {};
    const fileId = f.id || e.file_id || item.objectId;
    e.filename = e.filename || e.file_name || f.file_name || f.name || item.title || '';
    e.downloadPath = e.downloadPath || `/cfiles/file/${fileId}/download`;
    e.thumbnailPath = e.thumbnailPath || thumbPath('cfile', fileId, e.filename);
  }
}

/**
 * Lance en arrière-plan la génération des miniatures des fichiers de la page,
 * pour qu'elles soient prêtes quand l'application les demande.
 */
function prewarmThumbnails(items, token) {
  const thumbs = require('./thumbnail');
  for (const item of items.slice(0, 15)) {
    const p = item.extra?.thumbnailPath;
    if (!p) continue;
    const m = p.match(/^\/api\/thumbs\/(drive|cfile)\/(\d+)/);
    if (!m || thumbs.cached(m[1], m[2])) continue;
    thumbs.generate(m[1], m[2], token, item.extra?.filename || '').catch(() => {});
  }
}

module.exports = {
  enrichItems,
  normalizeType,
  toPlainText,
  titleFromText,
  imageFromText,
  imageFromFiles,
  humanSize,
  previewCache,
};




