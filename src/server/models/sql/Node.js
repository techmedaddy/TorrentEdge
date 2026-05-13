const { DataTypes } = require('sequelize');
const { sequelize } = require('../../db/sql');

const Node = sequelize.define('Node', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  hostname: {
    type: DataTypes.STRING,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('online', 'offline', 'maintenance'),
    defaultValue: 'online'
  },
  ip_address: {
    type: DataTypes.INET,
    allowNull: true
  },
  total_capacity_bytes: {
    type: DataTypes.BIGINT,
    defaultValue: 0
  },
  available_capacity_bytes: {
    type: DataTypes.BIGINT,
    defaultValue: 0
  },
  last_heartbeat_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'nodes'
});

module.exports = Node;
