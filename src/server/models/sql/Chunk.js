const { DataTypes } = require('sequelize');
const { sequelize } = require('../../db/sql');

const Chunk = sequelize.define('Chunk', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chunk_index: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  chunk_hash: {
    type: DataTypes.CHAR(64),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'downloading', 'verified', 'failed'),
    defaultValue: 'pending'
  },
  verified_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'chunks',
  indexes: [
    {
      unique: true,
      fields: ['transfer_id', 'chunk_index']
    }
  ]
});

module.exports = Chunk;
