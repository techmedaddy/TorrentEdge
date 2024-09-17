const Torrent = require('../models/torrent'); // Ensure this path is correct

// Function to get a torrent by ID
exports.getTorrentById = async (req, res) => {
    try {
        const torrent = await Torrent.findById(req.params.id);
        if (!torrent) {
            return res.status(404).json({ message: 'Torrent not found' });
        }
        res.json(torrent);
    } catch (error) {
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
};
