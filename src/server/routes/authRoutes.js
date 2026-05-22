const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { User } = require('../models/sql');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const authController = require('../controllers/authController');

// Create logger first (before using it)
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

// Google OAuth client
if (!process.env.GOOGLE_CLIENT_ID) {
  logger.warn('GOOGLE_CLIENT_ID not found in environment variables. Google login may fail.');
}
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, username: user.username, email: user.email },
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
    let user = await User.findOne({ where: { google_id: googleId } });

    if (!user) {
      // Check if user exists by email (link accounts)
      user = await User.findOne({ where: { email } });

      if (user) {
        // Link Google to existing account
        user.google_id = googleId;
        user.avatar = picture;
        user.auth_provider = user.auth_provider === 'local' ? 'local' : 'google';
        await user.save();
        logger.info(`Linked Google account to existing user: ${email}`);
      } else {
        // Create new user
        const username = email.split('@')[0] + '_' + Math.random().toString(36).slice(-4);
        user = await User.create({
          username,
          email,
          google_id: googleId,
          avatar: picture,
          auth_provider: 'google'
        });
        logger.info(`Created new Google user: ${email}`);
      }
    }

    // Generate JWT
    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        authProvider: user.auth_provider
      }
    });

  } catch (error) {
    logger.error('Google auth error:', error);
    
    // Check for specific Google Auth errors
    if (error.message && error.message.includes('wrong number of segments')) {
      return res.status(400).json({ 
        message: 'Malformed Google credential format.',
        details: error.message 
      });
    }

    if (error.message && error.message.includes('Token used too late')) {
      return res.status(401).json({ 
        message: 'Google token expired. Please sign in again.',
        details: error.message 
      });
    }

    res.status(401).json({ 
      message: 'Google authentication failed.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

      const user = await User.findOne({ where: { email } });

      if (!user) {
        logger.warn(`User not found: ${email}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      const isMatch = await user.comparePassword(password);

      if (!isMatch) {
        logger.warn(`Invalid password for user: ${email}`);
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      const token = jwt.sign(
        { userId: user.id, username: user.username, email: user.email },
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
