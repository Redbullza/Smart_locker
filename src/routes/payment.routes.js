const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const {
  createPaymentSession,
  cancelPaymentSession,
  confirmPaymentSession,
} = require('../controllers/payment.controller');

const router = express.Router();

router.post('/payment-sessions', asyncHandler(createPaymentSession));
router.put('/payment-sessions/:id/cancel', asyncHandler(cancelPaymentSession));
router.post('/payment-sessions/:id/confirm', asyncHandler(confirmPaymentSession));

module.exports = router;
