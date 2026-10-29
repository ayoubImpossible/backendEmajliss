'use strict';

const express = require('express');
const ctrl = require('../controllers/revuePresse.controller');
const { requireAuth } = require('../middleware/humhubAuth');

const router = express.Router();

router.get('/', requireAuth, ctrl.list);
router.get('/:id', requireAuth, ctrl.show);

module.exports = router;
