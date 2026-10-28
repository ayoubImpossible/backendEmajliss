'use strict';

/**
 * Gestionnaire d'erreurs global.
 * Les erreurs 5xx ne renvoient jamais le message interne au client.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fichier trop volumineux.' });
  }

  // Erreur HumHub relayée : on garde son statut, pas ses détails.
  const upstream = err.response?.status;
  const status = err.status || err.statusCode || (upstream && upstream >= 400 && upstream < 500 ? upstream : 500);

  if (status >= 500) {
    console.error('[Error]', req.method, req.originalUrl.replace(/\/api\/files\/view\/[^?/]+/, '/api/files/view/…'), err.stack || err.message);
    return res.status(status).json({ error: 'Erreur serveur interne.' });
  }
  return res.status(status).json({ error: err.expose === false ? 'Requête refusée.' : (err.message || 'Requête refusée.') });
}

module.exports = { errorHandler };
