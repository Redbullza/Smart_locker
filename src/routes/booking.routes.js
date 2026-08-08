const express = require('express');
const {
  createBooking,
  myBookings,
  allBookings,
  releaseBooking,
} = require('../controllers/booking.controller');

const router = express.Router();

router.post('/booking', createBooking);
router.get('/my-bookings', myBookings);
router.get('/bookings', allBookings);
router.put('/bookings/:id/release', releaseBooking);

module.exports = router;
