'use strict';

const express = require('express');
const router  = express.Router();

const calCtrl        = require('../controllers/calendar.controller');
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/humhubAuth');

// Public read
router.get('/',         optionalAuth, calCtrl.list);
router.get('/events',   optionalAuth, calCtrl.list);
router.get('/:id',      optionalAuth, calCtrl.show);

// RSVP — requires auth (user must be logged in to respond)
router.post('/:id/respond', requireAuth, calCtrl.respond);

// Admin write
router.post('/',        requireAdmin, calCtrl.create);
router.put('/:id',      requireAdmin, calCtrl.update);
router.delete('/:id',   requireAdmin, calCtrl.destroy);

module.exports = router;
