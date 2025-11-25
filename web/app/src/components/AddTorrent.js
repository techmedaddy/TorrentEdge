import React, { useState } from 'react';
import { addTorrent } from '../api/api'; // Adjust the import path if necessary

const AddTorrent = () => {
  const [torrentUrl, setTorrentUrl] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await addTorrent(torrentUrl);
      setTorrentUrl('');
      // Optionally refresh the torrent list or show a success message
    } catch (error) {
      console.error('Error adding torrent:', error);
    }
  };

  return (
    <div className="add-torrent">
      <h2>Add Torrent</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={torrentUrl}
          onChange={(e) => setTorrentUrl(e.target.value)}
          placeholder="Enter torrent URL"
          required
        />
        <button type="submit" className="button">Add Torrent</button>
      </form>
    </div>
  );
};

export default AddTorrent;
