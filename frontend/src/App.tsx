import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import FleetInterface from './components/FleetInterface';
import Dashboard from './components/Dashboard';
import GlobalErrorBoundary from './components/GlobalErrorBoundary';

function App() {
  return (
    <Router>
      <GlobalErrorBoundary>
        <Routes>
          {/* Home Page is now the Dashboard */}
          <Route path="/" element={<Dashboard />} />

          {/* The Editor is now dynamic based on ID */}
          <Route path="/warehouse/:graphId" element={<FleetInterface />} />

          {/* Redirect old users or 404s */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </GlobalErrorBoundary>
    </Router>
  );
}

export default App;