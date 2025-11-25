import axios from 'axios';

export const getStatistics = () => {
  return axios.get('/api/statistics');
};
