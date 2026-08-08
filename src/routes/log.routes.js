const express = require('express');
const { listLogs, dashboard } = require('../controllers/log.controller');

const router = express.Router();

router.get('/logs', listLogs);
router.get('/dashboard', dashboard);

module.exports = router;
