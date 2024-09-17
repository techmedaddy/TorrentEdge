const torrentManager = require('../client/torrentManager');

const torrentController = {
    createTorrent: (file) => {
        return torrentManager.create(file);
    },

    trackTorrent: (torrentId) => {
        return torrentManager.track(torrentId);
    }
};

module.exports = torrentController;
