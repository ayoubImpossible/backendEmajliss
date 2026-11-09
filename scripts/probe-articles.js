'use strict';
/**
 * Décrit comment HumHub expose les articles du Journal (MajlissPost / ImportArticle).
 *
 *   node scripts/probe-articles.js
 *
 * Demande l'identifiant et le mot de passe dans le terminal (le mot de passe
 * n'est pas affiché). Rien n'est enregistré : ni mot de passe, ni jeton.
 * Écrit scripts/probe-articles-output.json : la structure des réponses
 * (noms de champs, types, longueurs, débuts de texte), pas les contenus complets.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { http, asUser, BASE, httpsAgent } = require('../src/services/humhub');
const axios = require('axios');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

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

const MODELS = {
  MajlissPost: 'humhub\\modules\\externalHtmlStream\\models\\MajlissPost',
  ImportArticle: 'humhub\\modules\\import_article\\models\\ImportArticle',
};

(async () => {
  const username = await ask('Identifiant HumHub : ');
  const password = await ask('Mot de passe : ', true);
  const { data } = await http.post('/auth/login', { username, password }, { timeout: 15000 });
  const token = data?.auth_token;
  if (!token) { console.error('Connexion refusée.'); process.exit(1); }
  console.log('Connecté. Interrogation des articles…');

  const out = { date: new Date().toISOString() };
  for (const [name, model] of Object.entries(MODELS)) {
    const feed = await get('/emajlis/feed', token, { contentType: model, limit: 2, page: 1 });
    const item = (feed.raw?.results || [])[0] || null;
    const entry = { feed: { status: feed.status, body: feed.body, error: feed.error } };
    if (item) {
      const contentId = item.id;
      const objectId = item.metadata?.object_id;
      entry.ids = { contentId, objectId, url: item.metadata?.url || null };
      const content = await get(`/content/${contentId}`, token);
      entry.content = { status: content.status, body: content.body, error: content.error };
      if (objectId != null) {
        const viaRevue = await get(`/emajlis/revue-presse/${objectId}`, token);
        entry.revueRouteWithObjectId = { status: viaRevue.status, contentType: viaRevue.contentType, body: viaRevue.body, error: viaRevue.error };
      }
    }
    out[name] = entry;
  }

  // Page web du module « Import article » : accepte-t-elle le jeton de l'API ?
  for (const page of ['/import-article/index/index']) {
    try {
      const r = await axios.get(`${BASE}${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/html,application/json' },
        httpsAgent, maxRedirects: 0, timeout: 30000, validateStatus: () => true,
      });
      const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      out[`webPage ${page}`] = {
        status: r.status,
        redirect: r.headers.location || null,
        contentType: r.headers['content-type'],
        length: body.length,
        isLoginPage: /user\/auth\/login|login-form/i.test(body),
        start: body.replace(/\s+/g, ' ').slice(0, 400),
        articleLinks: [...new Set((body.match(/href="[^"]*import-article[^"]*"/gi) || []))].slice(0, 10),
      };
    } catch (e) {
      out[`webPage ${page}`] = { error: e.message };
    }
  }

  const file = path.join(__dirname, 'probe-articles-output.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Terminé : ${file}`);
})().catch((e) => { console.error('Erreur :', e.response?.status || e.message); process.exit(1); });
