#!/usr/bin/env node

/**
 * Generates a valid JWT and seeds the test user into PostgreSQL.
 *
 * The test user MUST exist in the users table before running the
 * thundering herd test, because transfers.uploaded_by has a FK
 * constraint that references users.id.
 *
 * Usage (token to stdout, seed logs to stderr):
 *   node tests/load/generate-token.js
 *
 * Inline capture for k6:
 *   TEST_TOKEN=$(node tests/load/generate-token.js) k6 run tests/load/thundering-herd.js
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');

const TEST_USER = {
  id: '00000000-0000-4000-a000-000000000001',
  username: 'load-test-bot',
  email: 'loadtest@torrentedge.internal',
  role: 'admin',
  auth_provider: 'local',
  password: 'load-test-password-not-used',
};

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';

async function seedUserAndGenerateToken() {
  let sequelize = null;

  try {
    // ── Seed the test user ──────────────────────────────────────────────
    const { sequelize: sq } = require('./../../src/server/db/sql');
    sequelize = sq;

    await sequelize.authenticate();

    // Raw SQL upsert: insert the user if it doesn't exist.
    // Using raw query to bypass Sequelize's bcrypt beforeSave hook
    // (we don't need a real password hash for a test user).
    await sequelize.query(`
      INSERT INTO users (id, username, email, password, role, auth_provider, created_at, updated_at)
      VALUES (
        '${TEST_USER.id}',
        '${TEST_USER.username}',
        '${TEST_USER.email}',
        '$2b$10$invalidhashforloadtestingonly000000000000000000000000000',
        '${TEST_USER.role}',
        '${TEST_USER.auth_provider}',
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    process.stderr.write(`[setup] Test user seeded: ${TEST_USER.email} (${TEST_USER.id})\n`);

    await sequelize.close();
  } catch (err) {
    process.stderr.write(`[setup] WARN: Could not seed test user: ${err.message}\n`);
    process.stderr.write('[setup] Continuing anyway — user may already exist.\n');
    if (sequelize) {
      await sequelize.close().catch(() => {});
    }
  }

  // ── Generate JWT ────────────────────────────────────────────────────────
  const payload = {
    userId: TEST_USER.id,
    id: TEST_USER.id,
    username: TEST_USER.username,
    email: TEST_USER.email,
    role: TEST_USER.role,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });

  // ONLY the token on stdout — everything else goes to stderr
  // This ensures $(node generate-token.js) captures only the JWT
  process.stdout.write(token);
}

seedUserAndGenerateToken().catch((err) => {
  process.stderr.write(`[setup] FATAL: ${err.message}\n`);
  process.exit(1);
});
