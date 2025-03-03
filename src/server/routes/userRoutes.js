// src/server/routes/userRoutes.js

const express = require('express');
const router = express.Router();

// Example GET /api/user/profile
router.get('/profile', (req, res) => {
  // Replace this with actual user profile retrieval logic
  res.json({ id: 1, username: 'test', email: 'test@example.com' });
});

module.exports = router;
