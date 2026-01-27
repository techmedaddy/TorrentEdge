const { announceToTracker, generatePeerId, urlEncodeBytes } = require('../src/server/torrentEngine/tracker');
const { encode } = require('../src/server/torrentEngine/bencode');
const http = require('http');
const https = require('https');

describe('Tracker Module', () => {
  describe('generatePeerId', () => {
    it('should return a 20-byte Buffer', () => {
      const peerId = generatePeerId();
      expect(Buffer.isBuffer(peerId)).toBe(true);
      expect(peerId.length).toBe(20);
    });

    it('should start with -TE0001- prefix', () => {
      const peerId = generatePeerId();
      const prefix = peerId.slice(0, 8).toString('utf8');
      expect(prefix).toBe('-TE0001-');
    });

    it('should have random bytes after prefix', () => {
      const peerId1 = generatePeerId();
      const peerId2 = generatePeerId();
      
      const random1 = peerId1.slice(8);
      const random2 = peerId2.slice(8);
      
      expect(random1.length).toBe(12);
      expect(random2.length).toBe(12);
      expect(random1.equals(random2)).toBe(false);
    });
  });

  describe('urlEncodeBytes', () => {
    it('should not encode alphanumeric characters', () => {
      const buffer = Buffer.from('abc123XYZ');
      expect(urlEncodeBytes(buffer)).toBe('abc123XYZ');
    });

    it('should not encode special characters -._~', () => {
      const buffer = Buffer.from('-._~');
      expect(urlEncodeBytes(buffer)).toBe('-._~');
    });

    it('should encode binary bytes as uppercase hex', () => {
      const buffer = Buffer.from([0x00, 0xFF, 0xAB]);
      expect(urlEncodeBytes(buffer)).toBe('%00%FF%AB');
    });

    it('should handle mixed alphanumeric and binary content', () => {
      const buffer = Buffer.from([0x61, 0x62, 0x00, 0x63]); // 'a', 'b', 0x00, 'c'
      expect(urlEncodeBytes(buffer)).toBe('ab%00c');
    });

    it('should encode spaces and special characters', () => {
      const buffer = Buffer.from('hello world!');
      expect(urlEncodeBytes(buffer)).toBe('hello%20world%21');
    });

    it('should handle all unreserved characters', () => {
      const buffer = Buffer.from('Test-File_Name.txt~');
      expect(urlEncodeBytes(buffer)).toBe('Test-File_Name.txt~');
    });
  });

  describe('announceToTracker', () => {
    let mockRequest;
    let mockResponse;

    beforeEach(() => {
      mockResponse = {
        on: jest.fn()
      };

      mockRequest = {
        on: jest.fn(),
        destroy: jest.fn()
      };
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should parse valid tracker response with compact peers', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      // Create compact peers buffer: IP 192.168.1.1 port 6881
      const peersBuffer = Buffer.from([192, 168, 1, 1, 0x1A, 0xE1]);
      
      const trackerResponse = encode({
        interval: 1800,
        complete: 10,
        incomplete: 5,
        peers: peersBuffer
      });

      // Mock http.get
      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        callback(mockResponse);
        
        // Simulate response events
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        
        return mockRequest;
      });

      const result = await announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      });

      expect(result.interval).toBe(1800);
      expect(result.complete).toBe(10);
      expect(result.incomplete).toBe(5);
      expect(result.peers.length).toBe(1);
      expect(result.peers[0].ip).toBe('192.168.1.1');
      expect(result.peers[0].port).toBe(6881);
    });

    it('should parse multiple compact peers', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      // Create compact peers buffer with 2 peers
      const peersBuffer = Buffer.from([
        192, 168, 1, 1, 0x1A, 0xE1,  // 192.168.1.1:6881
        10, 0, 0, 5, 0x1A, 0xE2       // 10.0.0.5:6882
      ]);
      
      const trackerResponse = encode({
        interval: 1800,
        peers: peersBuffer
      });

      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      const result = await announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      });

      expect(result.peers.length).toBe(2);
      expect(result.peers[0].ip).toBe('192.168.1.1');
      expect(result.peers[0].port).toBe(6881);
      expect(result.peers[1].ip).toBe('10.0.0.5');
      expect(result.peers[1].port).toBe(6882);
    });

    it('should parse non-compact peer format', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      const trackerResponse = encode({
        interval: 1800,
        peers: [
          { ip: '1.2.3.4', port: 6881, 'peer id': Buffer.alloc(20, 0xAA) },
          { ip: '5.6.7.8', port: 6882, 'peer id': Buffer.alloc(20, 0xBB) }
        ]
      });

      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      const result = await announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      });

      expect(result.peers.length).toBe(2);
      expect(result.peers[0].ip).toBe('1.2.3.4');
      expect(result.peers[0].port).toBe(6881);
      expect(result.peers[1].ip).toBe('5.6.7.8');
      expect(result.peers[1].port).toBe(6882);
    });

    it('should use HTTPS for https:// URLs', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      const trackerResponse = encode({
        interval: 1800,
        peers: Buffer.alloc(6, 0)
      });

      jest.spyOn(https, 'get').mockImplementation((url, options, callback) => {
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      await announceToTracker({
        announceUrl: 'https://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      });

      expect(https.get).toHaveBeenCalled();
    });

    it('should handle tracker failure reason', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      const trackerResponse = encode({
        'failure reason': 'Torrent not registered'
      });

      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      await expect(announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      })).rejects.toThrow('Tracker error: Torrent not registered');
    });

    it('should handle network timeout', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();

      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        // Simulate timeout
        setImmediate(() => {
          mockRequest.on.mock.calls.find(call => call[0] === 'timeout')?.[1]();
        });
        return mockRequest;
      });

      await expect(announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      })).rejects.toThrow('timed out');
    });

    it('should handle network errors', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();

      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        setImmediate(() => {
          const error = new Error('ECONNREFUSED');
          mockRequest.on.mock.calls.find(call => call[0] === 'error')?.[1](error);
        });
        return mockRequest;
      });

      await expect(announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000
      })).rejects.toThrow('Tracker request failed');
    });

    it('should reject if announceUrl is missing', async () => {
      await expect(announceToTracker({
        infoHash: Buffer.alloc(20),
        peerId: generatePeerId(),
        port: 6881,
        left: 1000
      })).rejects.toThrow('announceUrl is required');
    });

    it('should reject if infoHash is not a 20-byte Buffer', async () => {
      await expect(announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash: Buffer.alloc(10),
        peerId: generatePeerId(),
        port: 6881,
        left: 1000
      })).rejects.toThrow('infoHash must be a 20-byte Buffer');
    });

    it('should reject if left is not provided', async () => {
      await expect(announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash: Buffer.alloc(20),
        peerId: generatePeerId(),
        port: 6881
      })).rejects.toThrow('left');
    });

    it('should use default values for optional parameters', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      
      const trackerResponse = encode({
        interval: 1800,
        peers: Buffer.alloc(0)
      });

      let capturedUrl;
      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        capturedUrl = url;
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      await announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        left: 1000
      });

      expect(capturedUrl).toContain('port=6881');
      expect(capturedUrl).toContain('uploaded=0');
      expect(capturedUrl).toContain('downloaded=0');
      expect(capturedUrl).toContain('compact=1');
    });

    it('should include event parameter when provided', async () => {
      const infoHash = Buffer.alloc(20, 0x12);
      const peerId = generatePeerId();
      
      const trackerResponse = encode({
        interval: 1800,
        peers: Buffer.alloc(0)
      });

      let capturedUrl;
      jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
        capturedUrl = url;
        callback(mockResponse);
        setImmediate(() => {
          mockResponse.on.mock.calls.find(call => call[0] === 'data')?.[1](trackerResponse);
          mockResponse.on.mock.calls.find(call => call[0] === 'end')?.[1]();
        });
        return mockRequest;
      });

      await announceToTracker({
        announceUrl: 'http://tracker.example.com/announce',
        infoHash,
        peerId,
        port: 6881,
        left: 1000,
        event: 'started'
      });

      expect(capturedUrl).toContain('event=started');
    });
  });
});
