import axios from 'axios';

const API_BASE_URL = 'http://localhost:3029/api/torrent';

export const fetchTorrents = async () => {
  try {
    const response = await axios.get(`${API_BASE_URL}/`);
    return response.data;
  } catch (error) {
    console.error("Error fetching torrents:", error);
    throw error;
  }
};

export const addTorrent = async (torrentFile) => {
  try {
    const response = await axios.post(`${API_BASE_URL}/create`, { file: torrentFile });
    return response.data;
  } catch (error) {
    console.error("Error adding torrent:", error);
    throw error;
  }
};

export const fetchPeers = async () => {
  try {
    const response = await axios.get(`${API_BASE_URL}/peers`);
    return response.data;
  } catch (error) {
    console.error("Error fetching peers:", error);
    throw error;
  }
};

export const fetchStatusUpdates = async () => {
  try {
    const response = await axios.get(`${API_BASE_URL}/status-updates`);
    return response.data;
  } catch (error) {
    console.error("Error fetching status updates:", error);
    throw error;
  }
};
