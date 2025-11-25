const express = require('express');
const router = express.Router();

// GET /api/statistics
router.get('/', (req, res) => {
  res.json({ message: 'Statistics data' });
});

module.exports = router;
