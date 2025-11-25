import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import TorrentList from './components/TorrentList';
import NotFound from './components/NotFound';

const App = () => {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/torrents" element={<TorrentList />} />
      <Route path="*" element={<NotFound />} /> {/* Catch-all route */}
    </Routes>
  );
};

export default App;
