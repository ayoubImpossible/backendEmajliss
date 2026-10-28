'use strict';

/**
 * Envoi des notifications push via Expo.
 *
 * HumHub ne prévient pas l'application : le serveur interroge donc
 * périodiquement /notification pour chaque utilisateur inscrit, et transmet à
 * Expo les notifications non lues apparues depuis le dernier passage.
 * Expo relaie ensuite vers FCM (Android) et APNs (iOS).
 */

const axios = require('axios');
const { http, asUser } = require('./humhub');
const store = require('./pushStore');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const INTERVAL_MS = Math.max(30, Number(process.env.PUSH_POLL_SECONDS) || 60) * 1000;

function plain(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dernières notifications de l'utilisateur (la page 1 : les 10 plus récentes). */
async function latest(token) {
  const { data } = await http.get('/notification', { ...asUser(token), params: { page: 1 }, timeout: 15000 });
  return (data?.results || [])
    .map((n) => ({ id: Number(n.id) || 0, seen: !!n.seen, text: plain(n.output), source: n.source || null }))
    .filter((n) => n.id > 0);
}

async function sendToExpo(messages) {
  const tickets = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const { data } = await axios.post(EXPO_URL, batch, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      timeout: 15000,
    });
    tickets.push(...(data?.data || []));
  }
  return tickets;
}

/** Valeur de départ : on ne renvoie jamais l'historique à l'inscription. */
async function currentMaxId(token) {
  try {
    const list = await latest(token);
    return list.reduce((m, n) => Math.max(m, n.id), 0);
  } catch (_) { return 0; }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    // Un seul appel HumHub par utilisateur, quel que soit son nombre d'appareils.
    const byUser = new Map();
    for (const d of store.all()) {
      const list = byUser.get(d.userId) || [];
      list.push(d);
      byUser.set(d.userId, list);
    }

    const messages = [];
    const owners = [];
    for (const [userId, devs] of byUser) {
      const token = store.humhubTokenOf(devs[0]);
      if (!token) { devs.forEach((d) => store.remove(d.expoToken)); continue; }
      let list;
      try {
        list = await latest(token);
      } catch (err) {
        if (err.response?.status === 401) {
          console.log(`[push] jeton expiré pour l'utilisateur ${userId} : appareils retirés.`);
          store.removeUser(userId);
        }
        continue;
      }
      for (const d of devs) {
        const fresh = list.filter((n) => !n.seen && n.id > (d.lastNotifId || 0)).sort((a, b) => a.id - b.id);
        const maxId = list.reduce((m, n) => Math.max(m, n.id), d.lastNotifId || 0);
        for (const n of fresh.slice(-5)) {
          messages.push({
            to: d.expoToken,
            title: 'eMajlis',
            body: n.text.slice(0, 180) || 'Nouvelle notification',
            sound: 'default',
            channelId: 'default',
            priority: 'high',
            data: { type: 'notification', notificationId: n.id },
          });
          owners.push(d.expoToken);
        }
        store.setLastNotif(d.expoToken, maxId);
      }
    }

    if (messages.length) {
      const tickets = await sendToExpo(messages);
      tickets.forEach((t, i) => {
        if (t?.status === 'error' && t.details?.error === 'DeviceNotRegistered') store.remove(owners[i]);
      });
      console.log(`[push] ${messages.length} notification(s) envoyée(s).`);
    }
  } catch (err) {
    console.warn(`[push] tour d'envoi échoué : ${err.message}`);
  } finally {
    running = false;
  }
}

function start() {
  setInterval(tick, INTERVAL_MS).unref();
  setTimeout(tick, 10000).unref();
  console.log(`[push] interrogation des notifications toutes les ${INTERVAL_MS / 1000} s.`);
}

module.exports = { start, tick, currentMaxId };
