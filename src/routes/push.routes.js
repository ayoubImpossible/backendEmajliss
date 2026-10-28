'use strict';

/**
 * POST   /api/push/register   { token: 'ExponentPushToken[…]', platform }
 * DELETE /api/push/register   { token }
 * GET    /api/push/status
 */

const express = require('express');
const { requireAuth } = require('../middleware/humhubAuth');
const store = require('../services/pushStore');
const poller = require('../services/pushPoller');

const router = express.Router();
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]{10,}\]$/;

router.post('/register', requireAuth, async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!EXPO_TOKEN.test(token)) return res.status(400).json({ error: 'Jeton Expo invalide.' });
    const lastNotifId = await poller.currentMaxId(req.humhubToken);
    store.upsert({
      expoToken: token,
      userId: req.user.id,
      humhubToken: req.humhubToken,
      platform: String(req.body?.platform || '').slice(0, 20),
      lastNotifId,
    });
    res.json({ registered: true, persistent: store.persistent });
  } catch (err) { next(err); }
});

router.delete('/register', requireAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) store.remove(token);
  res.json({ registered: false });
});

router.get('/status', requireAuth, (req, res) => {
  const mine = store.all().filter((d) => d.userId === req.user.id).length;
  res.json({ available: true, transport: 'expo', devices: mine, persistent: store.persistent });
});

module.exports = router;
