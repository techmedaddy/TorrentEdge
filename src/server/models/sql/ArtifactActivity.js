const { DataTypes } = require('sequelize');
const { sequelize } = require('../../db/sql');

const ArtifactActivity = sequelize.define('ArtifactActivity', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  info_hash: {
    type: DataTypes.STRING(40),
    allowNull: true,
  },
  action: {
    type: DataTypes.STRING(20),
    allowNull: false,
  },
  file_name: {
    type: DataTypes.STRING(255),
  },
  ip_address: {
    type: DataTypes.STRING(45),
  },
}, {
  tableName: 'artifact_activities',
  timestamps: true,
  updatedAt: false,
  createdAt: 'created_at'
});

module.exports = ArtifactActivity;
