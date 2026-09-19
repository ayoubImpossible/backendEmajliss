'use strict';



const { http, asUser } = require('../services/humhub');
const { enrichItems } = require('../services/enrich');

const clampLimit = (v, def, max = 100) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const toPage = (v) => Math.max(parseInt(v, 10) || 1, 1);

/** Enveloppe de pagination commune Ã  toutes les listes. */
function paginated(data, results, page) {
  return {
    total: data.total ?? results.length,
    pages: data.pages ?? Math.ceil((data.total ?? results.length) / (results.length || 1)),
    page,
    results,
  };
}

// ── Flux ─────────────────────────────────────────────────────────────────────

/** Affiche le flux principal (HumHub) ou d'un espace (si ?container=N). */
exports.getFeed = async (req, res, next) => {
  const { container, contentType } = req.query;
  const page  = toPage(req.query.page);
  // Default 10 items (was 20) — halves enrichment sockets per request.
  // App already requests 20 via param; this only changes the implicit default.
  const limit = clampLimit(req.query.limit, 10);
  const token = req.humhubToken;

  if (container) return exports.getSpaceFeed(req, res, next);

  // Build params — only include contentType if provided
  const params = { page, limit };
  if (contentType) {
    params.contentType = contentType;
    console.log('[getFeed] FILTER BY contentType:', contentType);
  }

  console.log('[getFeed] params:', params);

  try {
    const { data } = await http.get('/emajlis/feed', {
      ...asUser(token),
      params,
    });
    
    const totalFromHumHub = data.total ?? (data.results || []).length;
    console.log('[getFeed] HumHub returned:', totalFromHumHub, 'items (displaying', limit, ')');
    
    // CRITICAL: HumHub ignores the `limit` param for some content types
    // (MajlissPost, ImportArticle) and returns ALL items (365, 401...).
    // We must slice BEFORE enriching, otherwise we enrich hundreds of items.
    // Also filter out folder types — they are not meaningful in the feed.
    const HIDDEN_TYPES = ['driveManager\\models\\DriveFolder', 'cfiles\\models\\Folder'];
    const filtered = (data.results || []).filter((r) => {
      const model = r?.metadata?.object_model || '';
      return !HIDDEN_TYPES.some((t) => model.includes(t));
    });
    const rawResults = filtered.slice(0, limit);
    
    const results = await enrichItems(rawResults, token);
    
    // Rebuild pagination with correct numbers
    const total = totalFromHumHub;
    const pages = Math.ceil(total / limit) || 1;
    res.json({ total, pages, page, results });
  } catch (err) { 
    console.error('[getFeed] ERROR:', err.response?.status, err.message);
    next(err);
  }
};

// ── Recherche ────────────────────────────────────────────────────────────────

exports.search = async (req, res, next) => {
  const { keyword, type, page: p, limit: l } = req.query;
  const page = toPage(p);
  const limit = clampLimit(l, 10);

  if (!keyword) return res.json({ results: [], total: 0, pages: 0, page });

  try {
    const { data } = await http.get('/emajlis/search', {
      ...asUser(req.humhubToken),
      params: { keyword, type, page, limit },
    });
    const results = await enrichItems(data.results, req.humhubToken);
    res.json(paginated(data, results, page));
  } catch (err) { next(err); }
};

exports.searchTypes = async (req, res, next) => {
  try {
    const { data } = await http.get('/emajlis/search/types', asUser(req.humhubToken));
    const list = Array.isArray(data)
      ? data
      : (data?.results || data?.items || data?.types || []);
    res.json({ results: list });
  } catch (err) { next(err); }
};

// ── Espaces ──────────────────────────────────────────────────────────────────

exports.getSpaces = async (req, res, next) => {
  try {
    const { data } = await http.get('/space', asUser(req.humhubToken));
    res.json(data);
  } catch (err) { next(err); }
};

exports.getSpace = async (req, res, next) => {
  const { id } = req.params;
  try {
    const { data } = await http.get(`/space/${id}`, asUser(req.humhubToken));
    res.json(data);
  } catch (err) { next(err); }
};

exports.getSpaceFeed = async (req, res, next) => {
  const { containerId } = req.params;
  const page = toPage(req.query.page);
  const limit = clampLimit(req.query.limit, 10);
  const token = req.humhubToken;

  // Préférer /emajlis/space/{id} si disponible : plus riche, plus fiable.
  try {
    const { data } = await http.get(`/emajlis/space/${containerId}`, {
      ...asUser(token),
      params: { page, limit },
    });
    const rawResults = (data.results || []).slice(0, limit);
    const results = await enrichItems(rawResults, token);
    return res.json(paginated(data, results, page));
  } catch (err) {
    if (err.response?.status !== 404) return next(err);
  }

  try {
    const { data } = await http.get(`/content/find-by-container/${containerId}`, {
      ...asUser(token),
      params: { page, limit },
    });
    const rawResults = (data.results || []).slice(0, limit);
    const results = await enrichItems(rawResults, token);
    res.json({ ...paginated(data, results, page), degraded: true });
  } catch (err) { next(err); }
};

// ── Notifications ─────────────────────────────────────────────────────────────

/** Normalise une notification brute HumHub en forme consommable par le mobile. */
function mapNotification(n) {
  if (!n || typeof n !== 'object') {
    console.warn('[mapNotification] Invalid notification object:', n);
    return null;
  }
  
  try {
    return {
      id:         n.id || String(Math.random()),
      class:      String(n.class || ''),
      output:     String(n.output || ''),
      seen:       !!n.seen,
      createdAt:  n.created_at || n.createdAt || new Date().toISOString(),
      originator: n.originator && typeof n.originator === 'object'
        ? {
            id:           n.originator.id || null,
            display_name: String(n.originator.display_name || ''),
            url:          String(n.originator.url || ''),
            image_url:    (n.originator.profile && n.originator.profile.image_url) || null,
          }
        : null,
      source: n.source || null,
    };
  } catch (err) {
    console.error('[mapNotification] Error mapping notification:', err.message, n);
    return null;
  }
}

exports.getNotifications = async (req, res, next) => {
  try {
    console.log('=== NOTIFICATION REQUEST START ===');
    console.log('Time:', new Date().toISOString());
    console.log('Token present:', !!req.humhubToken);
    console.log('User-Agent:', req.headers['user-agent']);
    console.log('Query params:', req.query);
    
    const page = toPage(req.query.page);
    const limit = clampLimit(req.query.limit, 20);
    
    let data;
    // ⚠️  HumHub's /notification endpoint returns 500 when `limit` is sent.
    // Only `page` is accepted. Results are always 10 per page server-side.
    const paramVariants = [
      { page },
      {},
    ];

    let lastError;
    for (const params of paramVariants) {
      try {
        const response = await http.get('/notification', {
          ...asUser(req.humhubToken),
          params,
          timeout: 15000,
        });
        data = response.data;
        console.log('[getNotifications] Success with params:', params, 'results:', data?.results?.length || 0);
        break;
      } catch (humhubError) {
        lastError = humhubError;
        console.error('[getNotifications] HumHub error with params', params, ':', humhubError.response?.status, humhubError.response?.data?.message || humhubError.message);
        if (humhubError.response?.status === 401 || humhubError.response?.status === 403) {
          throw humhubError;
        }
      }
    }

    if (!data) {
      // All variants failed — return empty gracefully
      console.error('[getNotifications] All param variants failed. Last error:', lastError?.response?.status);
      return res.json({ results: [], total: 0, pages: 1, page });
    }
    
    // Process notifications safely
    let results = [];
    if (data && Array.isArray(data.results)) {
      const seen = new Set();
      results = data.results
        .map(mapNotification)
        .filter(Boolean)
        .filter((n) => {
          if (!n.id || seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        });
    }
    
    const response = paginated(data || {}, results, page);
    res.json(response);
    
  } catch (err) { 
    console.error('[getNotifications] Error:', err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error || err.message || 'Erreur interne du serveur',
      results: [],
      total: 0,
      pages: 1,
      page: toPage(req.query.page)
    });
  }
};

exports.getUnseenCount = async (req, res, next) => {
  try {
    const { data } = await http.get('/notification/unseen', asUser(req.humhubToken));
    // HumHub returns different field names — try all variants
    const count = data?.unseen ?? data?.total ?? data?.count ?? data?.unseenCount
      ?? (Array.isArray(data?.results) ? data.results.length : 0);
    console.log('[getUnseenCount] data:', JSON.stringify(data), 'count:', count);
    res.json({ total: count, count, results: data?.results || [] });
  } catch (err) {
    console.error('[getUnseenCount] Error:', err.response?.status, err.message);
    // Fallback: use main notifications total
    try {
      const { data: d2 } = await http.get('/notification', { ...asUser(req.humhubToken), params: { page: 1 }, timeout: 8000 });
      const total = d2?.total || 0;
      res.json({ total, count: total, results: d2?.results || [] });
    } catch (_) {
      res.json({ total: 0, count: 0, results: [] });
    }
  }
};

exports.markSeen = async (req, res, next) => {
  // Try known HumHub notification mark-as-read endpoints
  const endpoints = [
    () => http.post('/notification/mark-as-seen', {}, asUser(req.humhubToken)),
    () => http.patch('/notification/mark-as-seen', {}, asUser(req.humhubToken)),
    () => http.get('/notification/mark-as-seen', asUser(req.humhubToken)),
  ];
  for (const fn of endpoints) {
    try {
      const { data } = await fn();
      return res.json(data || { success: true });
    } catch (err) {
      if (err.response?.status !== 404 && err.response?.status !== 405) {
        console.error('[markSeen] Error:', err.response?.status, err.message);
      } 
    }
  }
  // Not critical — just return success so the app doesn't break
  res.json({ success: true });
};

// Mock notifications for testing
exports.getMockNotifications = async (req, res, next) => {
  try {
    const page = toPage(req.query.page);
    const mockNotifications = [
      {
        id: '1',
        class: 'contentcreated',
        output: '<strong>Admin</strong> a créé un nouveau contenu',
        seen: false,
        created_at: new Date(Date.now() - 3600000).toISOString(),
        originator: {
          id: '1',
          display_name: 'Admin',
          url: '/user/admin',
          profile: { image_url: null }
        }
      },
      {
        id: '2',
        class: 'like',
        output: '<strong>Utilisateur</strong> a aimé votre publication',
        seen: true, 
        created_at: new Date(Date.now() - 7200000).toISOString(),
        originator: {
          id: '2',
          display_name: 'Utilisateur',
          url: '/user/user',
          profile: { image_url: null }
        }
      }
    ];
    
    const results = mockNotifications.map(mapNotification).filter(Boolean);
    
    res.json({
      results: results,
      total: results.length,
      pages: 1,
      page: page,
      mock: true
    });
    
  } catch (err) {
    next(err);
  }
};

// ── Calendrier ───────────────────────────────────────────────────────────────

exports.getCalendar = async (req, res, next) => {
  const page = toPage(req.query.page);
  const auth = asUser(req.humhubToken);

  // Try param variants — HumHub /calendar returns 500 with certain params (same issue as /notification)
  const attempts = [
    { endpoint: '/calendar', params: { page } },
    { endpoint: '/calendar', params: {} },
    { endpoint: '/calendar/entry', params: { page } },
    { endpoint: '/calendar/entry', params: {} },
  ];

  for (const attempt of attempts) {
    try {
      const { data } = await http.get(attempt.endpoint, {
        ...auth,
        params: attempt.params,
        timeout: 10000,
      });

      console.log(`[getCalendar] SUCCESS ${attempt.endpoint} params=${JSON.stringify(attempt.params)}`);
      console.log(`[getCalendar] Response keys:`, Object.keys(data || {}));

      const raw = data.results || data.data || data.items || [];
      console.log(`[getCalendar] Raw items count:`, raw.length);
      if (raw[0]) console.log(`[getCalendar] First item keys:`, Object.keys(raw[0]));

      const results = raw.map((e) => ({
        ...e,
        title:         e.title         || e.title_fr       || '',
        startDatetime: e.startDatetime || e.start_datetime || e.start_date || '',
        endDatetime:   e.endDatetime   || e.end_datetime   || e.end_date   || '',
        allDay:        !!e.allDay      || !!e.all_day,
        location:      e.location      || e.place          || '',
        color:         e.color         || '#6B1A2A',
        url:           e.url           || '',
      }));

      return res.json({ results, total: data.total || results.length, pages: data.pages || 1, page });

    } catch (err) {
      const status = err.response?.status;
      console.log(`[getCalendar] FAIL ${attempt.endpoint} params=${JSON.stringify(attempt.params)} → ${status}: ${err.response?.data?.message || err.message}`);
      if (status === 401 || status === 403) return next(err);
      // 404 or 500 — try next variant
    }
  }

  // All failed — return empty so app shows "Aucune réunion" instead of error
  console.log('[getCalendar] All attempts failed — returning empty list');
  return res.json({ results: [], total: 0, pages: 1, page });
};











