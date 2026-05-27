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
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3029/auth/google/callback'
);

// Helper function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

const buildAuthResponse = (user, token) => ({
  token,
  user: {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    authProvider: user.auth_provider
  }
});

const findOrCreateGoogleUser = async ({ googleId, email, picture }) => {
  let user = await User.findOne({ where: { google_id: googleId } });

  if (user) {
    return user;
  }

  user = await User.findOne({ where: { email } });

  if (user) {
    user.google_id = googleId;
    user.avatar = picture;
    user.auth_provider = user.auth_provider === 'local' ? 'local' : 'google';
    await user.save();
    logger.info(`Linked Google account to existing user: ${email}`);
    return user;
  }

  const username = email.split('@')[0] + '_' + Math.random().toString(36).slice(-4);
  user = await User.create({
    username,
    email,
    google_id: googleId,
    avatar: picture,
    auth_provider: 'google'
  });
  logger.info(`Created new Google user: ${email}`);
  return user;
};

const handleGoogleAuthError = (res, error) => {
  logger.error('Google auth error:', error);

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

  return res.status(401).json({
    message: 'Google authentication failed.',
    error: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
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

    const user = await findOrCreateGoogleUser({ googleId, email, picture });

    // Generate JWT
    const token = generateToken(user);

    res.json(buildAuthResponse(user, token));

  } catch (error) {
    return handleGoogleAuthError(res, error);
  }
});

// GET /api/auth/google/redirect - Server-side OAuth 2.0 redirect flow
// Bypasses the GSI iframe button which Chrome can block on http:// origins
router.get('/google/redirect', (req, res) => {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const callbackUrl = (process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3029/auth/google/callback').trim();
  
  console.log('[Google OAuth] Redirect URI being sent:', callbackUrl);
  
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// GET /api/auth/google/callback - Handle Google OAuth callback
router.get('/google/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (oauthError) {
    logger.error(`Google OAuth error: ${oauthError}`);
    return res.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(oauthError)}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}?auth_error=no_code`);
  }

  try {
    const callbackUrl = (process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3029/auth/google/callback').trim();

    // Exchange authorization code for tokens
    const { tokens } = await googleClient.getToken({
      code,
      redirect_uri: callbackUrl,
    });

    // Verify the ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    logger.info(`Google OAuth callback for: ${email}`);

    const user = await findOrCreateGoogleUser({ googleId, email, picture });

    // Generate JWT
    const token = generateToken(user);

    // Redirect back to frontend with token in URL fragment (not query param for security)
    res.redirect(`${frontendUrl}?token=${encodeURIComponent(token)}`);
  } catch (error) {
    logger.error('Google OAuth callback error:', error);
    res.redirect(`${frontendUrl}?auth_error=${encodeURIComponent('Authentication failed')}`);
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
