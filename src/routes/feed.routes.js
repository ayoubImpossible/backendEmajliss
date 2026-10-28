'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/feed.controller');
const { requireAuth } = require('../middleware/humhubAuth');

router.get('/', requireAuth, ctrl.getFeed);

// La route la plus spécifique d'abord : /search/types avant /search.
router.get('/search/types', requireAuth, ctrl.searchTypes);
router.get('/search', requireAuth, ctrl.search);

router.get('/spaces', requireAuth, ctrl.getSpaces);
router.get('/spaces/:id', requireAuth, ctrl.getSpace);
router.get('/spaces/:containerId/feed', requireAuth, ctrl.getSpaceFeed);

router.get('/notifications', requireAuth, ctrl.getNotifications);
router.get('/notifications/unseen', requireAuth, ctrl.getUnseenCount);
router.patch('/notifications/seen', requireAuth, ctrl.markSeen);

router.get('/calendar', requireAuth, ctrl.getCalendar);

module.exports = router;
