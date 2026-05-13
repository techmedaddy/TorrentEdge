const { DataTypes } = require('sequelize');
const { sequelize } = require('../../db/sql');

const Transfer = sequelize.define('Transfer', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  info_hash: {
    type: DataTypes.CHAR(40),
    allowNull: false,
    unique: true
  },
  magnet_uri: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  size_bytes: {
    type: DataTypes.BIGINT,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('created', 'queued', 'in_progress', 'paused', 'completed', 'failed'),
    defaultValue: 'created'
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 10
  },
  lease_expires_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'transfers'
});

module.exports = Transfer;
