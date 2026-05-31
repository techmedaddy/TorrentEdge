const User = require('./User');
const Node = require('./Node');
const Transfer = require('./Transfer');
const Chunk = require('./Chunk');
const ArtifactActivity = require('./ArtifactActivity');

// Associations

// Transfers belong to a User (Uploader)
User.hasMany(Transfer, { foreignKey: 'uploaded_by', as: 'uploads' });
Transfer.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });

// Users can leech many Transfers
const { sequelize } = require('../../db/sql');
const TransferLeecher = sequelize.define('TransferLeecher', {}, { tableName: 'transfer_leechers', timestamps: false });

User.belongsToMany(Transfer, { through: TransferLeecher, as: 'leeched_transfers', foreignKey: 'user_id' });
Transfer.belongsToMany(User, { through: TransferLeecher, as: 'leechers', foreignKey: 'transfer_id' });

// User has many ArtifactActivity
User.hasMany(ArtifactActivity, { foreignKey: 'user_id', as: 'activities' });
ArtifactActivity.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Transfers belong to a Node (Owner)
Node.hasMany(Transfer, { foreignKey: 'owner_node_id', as: 'owned_transfers' });
Transfer.belongsTo(Node, { foreignKey: 'owner_node_id', as: 'owner_node' });

// Chunks belong to a Transfer
Transfer.hasMany(Chunk, { foreignKey: 'transfer_id', as: 'chunks' });
Chunk.belongsTo(Transfer, { foreignKey: 'transfer_id', as: 'transfer' });

// Chunks belong to a Node (where it's stored)
Node.hasMany(Chunk, { foreignKey: 'node_id', as: 'stored_chunks' });
Chunk.belongsTo(Node, { foreignKey: 'node_id', as: 'node' });

module.exports = {
  User,
  Node,
  Transfer,
  Chunk,
  TransferLeecher,
  ArtifactActivity
};
