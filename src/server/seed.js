const dotenv = require('dotenv');
const { sequelize } = require('./db/sql');
const { User } = require('./models/sql');

dotenv.config();

(async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();

    await User.destroy({ where: {} });

    await User.create({
      username: 'testuser',
      email: 'testuser@example.com',
      password: 'testpassword',
    });

    console.log('Test user created successfully.');
  } catch (error) {
    console.error('Error seeding the database:', error);
  } finally {
    await sequelize.close();
  }
})();
