import React, { useState } from 'react';
import { searchTorrents } from '../api/torrent';

const TorrentSearch = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  const handleSearch = async (e) => {
    e.preventDefault();
    try {
      const response = await searchTorrents(query);
      setResults(response.data);
    } catch (error) {
      console.error('Search error:', error);
    }
  };

  return (
    <div>
      <form onSubmit={handleSearch}>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search torrents" />
        <button type="submit">Search</button>
      </form>
      <ul>
        {results.map((torrent) => (
          <li key={torrent._id}>{torrent.name}</li>
        ))}
      </ul>
    </div>
  );
};

export default TorrentSearch;
