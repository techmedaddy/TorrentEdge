const net = require('net');
const EventEmitter = require('events');

const MESSAGE_TYPES = {
  CHOKE: 0,
  UNCHOKE: 1,
  INTERESTED: 2,
  NOT_INTERESTED: 3,
  HAVE: 4,
  BITFIELD: 5,
  REQUEST: 6,
  PIECE: 7,
  CANCEL: 8,
  PORT: 9
};

/**
 * Handles individual peer TCP connections and BitTorrent handshake
 * 
 * Handshake format (68 bytes):
 * - 1 byte: pstrlen (19)
 * - 19 bytes: pstr ("BitTorrent protocol")
 * - 8 bytes: reserved (zeros)
 * - 20 bytes: info_hash
 * - 20 bytes: peer_id
 * 
 * Message format (after handshake):
 * - 4 bytes: length (big endian)
 * - 1 byte: message id (if length > 0)
 * - N bytes: payload
 */
class PeerConnection extends EventEmitter {
  /**
   * @param {Object} options - Connection options
   * @param {string} options.ip - Peer IP address
   * @param {number} options.port - Peer port
   * @param {Buffer} options.infoHash - 20-byte info hash
   * @param {Buffer} options.peerId - Our 20-byte peer ID
   * @param {Function} options.onHandshake - Callback when handshake completes
   * @param {Function} options.onMessage - Callback when message received
   * @param {Function} options.onError - Callback on error
   * @param {Function} options.onClose - Callback when connection closes
   */
  constructor(options) {
    super();

    this.ip = options.ip;
    this.port = options.port;
    this.infoHash = options.infoHash;
    this.peerId = options.peerId;

    this.onHandshake = options.onHandshake || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});
    this.onClose = options.onClose || (() => {});

    this.socket = null;
    this.isConnected = false;
    this.isHandshakeComplete = false;
    this.remotePeerId = null;

    this.handshakeTimeout = null;
    this.handshakeBuffer = Buffer.alloc(0);
    this.messageBuffer = Buffer.alloc(0);

    // Peer state
    this.amChoking = true;
    this.amInterested = false;
    this.peerChoking = true;
    this.peerInterested = false;
    this.peerBitfield = null;

    if (!Buffer.isBuffer(this.infoHash) || this.infoHash.length !== 20) {
      throw new Error('infoHash must be a 20-byte Buffer');
    }

    if (!Buffer.isBuffer(this.peerId) || this.peerId.length !== 20) {
      throw new Error('peerId must be a 20-byte Buffer');
    }
  }

  /**
   * Initiates TCP connection and sends handshake
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        return reject(new Error('Already connected'));
      }

      this.socket = new net.Socket();

      this.handshakeTimeout = setTimeout(() => {
        this.handleError(new Error('Handshake timeout'));
        reject(new Error('Handshake timeout'));
      }, 30000);

      this.socket.on('connect', () => {
        this.isConnected = true;
        this.sendHandshake();
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        this.handleError(error);
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.socket.on('close', () => {
        this.handleClose();
      });

      this.socket.connect(this.port, this.ip);
    });
  }

  /**
   * Sends BitTorrent handshake to peer
   */
  sendHandshake() {
    const handshake = Buffer.allocUnsafe(68);
    let offset = 0;

    handshake.writeUInt8(19, offset); offset += 1;
    handshake.write('BitTorrent protocol', offset, 19, 'utf8'); offset += 19;
    handshake.fill(0, offset, offset + 8); offset += 8;
    this.infoHash.copy(handshake, offset); offset += 20;
    this.peerId.copy(handshake, offset);

    this.socket.write(handshake);
  }

  /**
   * Handles incoming data from peer
   */
  handleData(data) {
    if (!this.isHandshakeComplete) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, data]);

      if (this.handshakeBuffer.length >= 68) {
        this.processHandshake();
      }
    } else {
      this.messageBuffer = Buffer.concat([this.messageBuffer, data]);
      this.processMessages();
    }
  }

  /**
   * Processes peer wire protocol messages
   */
  processMessages() {
    while (this.messageBuffer.length >= 4) {
      const length = this.messageBuffer.readUInt32BE(0);

      if (this.messageBuffer.length < 4 + length) {
        break;
      }

      const messageBuffer = this.messageBuffer.slice(4, 4 + length);
      this.messageBuffer = this.messageBuffer.slice(4 + length);

      if (length === 0) {
        this.handleMessage({ id: null, payload: Buffer.alloc(0) });
      } else {
        const id = messageBuffer.readUInt8(0);
        const payload = messageBuffer.slice(1);
        this.handleMessage({ id, payload });
      }
    }
  }

  /**
   * Handles a parsed message
   */
  handleMessage(message) {
    const { id, payload } = message;

    if (id === null) {
      // Keep-alive
      return;
    }

    switch (id) {
      case MESSAGE_TYPES.CHOKE:
        this.peerChoking = true;
        break;

      case MESSAGE_TYPES.UNCHOKE:
        this.peerChoking = false;
        break;

      case MESSAGE_TYPES.INTERESTED:
        this.peerInterested = true;
        break;

      case MESSAGE_TYPES.NOT_INTERESTED:
        this.peerInterested = false;
        break;

      case MESSAGE_TYPES.HAVE:
        if (payload.length === 4) {
          const pieceIndex = payload.readUInt32BE(0);
          this.onMessage({ type: 'have', pieceIndex });
        }
        break;

      case MESSAGE_TYPES.BITFIELD:
        this.peerBitfield = payload;
        this.onMessage({ type: 'bitfield', bitfield: payload });
        break;

      case MESSAGE_TYPES.REQUEST:
        if (payload.length === 12) {
          const index = payload.readUInt32BE(0);
          const begin = payload.readUInt32BE(4);
          const length = payload.readUInt32BE(8);
          this.onMessage({ type: 'request', index, begin, length });
        }
        break;

      case MESSAGE_TYPES.PIECE:
        if (payload.length >= 8) {
          const index = payload.readUInt32BE(0);
          const begin = payload.readUInt32BE(4);
          const data = payload.slice(8);
          this.onMessage({ type: 'piece', index, begin, data });
        }
        break;

      case MESSAGE_TYPES.CANCEL:
        if (payload.length === 12) {
          const index = payload.readUInt32BE(0);
          const begin = payload.readUInt32BE(4);
          const length = payload.readUInt32BE(8);
          this.onMessage({ type: 'cancel', index, begin, length });
        }
        break;

      case MESSAGE_TYPES.PORT:
        if (payload.length === 2) {
          const port = payload.readUInt16BE(0);
          this.onMessage({ type: 'port', port });
        }
        break;

      default:
        break;
    }

    this.emit('message', { id, payload });
  }

  /**
   * Processes and validates peer's handshake
   */
  processHandshake() {
    const handshake = this.handshakeBuffer.slice(0, 68);
    let offset = 0;

    // Validate pstrlen
    const pstrlen = handshake.readUInt8(offset); offset += 1;
    if (pstrlen !== 19) {
      return this.handleError(new Error(`Invalid pstrlen: expected 19, got ${pstrlen}`));
    }

    // Validate pstr
    const pstr = handshake.toString('utf8', offset, offset + 19); offset += 19;
    if (pstr !== 'BitTorrent protocol') {
      return this.handleError(new Error(`Invalid protocol string: ${pstr}`));
    }

    // Skip reserved bytes
    offset += 8;

    // Validate info_hash
    const peerInfoHash = handshake.slice(offset, offset + 20); offset += 20;
    if (!peerInfoHash.equals(this.infoHash)) {
      return this.handleError(new Error('Info hash mismatch'));
    }

    // Extract peer_id
    this.remotePeerId = handshake.slice(offset, offset + 20);

    // Clear handshake timeout
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.isHandshakeComplete = true;

    // Handle any remaining data after handshake
    if (this.handshakeBuffer.length > 68) {
      const remaining = this.handshakeBuffer.slice(68);
      this.handshakeBuffer = Buffer.alloc(0);
      this.handleData(remaining);
    } else {
      this.handshakeBuffer = Buffer.alloc(0);
    }

    // Notify handshake complete
    this.onHandshake({
      peerId: this.remotePeerId,
      ip: this.ip,
      port: this.port
    });

    this.emit('handshake', {
      peerId: this.remotePeerId,
      ip: this.ip,
      port: this.port
    });
  }

  /**
   * Sends a peer wire protocol message
   * @param {number} id - Message ID
   * @param {Buffer} payload - Message payload
   */
  sendMessage(id, payload = Buffer.alloc(0)) {
    if (!this.isConnected || !this.isHandshakeComplete) {
      throw new Error('Cannot send message: not connected or handshake not complete');
    }

    const length = 1 + payload.length;
    const message = Buffer.allocUnsafe(4 + length);
    
    message.writeUInt32BE(length, 0);
    message.writeUInt8(id, 4);
    if (payload.length > 0) {
      payload.copy(message, 5);
    }

    this.socket.write(message);
  }

  /**
   * Sends keep-alive message
   */
  sendKeepAlive() {
    if (!this.isConnected || !this.isHandshakeComplete) {
      throw new Error('Cannot send message: not connected or handshake not complete');
    }

    const message = Buffer.allocUnsafe(4);
    message.writeUInt32BE(0, 0);
    this.socket.write(message);
  }

  /**
   * Sends choke message
   */
  sendChoke() {
    this.sendMessage(MESSAGE_TYPES.CHOKE);
    this.amChoking = true;
  }

  /**
   * Sends unchoke message
   */
  sendUnchoke() {
    this.sendMessage(MESSAGE_TYPES.UNCHOKE);
    this.amChoking = false;
  }

  /**
   * Sends interested message
   */
  sendInterested() {
    this.sendMessage(MESSAGE_TYPES.INTERESTED);
    this.amInterested = true;
  }

  /**
   * Sends not interested message
   */
  sendNotInterested() {
    this.sendMessage(MESSAGE_TYPES.NOT_INTERESTED);
    this.amInterested = false;
  }

  /**
   * Sends have message
   * @param {number} pieceIndex - Index of piece we have
   */
  sendHave(pieceIndex) {
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(pieceIndex, 0);
    this.sendMessage(MESSAGE_TYPES.HAVE, payload);
  }

  /**
   * Sends bitfield message
   * @param {Buffer} bitfield - Bitfield of pieces we have
   */
  sendBitfield(bitfield) {
    this.sendMessage(MESSAGE_TYPES.BITFIELD, bitfield);
  }

  /**
   * Sends request message
   * @param {number} index - Piece index
   * @param {number} begin - Byte offset within piece
   * @param {number} length - Length of block to request
   */
  sendRequest(index, begin, length) {
    const payload = Buffer.allocUnsafe(12);
    payload.writeUInt32BE(index, 0);
    payload.writeUInt32BE(begin, 4);
    payload.writeUInt32BE(length, 8);
    this.sendMessage(MESSAGE_TYPES.REQUEST, payload);
  }

  /**
   * Sends piece message
   * @param {number} index - Piece index
   * @param {number} begin - Byte offset within piece
   * @param {Buffer} data - Block data
   */
  sendPiece(index, begin, data) {
    const payload = Buffer.allocUnsafe(8 + data.length);
    payload.writeUInt32BE(index, 0);
    payload.writeUInt32BE(begin, 4);
    data.copy(payload, 8);
    this.sendMessage(MESSAGE_TYPES.PIECE, payload);
  }

  /**
   * Sends cancel message
   * @param {number} index - Piece index
   * @param {number} begin - Byte offset within piece
   * @param {number} length - Length of block to cancel
   */
  sendCancel(index, begin, length) {
    const payload = Buffer.allocUnsafe(12);
    payload.writeUInt32BE(index, 0);
    payload.writeUInt32BE(begin, 4);
    payload.writeUInt32BE(length, 8);
    this.sendMessage(MESSAGE_TYPES.CANCEL, payload);
  }

  /**
   * Closes the connection gracefully
   */
  disconnect() {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    if (this.socket) {
      this.socket.destroy();
    }

    this.isConnected = false;
    this.isHandshakeComplete = false;
  }

  /**
   * Handles connection errors
   */
  handleError(error) {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.onError(error);
    this.emit('error', error);
    this.disconnect();
  }

  /**
   * Handles connection close
   */
  handleClose() {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.isConnected = false;
    this.isHandshakeComplete = false;
    
    this.onClose();
    this.emit('close');
  }
}

module.exports = { PeerConnection, MESSAGE_TYPES };
