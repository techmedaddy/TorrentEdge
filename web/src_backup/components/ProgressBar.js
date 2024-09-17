import React from 'react';

const ProgressBar = ({ progress }) => {
  const containerStyle = {
    height: '30px',
    width: '100%',
    backgroundColor: '#e0e0de',
    borderRadius: '5px',
    overflow: 'hidden',
    marginTop: '10px',
  };

  const fillerStyle = {
    height: '100%',
    width: `${progress}%`,
    backgroundColor: '#76c7c0',
    transition: 'width 0.2s ease-in-out',
    textAlign: 'right',
  };

  const labelStyle = {
    padding: '5px',
    color: 'white',
    fontWeight: 'bold',
  };

  return (
    <div style={containerStyle}>
      <div style={fillerStyle}>
        <span style={labelStyle}>{`${progress}%`}</span>
      </div>
    </div>
  );
};

export default ProgressBar;
