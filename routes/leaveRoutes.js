const express = require('express');
const router = express.Router();
const { takeAction } = require('../controllers/leaveAction');
const auth = require('../middleware/auth'); // must set req.user

router.post('/leave/action', auth, takeAction);

module.exports = router;
