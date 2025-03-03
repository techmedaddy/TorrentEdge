// src/server/routes/authRoutes.js

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User'); // Import the User model
const { body, validationResult } = require('express-validator'); // Import express-validator

// POST /api/auth/login
router.post(
  '/login',
  [
    body('username').notEmpty().withMessage('Username is required.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password } = req.body;

    try {
      // Log the incoming request (excluding password for security)
      logger.info(`Login attempt for username: ${username}`);

      // Find the user in the database by username
      const user = await User.findOne({ username });

      if (!user) {
        logger.warn(`User not found: ${username}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      // Compare the provided password with the hashed password
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        logger.warn(`Invalid password attempt for user: ${username}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      // Generate JWT Token
      const token = jwt.sign(
        { userId: user._id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      logger.info(`User authenticated successfully: ${username}`);

      res.json({ token });
    } catch (error) {
      logger.error('Login Error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;
