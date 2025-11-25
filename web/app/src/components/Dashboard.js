import React, { useState, useEffect } from 'react';
import TorrentList from './TorrentList';
import AddTorrent from './AddTorrent';
import PeerCommunication from './PeerCommunication';
import StatusUpdates from './StatusUpdates';
import { fetchStatusUpdates } from '../api/api'; // Adjust the import path if necessary

const Dashboard = () => {
  const [statusUpdates, setStatusUpdates] = useState([]);

  useEffect(() => {
    const getStatusUpdates = async () => {
      try {
        const response = await fetchStatusUpdates();
        setStatusUpdates(response.data);
      } catch (error) {
        console.error('Error fetching status updates:', error);
      }
    };

    getStatusUpdates();
    const intervalId = setInterval(getStatusUpdates, 5000); // Poll every 5 seconds

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="dashboard container">
      <h1>TorrentEdge Dashboard</h1>
      <AddTorrent />
      <TorrentList />
      <PeerCommunication />
      <StatusUpdates updates={statusUpdates} />
    </div>
  );
};

export default Dashboard;
