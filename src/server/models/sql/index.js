const User = require('./User');
const Node = require('./Node');
const Transfer = require('./Transfer');
const Chunk = require('./Chunk');

// Associations

// Transfers belong to a User (Uploader)
User.hasMany(Transfer, { foreignKey: 'uploaded_by', as: 'uploads' });
Transfer.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });

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
  Chunk
};
