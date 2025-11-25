// web/web-react-new/src/api/auth.js
import axios from 'axios';

export const login = async (username, password) => {
  return axios.post('/api/auth/login', { username, password });
};

export const register = async (username, password) => {
  return axios.post('/api/auth/register', { username, password });
};