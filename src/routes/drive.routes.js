'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/drive.controller');
const { requireAuth } = require('../middleware/humhubAuth');

// Ordre important : les chemins les plus spécifiques d'abord.
router.get('/settings/container/:containerId', requireAuth, ctrl.settings);
router.post('/container/:containerId/folder', requireAuth, ctrl.createFolder);
router.get('/container/:containerId', requireAuth, ctrl.browse);
router.get('/folder/:id', requireAuth, ctrl.folder);
router.get('/file/:id/download', requireAuth, ctrl.download);
router.get('/file/:id/thumbnail', requireAuth, ctrl.thumbnail);
router.head('/file/:id/thumbnail', requireAuth, ctrl.thumbnail);
router.get('/file/:id', requireAuth, ctrl.file);

module.exports = router;