import React from 'react';
import TorrentStatus from './components/TorrentStatus';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>TorrentEdge Dashboard</h1>
        <TorrentStatus />
      </header>
    </div>
  );
}

export default App;
