'use strict';

/**
 * Pièces jointes des formulaires E-Services.
 *
 * Gardées en mémoire, jamais écrites sur un disque public : l'ancien stockage
 * dans /uploads les rendait téléchargeables par n'importe qui, alors qu'elles
 * n'étaient même pas transmises à HumHub.
 */

const multer = require('multer');
const path = require('path');

const MAX_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10) * 1024 * 1024;
const ALLOWED = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 5 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.includes(ext)) cb(null, true);
    else cb(Object.assign(new Error(`Type de fichier non autorisé : ${ext}`), { status: 400 }), false);
  },
});

module.exports = upload;
