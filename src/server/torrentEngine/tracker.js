const http = require('http');
const https = require('https');
const dgram = require('dgram');
const { URL } = require('url');
const crypto = require('crypto');
const { decode } = require('./bencode');

/**
 * Generates a 20-byte peer ID for this client
 * Format: '-TE0001-' + 12 random bytes
 */
function generatePeerId() {
  const prefix = Buffer.from('-TE0001-');
  const random = crypto.randomBytes(12);
  return Buffer.concat([prefix, random]);
}

/**
 * URL-encodes binary data (Buffer) for tracker requests
 * Alphanumeric and -._~ are kept as-is, everything else encoded as %XX
 */
function urlEncodeBytes(buffer) {
  let encoded = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    const char = String.fromCharCode(byte);
    
    // Keep alphanumeric and -._~ as-is
    if ((byte >= 0x30 && byte <= 0x39) ||  // 0-9
        (byte >= 0x41 && byte <= 0x5A) ||  // A-Z
        (byte >= 0x61 && byte <= 0x7A) ||  // a-z
        byte === 0x2D || byte === 0x2E ||  // - .
        byte === 0x5F || byte === 0x7E) {  // _ ~
      encoded += char;
    } else {
      encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return encoded;
}

/**
 * Parses compact peer format (6 bytes per peer: 4 IP + 2 port)
 */
function parseCompactPeers(peersBuffer) {
  if (!Buffer.isBuffer(peersBuffer)) {
    return [];
  }

  if (peersBuffer.length % 6 !== 0) {
    throw new Error(`Invalid compact peers length: ${peersBuffer.length}`);
  }

  const peers = [];
  for (let i = 0; i < peersBuffer.length; i += 6) {
    const ip = `${peersBuffer[i]}.${peersBuffer[i + 1]}.${peersBuffer[i + 2]}.${peersBuffer[i + 3]}`;
    const port = peersBuffer.readUInt16BE(i + 4);
    peers.push({ ip, port });
  }

  return peers;
}

/**
 * Parses non-compact peer format (list of dictionaries)
 */
function parseNonCompactPeers(peersList) {
  if (!Array.isArray(peersList)) {
    return [];
  }

  return peersList.map(peer => {
    const ip = Buffer.isBuffer(peer.ip) ? peer.ip.toString('utf8') : peer.ip;
    const port = peer.port;

    if (!ip || typeof port !== 'number') {
      return null;
    }

    return { ip, port };
  }).filter(peer => peer !== null);
}

/**
 * Makes HTTP/HTTPS request to tracker and announces
 * @param {Object} options - Announce options
 * @returns {Promise<Object>} Tracker response with peers
 */
function announceToTracker(options) {
  return new Promise((resolve, reject) => {
    const {
      announceUrl,
      infoHash,
      peerId = generatePeerId(),
      port = 6881,
      uploaded = 0,
      downloaded = 0,
      left,
      event = '',
      compact = 1
    } = options;

    if (!announceUrl) {
      return reject(new Error('announceUrl is required'));
    }

    if (!infoHash || !Buffer.isBuffer(infoHash) || infoHash.length !== 20) {
      return reject(new Error('infoHash must be a 20-byte Buffer'));
    }

    if (!Buffer.isBuffer(peerId) || peerId.length !== 20) {
      return reject(new Error('peerId must be a 20-byte Buffer'));
    }

    if (typeof left !== 'number') {
      return reject(new Error('left (bytes remaining) is required'));
    }

    let url;
    try {
      url = new URL(announceUrl);
    } catch (error) {
      return reject(new Error(`Invalid announceUrl: ${error.message}`));
    }

    // Build query parameters
    const params = new URLSearchParams();
    params.append('info_hash', urlEncodeBytes(infoHash));
    params.append('peer_id', urlEncodeBytes(peerId));
    params.append('port', port.toString());
    params.append('uploaded', uploaded.toString());
    params.append('downloaded', downloaded.toString());
    params.append('left', left.toString());
    params.append('compact', compact.toString());
    
    if (event) {
      params.append('event', event);
    }

    // URLSearchParams encodes some chars, but we need raw encoding for binary data
    // So we manually construct the info_hash and peer_id parts
    const queryString = params.toString()
      .replace(/info_hash=[^&]*/, `info_hash=${urlEncodeBytes(infoHash)}`)
      .replace(/peer_id=[^&]*/, `peer_id=${urlEncodeBytes(peerId)}`);

    url.search = '?' + queryString;

    const protocol = url.protocol === 'https:' ? https : http;
    const timeout = 15000; // 15 seconds

    const req = protocol.get(url.toString(), { timeout }, (res) => {
      const chunks = [];

      res.on('data', chunk => chunks.push(chunk));

      res.on('end', () => {
        try {
          const responseBuffer = Buffer.concat(chunks);
          const response = decode(responseBuffer);

          // Check for tracker error
          if (response['failure reason']) {
            const reason = Buffer.isBuffer(response['failure reason'])
              ? response['failure reason'].toString('utf8')
              : response['failure reason'];
            return reject(new Error(`Tracker error: ${reason}`));
          }

          // Parse response
          const interval = response.interval || 0;
          const minInterval = response['min interval'];
          const complete = response.complete || 0;
          const incomplete = response.incomplete || 0;

          // Parse peers (compact or non-compact format)
          let peers;
          if (Buffer.isBuffer(response.peers)) {
            peers = parseCompactPeers(response.peers);
          } else if (Array.isArray(response.peers)) {
            peers = parseNonCompactPeers(response.peers);
          } else {
            peers = [];
          }

          resolve({
            interval,
            minInterval,
            complete,
            incomplete,
            peers
          });
        } catch (error) {
          reject(new Error(`Failed to parse tracker response: ${error.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tracker request timed out'));
    });

    req.on('error', (error) => {
      reject(new Error(`Tracker request failed: ${error.message}`));
    });
  });
}

/**
 * Announces to UDP tracker following BEP 15 protocol
 * @param {Object} options - Announce options
 * @returns {Promise<Object>} Tracker response with peers
 */
function announceToUdpTracker(options) {
  return new Promise((resolve, reject) => {
    const {
      announceUrl,
      infoHash,
      peerId = generatePeerId(),
      port = 6881,
      uploaded = 0,
      downloaded = 0,
      left,
      event = ''
    } = options;

    if (!announceUrl) {
      return reject(new Error('announceUrl is required'));
    }

    if (!infoHash || !Buffer.isBuffer(infoHash) || infoHash.length !== 20) {
      return reject(new Error('infoHash must be a 20-byte Buffer'));
    }

    if (!Buffer.isBuffer(peerId) || peerId.length !== 20) {
      return reject(new Error('peerId must be a 20-byte Buffer'));
    }

    if (typeof left !== 'number') {
      return reject(new Error('left (bytes remaining) is required'));
    }

    let url;
    try {
      url = new URL(announceUrl);
    } catch (error) {
      return reject(new Error(`Invalid announceUrl: ${error.message}`));
    }

    const host = url.hostname;
    const trackerPort = parseInt(url.port) || 80;

    const socket = dgram.createSocket('udp4');
    const transactionId = crypto.randomBytes(4).readUInt32BE(0);
    const key = crypto.randomBytes(4).readUInt32BE(0);
    let connectionId = null;
    let retries = 0;
    const maxRetries = 3;
    let timeoutHandle;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      socket.close();
    };

    const sendWithRetry = (buffer, callback, retryDelay = 15000) => {
      if (retries >= maxRetries) {
        cleanup();
        return reject(new Error('UDP tracker request timed out after retries'));
      }

      socket.send(buffer, 0, buffer.length, trackerPort, host, (err) => {
        if (err) {
          cleanup();
          return reject(new Error(`Failed to send UDP request: ${err.message}`));
        }
      });

      timeoutHandle = setTimeout(() => {
        retries++;
        const nextDelay = retryDelay * 2;
        sendWithRetry(buffer, callback, nextDelay);
      }, retryDelay);
    };

    // Step 1: Send connect request
    const sendConnectRequest = () => {
      const buffer = Buffer.allocUnsafe(16);
      // Magic constant for connection_id: 0x41727101980
      buffer.writeBigUInt64BE(0x41727101980n, 0);
      buffer.writeUInt32BE(0, 8); // action = 0 (connect)
      buffer.writeUInt32BE(transactionId, 12);

      sendWithRetry(buffer, null);
    };

    // Step 2: Send announce request
    const sendAnnounceRequest = () => {
      retries = 0; // Reset retries for announce
      
      const buffer = Buffer.allocUnsafe(98);
      let offset = 0;

      buffer.writeBigUInt64BE(connectionId, offset); offset += 8;
      buffer.writeUInt32BE(1, offset); offset += 4; // action = 1 (announce)
      buffer.writeUInt32BE(transactionId, offset); offset += 4;
      infoHash.copy(buffer, offset); offset += 20;
      peerId.copy(buffer, offset); offset += 20;
      buffer.writeBigUInt64BE(BigInt(downloaded), offset); offset += 8;
      buffer.writeBigUInt64BE(BigInt(left), offset); offset += 8;
      buffer.writeBigUInt64BE(BigInt(uploaded), offset); offset += 8;

      // Event: 0=none, 1=completed, 2=started, 3=stopped
      const eventCode = event === 'completed' ? 1 : event === 'started' ? 2 : event === 'stopped' ? 3 : 0;
      buffer.writeUInt32BE(eventCode, offset); offset += 4;

      buffer.writeUInt32BE(0, offset); offset += 4; // IP (0 = default)
      buffer.writeUInt32BE(key, offset); offset += 4; // random key
      buffer.writeInt32BE(-1, offset); offset += 4; // num_want (-1 = default)
      buffer.writeUInt16BE(port, offset);

      sendWithRetry(buffer, null);
    };

    socket.on('message', (msg) => {
      clearTimeout(timeoutHandle);

      try {
        if (msg.length < 8) {
          cleanup();
          return reject(new Error('Invalid UDP tracker response: too short'));
        }

        const action = msg.readUInt32BE(0);
        const receivedTransactionId = msg.readUInt32BE(4);

        if (receivedTransactionId !== transactionId) {
          return; // Ignore responses with wrong transaction ID
        }

        if (action === 0) {
          // Connect response
          if (msg.length < 16) {
            cleanup();
            return reject(new Error('Invalid connect response length'));
          }

          connectionId = msg.readBigUInt64BE(8);
          sendAnnounceRequest();
        } else if (action === 1) {
          // Announce response
          if (msg.length < 20) {
            cleanup();
            return reject(new Error('Invalid announce response length'));
          }

          const interval = msg.readUInt32BE(8);
          const incomplete = msg.readUInt32BE(12);
          const complete = msg.readUInt32BE(16);

          // Parse peers (6 bytes each: 4 IP + 2 port)
          const peers = [];
          let offset = 20;
          while (offset + 6 <= msg.length) {
            const ip = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
            const peerPort = msg.readUInt16BE(offset + 4);
            peers.push({ ip, port: peerPort });
            offset += 6;
          }

          cleanup();
          resolve({
            interval,
            minInterval: undefined,
            complete,
            incomplete,
            peers
          });
        } else if (action === 3) {
          // Error response
          const errorMsg = msg.slice(8).toString('utf8');
          cleanup();
          reject(new Error(`UDP tracker error: ${errorMsg}`));
        } else {
          cleanup();
          reject(new Error(`Unknown UDP tracker action: ${action}`));
        }
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to parse UDP response: ${error.message}`));
      }
    });

    socket.on('error', (error) => {
      cleanup();
      reject(new Error(`UDP socket error: ${error.message}`));
    });

    sendConnectRequest();
  });
}

/**
 * Auto-detects protocol and announces to appropriate tracker
 * @param {Object} options - Announce options
 * @returns {Promise<Object>} Tracker response with peers
 */
function announce(options) {
  const { announceUrl } = options;

  if (!announceUrl) {
    return Promise.reject(new Error('announceUrl is required'));
  }

  if (announceUrl.startsWith('udp://')) {
    return announceToUdpTracker(options);
  } else if (announceUrl.startsWith('http://') || announceUrl.startsWith('https://')) {
    return announceToTracker(options);
  } else {
    return Promise.reject(new Error('Unsupported tracker protocol. Use http://, https://, or udp://'));
  }
}

module.exports = { announce, announceToTracker, announceToUdpTracker, generatePeerId, urlEncodeBytes };

