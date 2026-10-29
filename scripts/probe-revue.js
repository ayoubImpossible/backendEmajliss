'use strict';
/**
 * Décrit la forme des réponses de la route HumHub /emajlis/revue-presse.
 *
 *   node scripts/probe-revue.js
 *
 * Demande l'identifiant et le mot de passe dans le terminal (le mot de passe
 * n'est pas affiché). Rien n'est enregistré : ni mot de passe, ni jeton.
 * Écrit scripts/probe-revue-output.json : la structure des réponses (noms de
 * champs, types, longueurs, débuts de texte), pas les contenus complets.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { http, asUser } = require('../src/services/humhub');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

/** Résumé de structure : types, longueurs, 160 premiers caractères. */
function shape(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return { _array: v.length, first: v.length ? shape(v[0], depth + 1) : null };
  if (typeof v === 'object') {
    if (depth > 5) return '{…}';
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shape(val, depth + 1);
    return o;
  }
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, ' ');
    return s.length > 160 ? `string(${v.length}) ${s.slice(0, 160)}…` : s;
  }
  return v;
}

async function get(url, token, params) {
  try {
    const r = await http.get(url, { ...asUser(token), params, timeout: 30000 });
    return { status: r.status, contentType: r.headers['content-type'], body: shape(r.data), raw: r.data };
  } catch (err) {
    return { status: err.response?.status || err.code, error: shape(err.response?.data || err.message) };
  }
}

(async () => {
  const username = await ask('Identifiant HumHub : ');
  const password = await ask('Mot de passe : ', true);
  const { data } = await http.post('/auth/login', { username, password }, { timeout: 15000 });
  const token = data?.auth_token;
  if (!token) { console.error('Connexion refusée.'); process.exit(1); }
  console.log('Connecté. Interrogation de la route…');

  const out = { date: new Date().toISOString(), base: http.defaults.baseURL };
  const list = await get('/emajlis/revue-presse', token, { page: 1 });
  out.list = { status: list.status, contentType: list.contentType, body: list.body, error: list.error };

  // Premier élément de la liste, quelle que soit la clé qui le porte.
  const raw = list.raw || {};
  const items = Array.isArray(raw) ? raw : (raw.results || raw.items || raw.data || raw.revues || []);
  const first = items[0] || {};
  const id = first.id ?? first.revue_id ?? first.object_id ?? first.objectId;
  out.firstId = id ?? null;
  if (id != null) {
    const one = await get(`/emajlis/revue-presse/${id}`, token);
    out.detail = { status: one.status, contentType: one.contentType, body: one.body, error: one.error };
  }

  // Comment une revue apparaît dans le fil (pour relier le fil au lecteur).
  const search = await get('/emajlis/search', token, { q: 'Revue de presse', limit: 3 });
  out.searchSample = { status: search.status, body: search.body, error: search.error };

  const file = path.join(__dirname, 'probe-revue-output.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Terminé : ${file}`);
  console.log(`liste HTTP ${out.list.status}, détail HTTP ${out.detail?.status ?? '—'}`);
})().catch((e) => { console.error('Erreur :', e.response?.status || e.message); process.exit(1); });
