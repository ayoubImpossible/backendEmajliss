'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/space.controller');
const feedCtrl = require('../controllers/feed.controller');
const { requireAuth } = require('../middleware/humhubAuth');

// Proxy image de profil — AVANT /:id pour ne pas etre capture par la route generique.
router.get('/user-image/:userId', requireAuth, ctrl.userImage);

// Liste et detail : relais direct vers HumHub (17 espaces reels).
router.get('/', requireAuth, feedCtrl.getSpaces);
router.get('/:id', requireAuth, feedCtrl.getSpace);
// Membres reels de l'espace.
router.get('/:id/members', requireAuth, ctrl.members);
// Pages personnalisees.
router.get('/:containerId/pages', requireAuth, ctrl.pages);
// Modules actives.
router.get('/:containerId/modules', requireAuth, ctrl.modules);
// Fil de l'espace.
router.get('/:containerId/feed', requireAuth, feedCtrl.getSpaceFeed);

module.exports = router;