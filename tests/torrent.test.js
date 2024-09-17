const torrentManager = require('../src/client/torrentManager');

// A simple test framework setup, using Node's built-in assert
const assert = require('assert');

// Test for creating a torrent
describe('Torrent Manager', () => {

    it('should create a torrent', () => {
        const file = { name: 'testfile.txt', size: 1024 };
        const torrent = torrentManager.create(file);

        assert.strictEqual(torrent.status, 'created');
        assert.ok(torrent.torrentId);
    });

    it('should track a torrent', () => {
        const torrentId = '12345';
        const torrentStatus = torrentManager.track(torrentId);

        assert.strictEqual(torrentStatus.torrentId, torrentId);
        assert.strictEqual(torrentStatus.status, 'downloading');
        assert.ok(torrentStatus.progress >= 0 && torrentStatus.progress <= 100);
    });

});
