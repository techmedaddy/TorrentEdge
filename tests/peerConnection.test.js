const net = require('net');
const { PeerConnection, MESSAGE_TYPES } = require('../src/server/torrentEngine/peerConnection');

describe('PeerConnection', () => {
  let mockServer;
  let serverPort;
  let infoHash;
  let peerId;

  beforeEach((done) => {
    infoHash = Buffer.alloc(20, 0xAA);
    peerId = Buffer.alloc(20, 0xBB);

    mockServer = net.createServer();
    mockServer.listen(0, () => {
      serverPort = mockServer.address().port;
      done();
    });
  });

  afterEach((done) => {
    if (mockServer) {
      mockServer.close(() => done());
    } else {
      done();
    }
  });

  describe('Constructor', () => {
    it('should throw if infoHash is not 20 bytes', () => {
      expect(() => {
        new PeerConnection({
          ip: '127.0.0.1',
          port: 6881,
          infoHash: Buffer.alloc(10),
          peerId: Buffer.alloc(20)
        });
      }).toThrow('infoHash must be a 20-byte Buffer');
    });

    it('should throw if peerId is not 20 bytes', () => {
      expect(() => {
        new PeerConnection({
          ip: '127.0.0.1',
          port: 6881,
          infoHash: Buffer.alloc(20),
          peerId: Buffer.alloc(10)
        });
      }).toThrow('peerId must be a 20-byte Buffer');
    });

    it('should initialize with correct default state', () => {
      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: 6881,
        infoHash,
        peerId
      });

      expect(conn.isConnected).toBe(false);
      expect(conn.isHandshakeComplete).toBe(false);
      expect(conn.amChoking).toBe(true);
      expect(conn.amInterested).toBe(false);
      expect(conn.peerChoking).toBe(true);
      expect(conn.peerInterested).toBe(false);
    });
  });

  describe('Handshake', () => {
    it('should complete successful handshake', (done) => {
      const remotePeerId = Buffer.alloc(20, 0xCC);

      mockServer.once('connection', (socket) => {
        socket.once('data', (data) => {
          expect(data.length).toBe(68);
          expect(data.readUInt8(0)).toBe(19);
          expect(data.toString('utf8', 1, 20)).toBe('BitTorrent protocol');

          const handshake = Buffer.allocUnsafe(68);
          handshake.writeUInt8(19, 0);
          handshake.write('BitTorrent protocol', 1, 19, 'utf8');
          handshake.fill(0, 20, 28);
          infoHash.copy(handshake, 28);
          remotePeerId.copy(handshake, 48);

          socket.write(handshake);
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: (info) => {
          expect(info.peerId.equals(remotePeerId)).toBe(true);
          expect(conn.isHandshakeComplete).toBe(true);
          expect(conn.remotePeerId.equals(remotePeerId)).toBe(true);
          conn.disconnect();
          done();
        }
      });

      conn.connect();
    });

    it('should reject handshake with mismatched info_hash', (done) => {
      const wrongInfoHash = Buffer.alloc(20, 0xFF);

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = Buffer.allocUnsafe(68);
          handshake.writeUInt8(19, 0);
          handshake.write('BitTorrent protocol', 1, 19, 'utf8');
          handshake.fill(0, 20, 28);
          wrongInfoHash.copy(handshake, 28);
          Buffer.alloc(20, 0xCC).copy(handshake, 48);

          socket.write(handshake);
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onError: (error) => {
          expect(error.message).toContain('Info hash mismatch');
          done();
        }
      });

      conn.connect();
    });

    it('should reject invalid protocol string', (done) => {
      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = Buffer.allocUnsafe(68);
          handshake.writeUInt8(19, 0);
          handshake.write('Invalid protocol!!!', 1, 19, 'utf8');
          handshake.fill(0, 20, 28);
          infoHash.copy(handshake, 28);
          Buffer.alloc(20, 0xCC).copy(handshake, 48);

          socket.write(handshake);
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onError: (error) => {
          expect(error.message).toContain('Invalid protocol string');
          done();
        }
      });

      conn.connect();
    });

    it('should timeout if no handshake received', (done) => {
      jest.useFakeTimers();

      mockServer.once('connection', () => {
        // Accept connection but never send handshake
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onError: (error) => {
          expect(error.message).toContain('timeout');
          jest.useRealTimers();
          done();
        }
      });

      conn.connect();

      jest.advanceTimersByTime(30000);
    });
  });

  describe('Message Parsing', () => {
    it('should parse choke message', (done) => {
      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const chokeMsg = Buffer.from([0, 0, 0, 1, MESSAGE_TYPES.CHOKE]);
          socket.write(Buffer.concat([handshake, chokeMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          expect(conn.peerChoking).toBe(true);
          conn.disconnect();
          done();
        }
      });

      conn.connect();
    });

    it('should parse unchoke message', (done) => {
      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const unchokeMsg = Buffer.from([0, 0, 0, 1, MESSAGE_TYPES.UNCHOKE]);
          socket.write(Buffer.concat([handshake, unchokeMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          expect(conn.peerChoking).toBe(false);
          conn.disconnect();
          done();
        }
      });

      conn.connect();
    });

    it('should parse bitfield message', (done) => {
      const bitfield = Buffer.from([0xFF, 0xAA, 0x55]);

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const bitfieldMsg = Buffer.allocUnsafe(5 + bitfield.length);
          bitfieldMsg.writeUInt32BE(1 + bitfield.length, 0);
          bitfieldMsg.writeUInt8(MESSAGE_TYPES.BITFIELD, 4);
          bitfield.copy(bitfieldMsg, 5);
          socket.write(Buffer.concat([handshake, bitfieldMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onMessage: (msg) => {
          if (msg.type === 'bitfield') {
            expect(msg.bitfield.equals(bitfield)).toBe(true);
            expect(conn.peerBitfield.equals(bitfield)).toBe(true);
            conn.disconnect();
            done();
          }
        }
      });

      conn.connect();
    });

    it('should parse have message', (done) => {
      const pieceIndex = 42;

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const haveMsg = Buffer.allocUnsafe(9);
          haveMsg.writeUInt32BE(5, 0);
          haveMsg.writeUInt8(MESSAGE_TYPES.HAVE, 4);
          haveMsg.writeUInt32BE(pieceIndex, 5);
          socket.write(Buffer.concat([handshake, haveMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onMessage: (msg) => {
          if (msg.type === 'have') {
            expect(msg.pieceIndex).toBe(pieceIndex);
            conn.disconnect();
            done();
          }
        }
      });

      conn.connect();
    });

    it('should parse piece message', (done) => {
      const index = 5;
      const begin = 16384;
      const data = Buffer.from('test block data');

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const pieceMsg = Buffer.allocUnsafe(13 + data.length);
          pieceMsg.writeUInt32BE(9 + data.length, 0);
          pieceMsg.writeUInt8(MESSAGE_TYPES.PIECE, 4);
          pieceMsg.writeUInt32BE(index, 5);
          pieceMsg.writeUInt32BE(begin, 9);
          data.copy(pieceMsg, 13);
          socket.write(Buffer.concat([handshake, pieceMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onMessage: (msg) => {
          if (msg.type === 'piece') {
            expect(msg.index).toBe(index);
            expect(msg.begin).toBe(begin);
            expect(msg.data.equals(data)).toBe(true);
            conn.disconnect();
            done();
          }
        }
      });

      conn.connect();
    });

    it('should parse request message', (done) => {
      const index = 10;
      const begin = 32768;
      const length = 16384;

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const requestMsg = Buffer.allocUnsafe(17);
          requestMsg.writeUInt32BE(13, 0);
          requestMsg.writeUInt8(MESSAGE_TYPES.REQUEST, 4);
          requestMsg.writeUInt32BE(index, 5);
          requestMsg.writeUInt32BE(begin, 9);
          requestMsg.writeUInt32BE(length, 13);
          socket.write(Buffer.concat([handshake, requestMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onMessage: (msg) => {
          if (msg.type === 'request') {
            expect(msg.index).toBe(index);
            expect(msg.begin).toBe(begin);
            expect(msg.length).toBe(length);
            conn.disconnect();
            done();
          }
        }
      });

      conn.connect();
    });

    it('should handle split messages', (done) => {
      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const chokeMsg = Buffer.from([0, 0, 0, 1, MESSAGE_TYPES.CHOKE]);

          socket.write(handshake);
          
          setTimeout(() => {
            socket.write(chokeMsg.slice(0, 3));
            setTimeout(() => {
              socket.write(chokeMsg.slice(3));
            }, 10);
          }, 10);
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          setTimeout(() => {
            expect(conn.peerChoking).toBe(true);
            conn.disconnect();
            done();
          }, 50);
        }
      });

      conn.connect();
    });

    it('should handle multiple messages in one chunk', (done) => {
      let messageCount = 0;

      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const chokeMsg = Buffer.from([0, 0, 0, 1, MESSAGE_TYPES.CHOKE]);
          const unchokeMsg = Buffer.from([0, 0, 0, 1, MESSAGE_TYPES.UNCHOKE]);
          
          socket.write(Buffer.concat([handshake, chokeMsg, unchokeMsg]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          setTimeout(() => {
            expect(conn.peerChoking).toBe(false);
            conn.disconnect();
            done();
          }, 50);
        }
      });

      conn.connect();
    });

    it('should handle keep-alive message', (done) => {
      mockServer.once('connection', (socket) => {
        socket.once('data', () => {
          const handshake = createHandshake(infoHash);
          const keepAlive = Buffer.from([0, 0, 0, 0]);
          socket.write(Buffer.concat([handshake, keepAlive]));
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          setTimeout(() => {
            conn.disconnect();
            done();
          }, 50);
        }
      });

      conn.connect();
    });
  });

  describe('Message Sending', () => {
    it('should send interested message with correct format', (done) => {
      mockServer.once('connection', (socket) => {
        const handshake = createHandshake(infoHash);
        socket.write(handshake);

        socket.on('data', (data) => {
          if (data.length === 68) return; // Skip our handshake

          expect(data.length).toBe(5);
          expect(data.readUInt32BE(0)).toBe(1);
          expect(data.readUInt8(4)).toBe(MESSAGE_TYPES.INTERESTED);
          done();
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          conn.sendInterested();
          expect(conn.amInterested).toBe(true);
        }
      });

      conn.connect();
    });

    it('should send request message with correct encoding', (done) => {
      const index = 5;
      const begin = 16384;
      const length = 16384;

      mockServer.once('connection', (socket) => {
        const handshake = createHandshake(infoHash);
        socket.write(handshake);

        socket.on('data', (data) => {
          if (data.length === 68) return;

          expect(data.length).toBe(17);
          expect(data.readUInt32BE(0)).toBe(13);
          expect(data.readUInt8(4)).toBe(MESSAGE_TYPES.REQUEST);
          expect(data.readUInt32BE(5)).toBe(index);
          expect(data.readUInt32BE(9)).toBe(begin);
          expect(data.readUInt32BE(13)).toBe(length);
          done();
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          conn.sendRequest(index, begin, length);
        }
      });

      conn.connect();
    });

    it('should send keep-alive with correct format', (done) => {
      mockServer.once('connection', (socket) => {
        const handshake = createHandshake(infoHash);
        socket.write(handshake);

        socket.on('data', (data) => {
          if (data.length === 68) return;

          expect(data.length).toBe(4);
          expect(data.readUInt32BE(0)).toBe(0);
          done();
        });
      });

      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId,
        onHandshake: () => {
          conn.sendKeepAlive();
        }
      });

      conn.connect();
    });

    it('should throw if trying to send before handshake', () => {
      const conn = new PeerConnection({
        ip: '127.0.0.1',
        port: serverPort,
        infoHash,
        peerId
      });

      expect(() => conn.sendInterested()).toThrow('not connected or handshake not complete');
    });
  });
});

function createHandshake(infoHash) {
  const handshake = Buffer.allocUnsafe(68);
  handshake.writeUInt8(19, 0);
  handshake.write('BitTorrent protocol', 1, 19, 'utf8');
  handshake.fill(0, 20, 28);
  infoHash.copy(handshake, 28);
  Buffer.alloc(20, 0xCC).copy(handshake, 48);
  return handshake;
}
