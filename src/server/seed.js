const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    await User.deleteMany({});

    const testUser = new User({
      username: 'testuser',
      email: 'testuser@example.com',
      password: 'testpassword',
    });

    await testUser.save();

    console.log('Test user created successfully.');
  } catch (error) {
    console.error('Error seeding the database:', error);
  } finally {
    mongoose.connection.close();
  }
})();
