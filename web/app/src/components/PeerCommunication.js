import React, { useState, useEffect } from 'react';
import { fetchPeers } from '../api/api'; // Adjust the import path if necessary

const PeerCommunication = () => {
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    const getPeers = async () => {
      try {
        const response = await fetchPeers();
        setPeers(response.data);
      } catch (error) {
        console.error('Error fetching peers:', error);
      }
    };

    getPeers();
    const intervalId = setInterval(getPeers, 10000); // Poll every 10 seconds

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="peer-communication">
      <h2>Peer Communication</h2>
      <ul>
        {peers.map((peer) => (
          <li key={peer.id}>
            Peer: {peer.name} - Status: {peer.status}
            {/* Add buttons for interactions with peers */}
            <button className="button">Send Message</button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PeerCommunication;
