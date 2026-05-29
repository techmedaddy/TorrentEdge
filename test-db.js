const { connectSQL, sequelize } = require('./src/server/db/sql');
const { Transfer } = require('./src/server/models/sql');

(async () => {
  await connectSQL();
  
  try {
    const t = await Transfer.create({
      name: 'test',
      info_hash: '1234567890123456789012345678901234567890',
      size_bytes: 1234,
      status: 'seeding',
      uploaded_by: null // testing what happens
    });
    console.log('Success:', t.id);
  } catch (err) {
    console.error('Error creating transfer:', err.message);
  }
  
  await sequelize.close();
})();
