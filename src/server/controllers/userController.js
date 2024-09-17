const User = require('../models/User'); // Ensure this path is correct

// Function to get user profile
exports.getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id); // Assuming req.user.id is set by authMiddleware
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
};

// Function to update user profile
exports.updateUserProfile = async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.user.id, req.body, { new: true }); // Update user with new data
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
};
