// src/server/seed.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

// Load environment variables
dotenv.config();

const seedUsers = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      // Removed deprecated options
    });

    // Clear existing users
    await User.deleteMany({});

    // Create test users
    const testUser = new User({
      username: 'testuser',
      email: 'testuser@example.com', // Required field
      password: 'testpassword',       // This will be hashed by the pre-save hook
    });

    await testUser.save();
    console.log('Test user created successfully.');
    mongoose.disconnect();
  } catch (error) {
    console.error('Error seeding the database:', error);
    mongoose.disconnect();
  }
};

seedUsers();
