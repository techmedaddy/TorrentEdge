import React, { useState, useEffect } from 'react';
import axios from 'axios';

const TorrentStatus = () => {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await axios.get('http://localhost:5000/torrent-status'); // Backend API
        setStatus(response.data);
      } catch (error) {
        console.error('Error fetching torrent status:', error);
      }
    };

    fetchStatus();
  }, []);

  return (
    <div>
      <h2>Torrent Status</h2>
      {status ? (
        <div>
          <p>Progress: {status.progress}%</p>
          <p>Peers: {status.peers}</p>
          <p>Download Speed: {status.downloadSpeed} KB/s</p>
          <p>Upload Speed: {status.uploadSpeed} KB/s</p>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
};

export default TorrentStatus;
