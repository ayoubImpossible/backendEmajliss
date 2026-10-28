'use strict';

const express = require('express');
const ctrl = require('../controllers/files.controller');
const { requireAuth } = require('../middleware/humhubAuth');

const router = express.Router();

router.post('/ticket', requireAuth, ctrl.createTicket);
// Pas d'en-tête d'authentification : la visionneuse utilise le ticket opaque.
router.get('/view/:ticket', ctrl.view);
router.head('/view/:ticket', ctrl.view);

module.exports = router;
