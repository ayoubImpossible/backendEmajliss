'use strict';
/**
 * Test de bout en bout de l'API Express (Railway par défaut) avec un vrai compte.
 *
 *   node scripts/test-e2e.js                 → https://backendemajliss-production.up.railway.app
 *   node scripts/test-e2e.js http://localhost:3000
 *
 * L'identifiant et le mot de passe sont demandés dans le terminal (le mot de
 * passe n'est pas affiché). Rien n'est enregistré : ni mot de passe, ni jeton.
 * Affiche une ligne OK / ÉCHEC par fonction, sans aucun contenu personnel.
 */

const readline = require('readline');
const BASE = (process.argv[2] || 'https://backendemajliss-production.up.railway.app').replace(/\/+$/, '');

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

let token = null;
const results = [];
async function call(method, path, body, { raw = false, headers = {} } = {}) {
  const t = Date.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t;
  if (raw) return { status: r.status, ms, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, ms, json, text };
}
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'OK    ' : 'ÉCHEC '} ${name.padEnd(42)} ${detail}`);
}
async function step(name, fn) {
  try { await fn(); } catch (e) { record(name, false, `erreur : ${e.message}`); }
}

const IA = 'humhub\\modules\\import_article\\models\\ImportArticle';
const DF = 'humhub\\modules\\driveManager\\models\\DriveFile';

(async () => {
  console.log(`API testée : ${BASE}\n`);
  // E2E_USER / E2E_PASS : réservés aux essais sur un serveur de test local.
  const username = process.env.E2E_USER || await ask('Identifiant HumHub : ');
  const password = process.env.E2E_PASS || await ask('Mot de passe : ', true);

  await step('Connexion', async () => {
    const r = await call('POST', '/api/auth/login', { username, password });
    token = r.json?.token || null;
    record('Connexion', r.status === 200 && !!token, `HTTP ${r.status} (${r.ms} ms)`);
  });
  if (!token) { console.log('\nConnexion impossible : arrêt.'); process.exit(1); }

  await step('Profil (/auth/me)', async () => {
    const r = await call('GET', '/api/auth/me');
    record('Profil (/auth/me)', r.status === 200 && !!r.json?.data?.id, `HTTP ${r.status}`);
  });

  let feed = [];
  await step("Fil d'actualité", async () => {
    const r = await call('GET', '/api/feed?page=1&limit=10');
    feed = r.json?.results || [];
    const generic = feed.filter((i) => /^Article du Journal$|^Publication$/.test(i.title)).length;
    record("Fil d'actualité", r.status === 200 && feed.length > 0, `HTTP ${r.status}, ${feed.length} éléments, ${generic} sans vrai titre (${r.ms} ms)`);
  });

  let articles = [];
  await step('Journal : liste des articles', async () => {
    const r = await call('GET', `/api/feed?page=1&limit=5&contentType=${encodeURIComponent(IA)}`);
    articles = (r.json?.results || []).filter((a) => a.type === 'article');
    const withTitle = articles.filter((a) => a.title && a.title !== 'Article du Journal').length;
    const withImage = articles.filter((a) => a.imageUrl).length;
    record('Journal : liste des articles', r.status === 200 && articles.length > 0 && withTitle === articles.length,
      `${articles.length} articles, ${withTitle} avec titre, ${withImage} avec image`);
  });

  await step('Journal : article complet', async () => {
    const a = articles[0];
    if (!a) return record('Journal : article complet', false, 'aucun article dans le fil');
    const r = await call('GET', `/api/content/${a.id}?title=${encodeURIComponent(a.title || '')}`);
    const len = (r.json?.body || '').length;
    record('Journal : article complet', r.status === 200 && r.json?.bodyFormat === 'html' && len > 200,
      `HTTP ${r.status}, ${r.json?.bodyFormat}, ${len} caractères de HTML`);
  });

  let revues = [];
  await step('Revues de presse : liste', async () => {
    const r = await call('GET', '/api/revue-presse?page=1&limit=5');
    revues = r.json?.results || [];
    const dated = revues.filter((x) => x.date).length;
    record('Revues de presse : liste', r.status === 200 && revues.length > 0, `HTTP ${r.status}, ${revues.length} revues, ${dated} datées`);
  });

  await step('Revues de presse : revue complète', async () => {
    const x = revues[0];
    if (!x) return record('Revues de presse : revue complète', false, 'aucune revue');
    const r = await call('GET', `/api/revue-presse/${x.id}`);
    const len = (r.json?.html || '').length;
    record('Revues de presse : revue complète', r.status === 200 && len > 300, `HTTP ${r.status}, ${len} caractères de HTML`);
  });

  await step('Espaces', async () => {
    const r = await call('GET', '/api/spaces?page=1&limit=50');
    const n = (r.json?.results || []).length;
    record('Espaces', r.status === 200 && n > 0, `HTTP ${r.status}, ${n} espaces`);
  });

  let docs = [];
  await step('Documents récents', async () => {
    const r = await call('GET', `/api/feed?page=1&limit=10&contentType=${encodeURIComponent(DF)}`);
    docs = (r.json?.results || []).filter((d) => d.type === 'drive_file');
    record('Documents récents', r.status === 200 && docs.length > 0, `HTTP ${r.status}, ${docs.length} fichiers`);
  });

  await step('Ouverture d\'un document (ticket)', async () => {
    const d = docs[0];
    if (!d) return record('Ouverture d\'un document (ticket)', false, 'aucun document');
    const r = await call('POST', '/api/files/ticket', { source: 'drive', id: String(d.objectId), filename: d.extra?.filename || '' });
    if (r.status !== 200) return record('Ouverture d\'un document (ticket)', false, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
    record('Ouverture d\'un document (ticket)', true, `type ${r.json.kind} (${r.json.originalKind}), ${r.json.filename?.split('.').pop()}`);
    const v = await call('GET', new URL(r.json.viewUrl).pathname + new URL(r.json.viewUrl).search, null, { raw: true, headers: {} });
    const isPdf = v.buf.subarray(0, 5).toString() === '%PDF-';
    record('Lecture du document', v.status === 200 && (r.json.kind !== 'pdf' || isPdf), `HTTP ${v.status}, ${v.buf.length} octets${r.json.kind === 'pdf' ? (isPdf ? ', PDF valide' : ', PAS un PDF') : ''} (${v.ms} ms)`);
  });

  await step('Miniature d\'un document', async () => {
    const d = docs[0];
    if (!d?.extra?.thumbnailPath) return record('Miniature d\'un document', false, 'pas de chemin de miniature');
    let r;
    for (let i = 0; i < 6; i += 1) {
      r = await call('GET', d.extra.thumbnailPath, null, { raw: true });
      if (r.status !== 202) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    record('Miniature d\'un document', r.status === 200 && /image/.test(r.headers.get('content-type') || ''), `HTTP ${r.status}, ${r.buf.length} octets`);
  });

  await step('Pièce jointe (cfile)', async () => {
    const withFile = feed.find((i) => (i.files || []).length > 0) || articles.find((i) => (i.files || []).length > 0);
    if (!withFile) return record('Pièce jointe (cfile)', true, 'aucune pièce jointe dans les 10 derniers éléments (non testé)');
    const f = withFile.files[0];
    const r = await call('POST', '/api/files/ticket', { source: 'cfile', id: String(f.id), filename: f.file_name || '' });
    record('Pièce jointe (cfile)', r.status === 200, `HTTP ${r.status}${r.status === 200 ? `, ${r.json.kind}` : ' ' + r.text.slice(0, 80)}`);
  });

  for (const [name, path, check] of [
    ['Agenda', '/api/feed/calendar?page=1', (j) => Array.isArray(j?.results)],
    ['Notifications', '/api/feed/notifications?page=1', (j) => Array.isArray(j?.results)],
    ['Notifications non lues', '/api/feed/notifications/unseen', (j) => j && ('count' in j || 'unseen' in j || 'total' in j)],
    ['Recherche', '/api/feed/search?q=conseil', (j) => Array.isArray(j?.results)],
    ['E-Services : catalogue', '/api/eservices/catalog', (j) => !!j],
    ['E-Services : mes demandes', '/api/eservices/requests', (j) => !!j],
    ['Notifications push : état', '/api/push/status', (j) => j?.available === true],
  ]) {
    await step(name, async () => {
      const r = await call('GET', path);
      record(name, r.status === 200 && check(r.json), `HTTP ${r.status} (${r.ms} ms)`);
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK${failed.length ? ' — à corriger : ' + failed.map((f) => f.name).join(', ') : ''}`);
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
