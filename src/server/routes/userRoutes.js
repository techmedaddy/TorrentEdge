const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');

// GET /api/user/profile - Get current user's profile (protected)
router.get('/profile', authMiddleware, userController.getUserProfile);

// PUT /api/user/profile - Update current user's profile (protected)
router.put('/profile', authMiddleware, userController.updateUserProfile);

// PUT /api/user/password - Change password (protected)
router.put('/password', authMiddleware, userController.changePassword);

module.exports = router;
