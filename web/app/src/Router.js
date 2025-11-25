import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Dashboard from './components/Dashboard';
import OtherPage from './components/OtherPage';

const AppRouter = () => (
  <Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/other" element={<OtherPage />} />
  </Routes>
);

export default AppRouter;
