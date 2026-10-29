'use strict';

const { http, asUser, tryGet } = require('../services/humhub');
const { normalizeType, toPlainText, titleFromText, imageFromText } = require('../services/enrich');

const wordpress = require('../services/wordpress');
const revuePresse = require('../services/revuePresse');

/**
 * Article WordPress complet (Journal ou revue de presse) au format de détail.
 * Le HTML réel est renvoyé : l'application l'affiche, sans rediriger vers le site.
 */
async function loadWordpressArticle(hint) {
  const art = wordpress.toArticle(await wordpress.findEntry(hint));
  if (!art) return null;
  return {
    title: hint.title || art.title,
    body: art.body,
    bodyFormat: 'html',
    imageUrl: art.imageUrl,
    extra: { ...art.extra, isRevueDePresse: art.isRevueDePresse },
  };
}

/** Charge le modèle spécialisé et en extrait le corps complet. */
async function loadBody(type, objectId, token, createdAt, titleHint = '') {
  switch (type) {

    case 'post': {
      const p = await tryGet(`/post/${objectId}`, token);
      if (!p) return null;
      const message = p.message || '';

      // Detect Revue de Presse post — contains link to MajlissPost
      // Pattern: URL contains /external-html-stream/majliss-post/view?id=XXX
      const majlissMatch = message.match(/https?:\/\/[^\s)]+\/external-html-stream\/majliss-post\/view\?id=(\d+)/i)
        || message.match(/https?:\/\/[^\s)]+\/revue-presse[^\s)]*\?id=(\d+)/i);

      // Billet qui cite une revue de presse : son HTML complet vient de HumHub.
      const revueId = revuePresse.revuePresseIdFrom(message) || (majlissMatch && majlissMatch[1]);
      if (revueId) {
        const r = await revuePresse.get(token, revueId).catch(() => null);
        if (r?.html) {
          return {
            title: r.title || titleHint || titleFromText(message),
            body: r.html,
            bodyFormat: 'html',
            imageUrl: r.imageUrl,
            extra: { isRevueDePresse: true, revuePresseId: String(revueId) },
          };
        }
      }
      if (majlissMatch || /revue\s+de\s+presse/i.test(message)) {
        const title = titleHint || titleFromText(message);
        const art = await loadWordpressArticle({ title, createdAt });
        if (art) return { ...art, extra: { ...art.extra, ...(revueId ? { revuePresseId: String(revueId) } : {}) } };
      }

      return {
        title:      titleFromText(message),
        body:       message,
        bodyFormat: 'markdown',
        imageUrl:   imageFromText(message),
        extra:      {},
      };
    }

    case 'article': {
      // Revue de presse : HTML complet servi par HumHub (/emajlis/revue-presse).
      if (/revue\s+de\s+presse/i.test(titleHint || '')) {
        const r = await revuePresse.get(token, objectId).catch(() => null);
        if (r?.html) {
          return {
            title: r.title || titleHint,
            body: r.html,
            bodyFormat: 'html',
            imageUrl: r.imageUrl,
            extra: { isRevueDePresse: true, revuePresseId: String(objectId) },
          };
        }
      }
      // Sinon (ou en repli) : article WordPress de l'intranet.
      return loadWordpressArticle({ title: titleHint, createdAt });
    }

    case 'calendar': {
      const e = await tryGet(`/calendar/entry/${objectId}`, token);
      if (!e) return null;
      return {
        title: e.title || '',
        body: e.description || '',
        bodyFormat: 'html',
        imageUrl: null,
        extra: {
          startDatetime: e.start_datetime || null,
          endDatetime: e.end_datetime || null,
          allDay: !!e.all_day,
          location: e.location || '',
          participationMode: e.participation_mode ?? null,
          participants: e.participants || null,
        },
      };
    }

    case 'drive_file': {      const d = await tryGet(`/emajlis/drive/file/${objectId}`, token);
      if (!d?.file) return null;
      const f = d.file;
      return {
        title: f.title || f.filename || '',
        body: f.description || '',
        bodyFormat: 'text',
        imageUrl: null,
        extra: {
          filename: f.filename,
          mimeType: f.mime_type,
          size: f.size,
          humanSize: f.human_size,
          downloadPath: `/api/drive/file/${objectId}/download`,
          versions: d.versions || [],
        },
      };
    }

    case 'cfile': {
      const f = await tryGet(`/cfiles/file/${objectId}`, token);
      if (!f) return null;
      const file = f.file || f;
      // Use the file's own id — HumHub /file/download?id= needs the file record
      // id, not the content objectId (they are different numbers).
      const fileId = file.id || file.guid || objectId;

      const humanSize = (bytes) => {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return '';
        const units = ['o', 'Ko', 'Mo', 'Go'];
        let i = 0; let v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
        return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
      };

      return {
        title: file.title || file.file_name || file.name || '',
        body: file.description || '',
        bodyFormat: 'text',
        imageUrl: null,
        extra: {
          filename: file.file_name || file.name,
          mimeType: file.mime_type,
          size: file.size,
          humanSize: file.human_size || humanSize(file.size),
          downloadPath: `/api/cfiles/file/${fileId}/download`,
        },
      };
    }

    case 'page': {
      const p = await tryGet(`/custom-pages/page/${objectId}`, token);
      const page = p?.page || p;
      if (!page) return null;
      return {
        title: page.title || '',
        body: page.page_content || '',
        bodyFormat: page.type === 1 ? 'markdown' : 'html',
        imageUrl: null,
        extra: { pageType: page.type ?? null },
      };
    }

    case 'task': {
      const t = await tryGet(`/tasks/task/${objectId}`, token);
      const task = t?.task || t;
      if (!task) return null;
      return {
        title: task.title || '',
        body: task.description || '',
        bodyFormat: 'html',
        imageUrl: null,
        extra: { status: task.status ?? null, endDatetime: task.end_datetime || null },
      };
    }

    case 'poll': {
      const p = await tryGet(`/polls/poll/${objectId}`, token);
      const poll = p?.poll || p;
      if (!poll) return null;
      return {
        title: poll.question || '',
        body: poll.description || '',
        bodyFormat: 'html',
        imageUrl: null,
        extra: { closed: !!poll.closed, answers: poll.answers || [] },
      };
    }

    default:
      return null;
  }
}

// GET /api/content/:id
exports.show = async (req, res, next) => {
  const token = req.humhubToken;

  try {
    const { data } = await http.get(`/content/${req.params.id}`, asUser(token));
    const meta      = data.metadata || {};
    const type      = normalizeType(meta.object_model || '');
    const createdAt = meta.created_at || null;
    // Le titre du fil (preview.title) sert à retrouver l'article WordPress exact.
    const titleHint = String(data.preview?.title || req.query.title || '').slice(0, 300);

    const loaded = await loadBody(type, meta.object_id, token, createdAt, titleHint);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      id:          data.id,
      objectModel: meta.object_model || '',
      objectId:    meta.object_id ?? null,
      type,
      title:      loaded?.title      || '',
      body:       loaded?.body       || '',
      bodyFormat: loaded?.bodyFormat || 'text',
      excerpt:    toPlainText(loaded?.body || ''),
      imageUrl:   loaded?.imageUrl   || null,
      url:        meta.url           || '',
      createdAt,
      updatedAt:  meta.updated_at    || null,
      author: meta.created_by
        ? { id: meta.created_by.id, name: meta.created_by.display_name || '', url: meta.created_by.url || '' }
        : null,
      containerId: meta.contentcontainer_id ?? null,
      comments:    data.comments || { total: 0 },
      likes:       data.likes    || { total: 0 },
      topics:      data.topics   || [],
      files:       data.files    || [],
      extra:       loaded?.extra || {},
      revuePresseId: loaded?.extra?.revuePresseId || null,
      needsServerSupport: !loaded,
      metadata:    meta,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(404).json({ error: 'Contenu introuvable.' });
    if (status === 403) return res.status(403).json({ error: 'Accès refusé à ce contenu.' });
    next(err);
  }
};
