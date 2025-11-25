// web/web-react-new/src/api/user.js

import axios from 'axios';

// Optional: Set the base URL for Axios if not already set globally
axios.defaults.baseURL = 'http://localhost:3000';

// Optional: Add an interceptor to include the token in all requests
axios.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token'); // Adjust based on where you store the token
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export const getProfile = () => {
  return axios.get('/api/user/profile');
};

export const updateProfile = (profileData) => {
  return axios.put('/api/user/profile', profileData);
};
