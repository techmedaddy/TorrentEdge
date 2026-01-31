const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const authController = require('../controllers/authController');

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

// Helper function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// POST /api/auth/google - Handle Google OAuth token from frontend
router.post('/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ message: 'Google credential is required' });
  }

  try {
    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    logger.info(`Google auth attempt for: ${email}`);

    // Check if user exists by googleId
    let user = await User.findOne({ googleId });

    if (!user) {
      // Check if user exists by email (link accounts)
      user = await User.findOne({ email });

      if (user) {
        // Link Google to existing account
        user.googleId = googleId;
        user.avatar = picture;
        user.authProvider = user.authProvider === 'local' ? 'local' : 'google';
        await user.save();
        logger.info(`Linked Google account to existing user: ${email}`);
      } else {
        // Create new user
        const username = email.split('@')[0] + '_' + Math.random().toString(36).slice(-4);
        user = new User({
          username,
          email,
          googleId,
          avatar: picture,
          authProvider: 'google'
        });
        await user.save();
        logger.info(`Created new Google user: ${email}`);
      }
    }

    // Generate JWT
    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        authProvider: user.authProvider
      }
    });

  } catch (error) {
    logger.error('Google auth error:', error);
    res.status(401).json({ message: 'Invalid Google token' });
  }
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
