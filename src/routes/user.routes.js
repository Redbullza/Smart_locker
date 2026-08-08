const express = require('express');
const { listUsers, updateUserStatus } = require('../controllers/user.controller');

const router = express.Router();

router.get('/users', listUsers);
router.put('/users/:id/status', updateUserStatus);

module.exports = router;
