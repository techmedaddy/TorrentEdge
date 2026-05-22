require('dotenv').config();
const { sequelize } = require('./src/server/db/sql');

async function fixEnum() {
  try {
    const values = ['downloading', 'seeding', 'pending', 'fetching_metadata', 'idle', 'checking', 'error'];
    for (const val of values) {
      try {
        await sequelize.query(`ALTER TYPE enum_transfers_status ADD VALUE IF NOT EXISTS '${val}';`);
        console.log(`Added ${val}`);
      } catch (e) {
        console.log(`Failed or already exists: ${val} - ${e.message}`);
      }
    }
    console.log('Enum fix completed.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixEnum();
