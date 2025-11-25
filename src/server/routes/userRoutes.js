const express = require('express');
const router = express.Router();

// GET /api/user/profile
router.get('/profile', (req, res) => {
  res.json({
    id: 1,
    username: 'test',
    email: 'test@example.com',
  });
});

module.exports = router;
