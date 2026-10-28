'use strict';

/**
 * Tickets d'accès aux fichiers : identifiants aléatoires et opaques, valables
 * quelques minutes, conservés en mémoire du serveur.
 *
 * Remplace l'ancien JWT signé qui transportait le jeton HumHub de
 * l'utilisateur en clair dans l'URL (et le transmettait à Google Docs Viewer).
 * Ici l'URL ne contient qu'un nombre aléatoire : le jeton ne quitte jamais le
 * serveur.
 */

const crypto = require('crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX = 5000;
const store = new Map();

function issue(payload) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  const id = crypto.randomBytes(24).toString('base64url');
  store.set(id, { ...payload, expiresAt: Date.now() + TTL_MS });
  return id;
}

function read(id) {
  const t = store.get(String(id || ''));
  if (!t) return null;
  if (Date.now() > t.expiresAt) { store.delete(id); return null; }
  return t;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { issue, read, TTL_MS };
