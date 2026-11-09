'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/drive.controller');
const thumbs = require('../controllers/thumbs.controller');
const { requireAuth } = require('../middleware/humhubAuth');
const multer = require('multer');

// Dépôt : fichiers gardés en mémoire le temps du relais vers HumHub.
const driveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.DRIVE_MAX_FILE_MB, 10) || 100) * 1024 * 1024, files: 10 },
});

// Ordre important : les chemins les plus spécifiques d'abord.
router.get('/settings/container/:containerId', requireAuth, ctrl.settings);
router.post('/container/:containerId/folder', requireAuth, ctrl.createFolder);
router.post('/container/:containerId/upload', requireAuth, driveUpload.array('files', 10), ctrl.upload);
router.get('/container/:containerId', requireAuth, ctrl.browse);
router.get('/folder/:id', requireAuth, ctrl.folder);
router.get('/file/:id/download', requireAuth, ctrl.download);
// Ancienne adresse de miniature (versions installées de l'application).
router.get('/file/:id/thumbnail', requireAuth, thumbs.legacyDrive);
router.head('/file/:id/thumbnail', requireAuth, thumbs.legacyDrive);
router.get('/file/:id', requireAuth, ctrl.file);

module.exports = router;
