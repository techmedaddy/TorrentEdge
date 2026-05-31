const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) return res.status(401).json({ message: 'No token provided' });
  
  // Strip "Bearer " prefix if present
  const token = authHeader.startsWith('Bearer ') 
    ? authHeader.slice(7) 
    : authHeader;
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { User } = require('../models/sql');
    
    // Verify user actually exists in DB to prevent "ghost token" orphans
    const user = await User.findByPk(decoded.userId || decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists in database. Please log in again.' });
    }
    
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};
