import React, { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { getStatistics } from '../api/statistics';

const TorrentStatistics = () => {
  const [data, setData] = useState({});

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await getStatistics();
        const chartData = {
          labels: response.data.timestamps,
          datasets: [
            {
              label: 'Download Speed',
              data: response.data.speeds,
              borderColor: 'rgba(75, 192, 192, 1)',
              backgroundColor: 'rgba(75, 192, 192, 0.2)',
            },
          ],
        };
        setData(chartData);
      } catch (error) {
        console.error('Error fetching statistics:', error);
      }
    };

    fetchData();
  }, []);

  return (
    <div>
      <h2>Torrent Statistics</h2>
      <Line data={data} />
    </div>
  );
};

export default TorrentStatistics;
