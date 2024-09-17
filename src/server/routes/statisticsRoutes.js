// src/server/routes/statisticsRoutes.js

const express = require('express');
const router = express.Router();

// Example route for statistics
router.get('/', (req, res) => {
    res.json({ message: 'Statistics data' });
});

module.exports = router;