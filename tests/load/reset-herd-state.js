#!/usr/bin/env node

/**
 * Resets the test state between thundering herd runs.
 * 
 * Deletes:
 *   - The test transfer from PostgreSQL
 *   - The Redis idempotency key
 *   - The Redis lease key
 *
 * Usage:
 *   node tests/load/reset-herd-state.js
 */

require('dotenv').config();

const TEST_INFO_HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const TEST_REQUEST_ID = 'thundering-herd-test-llama70b-run1';

async function reset() {
  console.log('[Reset] Cleaning up thundering herd test state...\n');

  // 1. PostgreSQL cleanup
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

    // Also clean up any leecher records
    await sequelize.query(
      `DELETE FROM transfer_leechers WHERE transfer_id NOT IN (SELECT id FROM transfers)`
    ).catch(() => {});

    await sequelize.close();
  } catch (err) {
    console.warn(`[Reset] PostgreSQL cleanup failed: ${err.message}`);
  }

  // 2. Redis cleanup
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
        console.log(`[Reset] Redis: Deleted key '${key}'`);
        deleted++;
      }
    }

    if (deleted === 0) {
      console.log('[Reset] Redis: No matching keys found.');
    }

    await redis.quit();
  } catch (err) {
    console.warn(`[Reset] Redis cleanup failed: ${err.message}`);
  }

  console.log('\n[Reset] Done. Ready for next test run.');
  process.exit(0);
}

reset();
