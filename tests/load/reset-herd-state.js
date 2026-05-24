#!/usr/bin/env node

/**
 * Resets the test state between thundering herd runs.
 *
 * Clears:
 *   1. Engine in-memory state (via DELETE API)
 *   2. PostgreSQL transfer record + test user
 *   3. Redis idempotency + lease keys
 *
 * Usage:
 *   node tests/load/reset-herd-state.js
 */

require('dotenv').config();

const TEST_INFO_HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const TEST_REQUEST_ID = 'thundering-herd-test-llama70b-run1';
const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3029';

async function reset() {
  console.log('[Reset] Cleaning up thundering herd test state...\n');

  // ── 0. Purge engine in-memory state via DELETE API ──────────────────────────
  // The DB and Redis reset alone won't clear the engine — it lives in RAM
  // inside the backend process and survives between test runs.
  try {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: TEST_USER_ID, id: TEST_USER_ID },
      process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this',
      { expiresIn: '5m' }
    );

    const { execSync } = require('child_process');
    const cmd = `curl -s -o /dev/null -w "%{http_code}" -X DELETE "${BASE_URL}/api/torrent/${TEST_INFO_HASH}?deleteFiles=false" -H "Authorization: Bearer ${token}"`;
    const status = execSync(cmd, { timeout: 5000 }).toString().trim();
    console.log(`[Reset] Engine: DELETE ${TEST_INFO_HASH.substring(0, 12)} → HTTP ${status}`);
  } catch (err) {
    console.log(`[Reset] Engine purge skipped (non-fatal): ${err.message}`);
  }

  // ── 1. PostgreSQL cleanup ────────────────────────────────────────────────────
  try {
    const { sequelize } = require('../../src/server/db/sql');
    await sequelize.authenticate();

    const [results] = await sequelize.query(
      `DELETE FROM transfers WHERE info_hash = '${TEST_INFO_HASH}' RETURNING id, name`
    );

    if (results.length > 0) {
      console.log(`[Reset] PostgreSQL: Deleted ${results.length} transfer(s):`);
      results.forEach(r => console.log(`  - ${r.id} (${r.name})`));
    } else {
      console.log('[Reset] PostgreSQL: No matching transfers found.');
    }

    // Orphan cleanup
    await sequelize.query(
      `DELETE FROM transfer_leechers WHERE transfer_id NOT IN (SELECT id FROM transfers)`
    ).catch(() => {});

    // Remove the seeded test user
    await sequelize.query(`DELETE FROM users WHERE id = '${TEST_USER_ID}'`);
    console.log('[Reset] PostgreSQL: Removed test user seed.');

    await sequelize.close();
  } catch (err) {
    console.warn(`[Reset] PostgreSQL cleanup failed: ${err.message}`);
  }

  // ── 2. Redis cleanup ─────────────────────────────────────────────────────────
  try {
    const redis = require('../../src/server/db/redis');

    const keys = [
      `idempotency:${TEST_REQUEST_ID}`,
      `lease:transfer:${TEST_INFO_HASH}`,
      `lease:token:${TEST_INFO_HASH}`,
      `lease:transfer:${TEST_INFO_HASH}:genesis`,
      `lease:token:${TEST_INFO_HASH}:genesis`,
    ];

    let deleted = 0;
    for (const key of keys) {
      const result = await redis.del(key);
      if (result > 0) {
        console.log(`[Reset] Redis: Deleted '${key}'`);
        deleted++;
      }
    }

    if (deleted === 0) console.log('[Reset] Redis: No matching keys found.');
    await redis.quit();
  } catch (err) {
    console.warn(`[Reset] Redis cleanup failed: ${err.message}`);
  }

  console.log('\n[Reset] Done. Ready for next test run.');
  process.exit(0);
}

reset();
