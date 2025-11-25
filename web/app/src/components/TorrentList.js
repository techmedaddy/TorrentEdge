import React, { useState, useEffect } from 'react';
import { fetchTorrents } from '../api/api'; // ✅ Ensure correct path

const TorrentList = () => {
  const [torrents, setTorrents] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const getTorrents = async () => {
      try {
        const response = await fetchTorrents();
        setTorrents(response.data);
      } catch (error) {
        console.error('Error fetching torrents:', error);
        setError('Failed to fetch torrents. Please try again.');
      }
    };

    getTorrents();
  }, []);

  return (
    <div className="torrent-list">
      <h2>Torrent List</h2>
      {error ? (
        <p className="error-message">{error}</p>
      ) : (
        <ul>
          {torrents.length > 0 ? (
            torrents.map((torrent) => (
              <li key={torrent.id}>
                {torrent.name} - Status: {torrent.status}
                <button className="button">Start</button>
                <button className="button">Pause</button>
                <button className="button">Resume</button>
              </li>
            ))
          ) : (
            <p>No torrents available.</p>
          )}
        </ul>
      )}
    </div>
  );
};

export default TorrentList;
