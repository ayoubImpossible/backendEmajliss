'use strict';


require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { errorHandler } = require('./middleware/errorHandler');
const { logNotificationRequests } = require('./middleware/logger');
const { requireAuth } = require('./middleware/humhubAuth');
const { BASE: HUMHUB_BASE, INSECURE, tlsStatus, httpsAgent } = require('./services/humhub');

const authRoutes = require('./routes/auth.routes');
const membresRoutes = require('./routes/membres.routes');
const calendarRoutes = require('./routes/calendar.routes');
const eservicesRoutes = require('./routes/eservices.routes');
const feedRoutes = require('./routes/feed.routes');
const contentRoutes = require('./routes/content.routes');
const driveRoutes = require('./routes/drive.routes');
const spaceRoutes = require('./routes/space.routes');
const { comments: commentRoutes, likes: likeRoutes } = require('./routes/social.routes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Trust Railway/Vercel/Render proxy — required for express-rate-limit behind a load balancer
app.set('trust proxy', 1);

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
// On Vercel/serverless the filesystem is read-only — skip directory creation
try {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (_) {
  // read-only filesystem (Vercel) — uploads not supported, skip silently
}

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());

// Periodic cache cleanup - evicts expired entries every 10 minutes
const { previewCache } = require('./services/enrich');
const { userCache, managerCache } = require('./middleware/humhubAuth');

setInterval(() => {
  const { likesCache } = require('./controllers/social.controller');
  for (const cache of [previewCache, userCache, managerCache, likesCache]) {
    if (cache && typeof cache.cleanup === 'function') cache.cleanup();
  }
}, 10 * 60 * 1000).unref();

// CORS : sans objet pour React Native, qui n'applique pas la politique
// d'origine. Restreint tout de mÃªme si CORS_ORIGINS est dÃ©fini, pour le jour oÃ¹
// un client web consommera cette API.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 5000,
  standardHeaders: true,
  legacyHeaders: false,
  // Use X-Forwarded-For to identify real clients behind Railway/Vercel proxy
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
}));

// Limite plus stricte sur la connexion : protÃ¨ge aussi le formulaire web.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' },
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
});

app.use(logNotificationRequests);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/uploads', express.static(UPLOAD_DIR));

// Root endpoint
app.get('/', (_req, res) => res.json({ app: 'eMajlis API', version: '1.0.0', status: 'running' }));

// Privacy Policy — public, no auth required
app.get('/privacy', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'privacy-policy.html'));
});

// Simple test endpoint
app.get('/ping', (_req, res) => res.json({ message: 'Hello World 👋', status: 'ok', time: new Date().toISOString() }));

app.get('/health', (_req, res) => {
  const { feedCache, contentCache, staticCache } = require('./services/advancedCache');
  const { userCache, managerCache } = require('./middleware/humhubAuth');
  const { previewCache } = require('./services/enrich');
  
  res.json({
    status: 'ok',
    app: 'eMajlis API',
    humhub: HUMHUB_BASE,
    tls: tlsStatus(),
    time: new Date().toISOString(),
    caches: {
      feed: feedCache.getStats(),
      content: contentCache.getStats(),
      static: staticCache.getStats(),
      user: { size: userCache.size },
      manager: { size: managerCache.size },
      preview: { size: previewCache.size },
    },
    memory: {
      rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`,
    },
  });
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth', authRoutes);

// Nouvelles routes â€” relais fidÃ¨les vers HumHub
app.use('/api/feed', feedRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/drive', driveRoutes);
const { requireAuth: requireAuthMiddleware } = require('./middleware/humhubAuth');
const driveCtrl = require('./controllers/drive.controller');
app.get('/api/cfiles/file/:id/download', requireAuthMiddleware, driveCtrl.downloadCfile);
app.get('/api/cfiles/file/:id/thumbnail', requireAuthMiddleware, driveCtrl.thumbnailCfile);
app.head('/api/cfiles/file/:id/thumbnail', requireAuthMiddleware, driveCtrl.thumbnailCfile);
app.get('/api/cfiles/file/:id/token', requireAuthMiddleware, driveCtrl.cfileToken);
app.get('/api/cfiles/file/:id/stream', driveCtrl.cfileStream); // no auth — uses signed token
app.use('/api/spaces', spaceRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/likes', likeRoutes);
app.use('/api/eservices', eservicesRoutes);


app.use('/api/membres', membresRoutes);
app.use('/api/calendar', calendarRoutes);


const axios = require('axios');
const DEFAULT_HOSTS = ['emajlis-info.csefrs.ma', 'emajlis-dev.csefrs.ma', 'emajlis.csefrs.ma', 'www.csefrs.ma', 'csefrs.ma'];
const ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS || DEFAULT_HOSTS.join(','))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

app.get('/api/proxy-html', requireAuth, async (req, res) => {
  const { url } = req.query;

  let target;
  try {
    target = new URL(String(url));
  } catch (_) {
    return res.status(400).json({ error: 'URL invalide.' });
  }

  if (target.protocol !== 'https:') {
    return res.status(400).json({ error: 'Seul le protocole HTTPS est acceptÃ©.' });
  }
  if (!ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) {
    return res.status(403).json({
      error: 'Domaine non autorisÃ©.',
      allowed: ALLOWED_HOSTS,
    });
  }

  try {
    const { data } = await axios.get(target.toString(), {
      timeout: 15000,
      maxRedirects: 0,
      responseType: 'text',
      
      httpsAgent,
      headers: { 'User-Agent': 'eMajlis-Mobile/1.0' },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    res.json({ html: data, url: target.toString() });
  } catch (err) {
    res.status(502).json({ error: 'Impossible de charger le contenu.', detail: err.message });
  }
});

// ── Canvas / pdfjs diagnostic (no auth needed) ───────────────────────────────
app.get('/canvas-test', async (req, res) => {
  const results = {};
  try {
    const c = require('@napi-rs/canvas');
    const cv = c.createCanvas(10, 10);
    cv.getContext('2d');
    results.canvas = '@napi-rs/canvas OK';
  } catch(e) { results.canvas = `FAIL: ${e.message}`; }
  try {
    const p = require('pdfjs-dist/legacy/build/pdf.js');
    results.pdfjs = `pdfjs OK v${p.version || 'unknown'}`;
  } catch(e) { results.pdfjs = `FAIL: ${e.message}`; }
  res.json(results);
});

app.use((req, res) =>
  res.status(404).json({ error: `Route non trouvÃ©e : ${req.method} ${req.path}` }),
);

app.use(errorHandler);

// Start server locally; export app for Vercel/serverless
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('eMajlis API running on port ' + PORT);
    console.log('HumHub: ' + HUMHUB_BASE);
  });
}

module.exports = app;
