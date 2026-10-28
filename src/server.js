'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');

const { errorHandler } = require('./middleware/errorHandler');
const { requireAuth, userCache, managerCache } = require('./middleware/humhubAuth');
const { BASE: HUMHUB_BASE, httpsAgent } = require('./services/humhub');
const { previewCache } = require('./services/enrich');
const { registerServer, setupShutdownHandlers } = require('./shutdown');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Railway / proxy : req.ip est l'adresse réelle du client (X-Forwarded-For
// interprété par Express, pas lu à la main — un client ne peut pas le falsifier).
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());

// Nettoyage périodique des caches en mémoire.
setInterval(() => {
  const { likesCache } = require('./controllers/social.controller');
  for (const cache of [previewCache, userCache, managerCache, likesCache]) {
    if (cache && typeof cache.cleanup === 'function') cache.cleanup();
  }
}, 10 * 60 * 1000).unref();

// CORS : l'application mobile n'en a pas besoin. Seules les origines
// déclarées dans CORS_ORIGINS (site web éventuel) sont autorisées.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
}));

app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 5000,
  standardHeaders: true,
  legacyHeaders: false,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' },
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Journal des requêtes : les tickets de fichiers ne sont pas journalisés.
morgan.token('safe-url', (req) => req.originalUrl.replace(/(\/api\/files\/view\/)[^?/]+/, '$1…'));
app.use(morgan(IS_PROD
  ? ':remote-addr ":method :safe-url" :status :res[content-length] - :response-time ms'
  : ':method :safe-url :status :response-time ms'));

app.get('/', (_req, res) => res.json({ app: 'eMajlis API', status: 'running' }));

app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));

app.get('/ping', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Santé : rien d'interne (adresse HumHub, mémoire) n'est exposé publiquement.
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth/login', authLimiter);
app.use('/api/auth', require('./routes/auth.routes'));

app.use('/api/feed', require('./routes/feed.routes'));
app.use('/api/content', require('./routes/content.routes'));
app.use('/api/drive', require('./routes/drive.routes'));
app.use('/api/files', require('./routes/files.routes'));
app.use('/api/push', require('./routes/push.routes'));

// Miniatures de tous les fichiers (Drive et cfiles).
const thumbs = require('./controllers/thumbs.controller');
app.get('/api/thumbs/:source/:id', requireAuth, thumbs.thumb);
app.head('/api/thumbs/:source/:id', requireAuth, thumbs.thumb);

// cfiles : téléchargement, et ancienne adresse de miniature.
const driveCtrl = require('./controllers/drive.controller');
app.get('/api/cfiles/file/:id/download', requireAuth, driveCtrl.downloadCfile);
app.get('/api/cfiles/file/:id/thumbnail', requireAuth, thumbs.legacyCfile);
app.head('/api/cfiles/file/:id/thumbnail', requireAuth, thumbs.legacyCfile);

app.use('/api/spaces', require('./routes/space.routes'));
const { comments: commentRoutes, likes: likeRoutes } = require('./routes/social.routes');
app.use('/api/comments', commentRoutes);
app.use('/api/likes', likeRoutes);
app.use('/api/eservices', require('./routes/eservices.routes'));
app.use('/api/membres', require('./routes/membres.routes'));
app.use('/api/calendar', require('./routes/calendar.routes'));

// Proxy HTML restreint aux domaines du Conseil.
const DEFAULT_HOSTS = ['emajlis-info.csefrs.ma', 'emajlis-dev.csefrs.ma', 'emajlis.csefrs.ma', 'www.csefrs.ma', 'csefrs.ma'];
const ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS || DEFAULT_HOSTS.join(','))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

app.get('/api/proxy-html', requireAuth, async (req, res) => {
  let target;
  try { target = new URL(String(req.query.url)); } catch (_) {
    return res.status(400).json({ error: 'URL invalide.' });
  }
  if (target.protocol !== 'https:') return res.status(400).json({ error: 'Seul le protocole HTTPS est accepté.' });
  if (!ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) return res.status(403).json({ error: 'Domaine non autorisé.' });

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
  } catch (_) {
    res.status(502).json({ error: 'Impossible de charger le contenu.' });
  }
});

app.use((req, res) => res.status(404).json({ error: `Route non trouvée : ${req.method} ${req.path}` }));

app.use(errorHandler);

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`eMajlis API running on port ${PORT}`);
    console.log(`HumHub: ${HUMHUB_BASE}`);
  });
  registerServer(server, httpsAgent);
  setupShutdownHandlers();
  if (process.env.PUSH_ENABLED !== '0') require('./services/pushPoller').start();
}

module.exports = app;
