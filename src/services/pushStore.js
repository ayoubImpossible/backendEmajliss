'use strict';

/**
 * Appareils inscrits aux notifications push (Expo).
 *
 * Fichier JSON sur disque : PUSH_STORE_PATH (par défaut ./data/push-devices.json).
 * Sur Railway, montez un volume sur /app/data, sinon les inscriptions sont
 * perdues à chaque redéploiement (les téléphones se réinscrivent alors à
 * l'ouverture de l'application).
 *
 * Le jeton HumHub nécessaire pour interroger les notifications de
 * l'utilisateur est chiffré (AES-256-GCM) avec PUSH_SECRET. Sans cette
 * variable, rien n'est écrit sur disque : les inscriptions restent en mémoire.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.resolve(process.env.PUSH_STORE_PATH || path.join(__dirname, '../../data/push-devices.json'));
const SECRET = process.env.PUSH_SECRET || '';
const KEY = SECRET ? crypto.createHash('sha256').update(SECRET).digest() : null;

/** @type {Map<string, {expoToken:string,userId:any,tokenEnc:string,lastNotifId:number,platform:string,updatedAt:number}>} */
const devices = new Map();
let memoryOnlyTokens = new Map(); // expoToken -> humhubToken quand PUSH_SECRET est absent

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(String(b64), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

function load() {
  if (!KEY) {
    console.warn('[push] PUSH_SECRET absent : inscriptions conservées en mémoire seulement.');
    return;
  }
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const d of list) if (d?.expoToken) devices.set(d.expoToken, d);
    console.log(`[push] ${devices.size} appareil(s) chargé(s).`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[push] lecture ${FILE} impossible : ${err.message}`);
  }
}

let saveTimer = null;
function save() {
  if (!KEY) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...devices.values()]), { mode: 0o600 });
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.warn(`[push] écriture impossible : ${err.message}`);
    }
  }, 500);
}

function upsert({ expoToken, userId, humhubToken, platform, lastNotifId }) {
  const prev = devices.get(expoToken);
  const entry = {
    expoToken,
    userId,
    tokenEnc: KEY ? encrypt(humhubToken) : null,
    lastNotifId: prev && prev.userId === userId ? prev.lastNotifId : (lastNotifId || 0),
    platform: platform || prev?.platform || '',
    updatedAt: Date.now(),
  };
  if (!KEY) memoryOnlyTokens.set(expoToken, humhubToken);
  devices.set(expoToken, entry);
  save();
  return entry;
}

function remove(expoToken) {
  memoryOnlyTokens.delete(expoToken);
  if (devices.delete(expoToken)) save();
}

function removeUser(userId) {
  for (const [k, d] of devices) if (d.userId === userId) { devices.delete(k); memoryOnlyTokens.delete(k); }
  save();
}

function humhubTokenOf(entry) {
  if (!KEY) return memoryOnlyTokens.get(entry.expoToken) || null;
  try { return decrypt(entry.tokenEnc); } catch (_) { return null; }
}

function setLastNotif(expoToken, id) {
  const d = devices.get(expoToken);
  if (d && id > (d.lastNotifId || 0)) { d.lastNotifId = id; save(); }
}

function all() { return [...devices.values()]; }

load();

module.exports = { upsert, remove, removeUser, all, humhubTokenOf, setLastNotif, persistent: !!KEY };
