const express = require('express');
const { verifyPin } = require('../controllers/pin.controller');

const router = express.Router();

router.post('/verify-pin', verifyPin);

module.exports = router;
