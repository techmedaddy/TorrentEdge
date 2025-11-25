import React from 'react';

const StatusUpdates = ({ updates }) => {
  return (
    <div className="status-updates">
      <h2>Status Updates</h2>
      <ul>
        {updates.length > 0 ? (
          updates.map((update, index) => (
            <li key={index}>
              {update.message} - {new Date(update.timestamp).toLocaleTimeString()}
            </li>
          ))
        ) : (
          <li>No updates available.</li>
        )}
      </ul>
    </div>
  );
};

export default StatusUpdates;
