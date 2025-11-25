import React, { useEffect, useState } from 'react';
import { getTorrentDetail } from '../api/torrent';
import { useParams } from 'react-router-dom';

const TorrentDetail = () => {
  const { id } = useParams();
  const [torrent, setTorrent] = useState(null);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const response = await getTorrentDetail(id);
        setTorrent(response.data);
      } catch (error) {
        console.error('Error fetching torrent detail:', error);
      }
    };

    fetchDetail();
  }, [id]);

  if (!torrent) return <p>Loading...</p>;

  return (
    <div>
      <h2>{torrent.name}</h2>
      <p>Description: {torrent.description}</p>
      <p>Size: {torrent.size}</p>
      {/* Add more details as needed */}
    </div>
  );
};

export default TorrentDetail;
