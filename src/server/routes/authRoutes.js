const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const authController = require('../controllers/authController');

// Re-create the same logger used in server.js
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// POST /api/auth/register
router.post(
  '/register',
  [
    body('username').notEmpty().withMessage('Username is required.'),
    body('email').isEmail().withMessage('Valid email is required.'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    return authController.register(req, res);
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      logger.info(`Login attempt for email: ${email}`);

      const user = await User.findOne({ email });

      if (!user) {
        logger.warn(`User not found: ${email}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        logger.warn(`Invalid password for user: ${email}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      const token = jwt.sign(
        { userId: user._id, username: user.username, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      logger.info(`User authenticated successfully: ${email}`);

      res.json({ token });

    } catch (error) {
      logger.error('Login Error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;
