#!/usr/bin/env node

/**
 * Generates a valid JWT for load testing.
 * 
 * Usage:
 *   node tests/load/generate-token.js
 *   
 * Or inline:
 *   TEST_TOKEN=$(node tests/load/generate-token.js) k6 run tests/load/thundering-herd.js
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';

const payload = {
  userId: '00000000-0000-4000-a000-000000000001',
  id: '00000000-0000-4000-a000-000000000001',
  username: 'load-test-bot',
  email: 'loadtest@torrentedge.internal',
  role: 'admin',
};

const token = jwt.sign(payload, secret, { expiresIn: '1h' });

// Print only the token so it can be captured by $(...)
process.stdout.write(token);
