import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { BreakingBanner, useAlertDetection } from './components/BreakingAlerts';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useKiosk } from './components/Kiosk';
import { WatchlistDock } from './components/Watch';
import { TopBar, VIEWS, toggleFullscreen } from './components/TopBar';
import { connectStream } from './store/election';
import './styles/global.css';
import './styles/phase2.css';
import { Dashboard } from './views/Dashboard';
import './styles/chamber.css';
import './styles/features.css';
import { BallotView } from './views/BallotView';
import { ChamberView } from './views/ChamberView';
import { MapView } from './views/MapView';
import { MyRacesView } from './views/MyRacesView';
import { RaceView } from './views/RaceView';

/** Global shortcuts: 1-4 switch views, F toggles fullscreen. */
function Shortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) navigate(v.path);
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
}

/** App-wide behaviors that need the router: alerts, kiosk rotation, race drill-down clicks. */
function AppEffects() {
  const navigate = useNavigate();
  useAlertDetection();
  useKiosk();
  useEffect(() => {
    // Any element tagged data-race-id (table rows, tiles, seats...) opens that race's drill-down.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest('button, a, input, select, label')) return;
      const el = t.closest('[data-race-id]');
      const id = el?.getAttribute('data-race-id');
      if (id) navigate(`/race/${id}`);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [navigate]);
  return null;
}

function App() {
  useEffect(() => connectStream(), []);
  return (
    <BrowserRouter>
      <Shortcuts />
      <AppEffects />
      <div className="app">
        <TopBar />
        <BreakingBanner />
        <main className="view">
          <ErrorBoundary label="This view">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/map/:office" element={<MapView />} />
            <Route path="/ballot" element={<BallotView />} />
            <Route path="/senate" element={<ChamberView key="S" office="S" />} />
            <Route path="/house" element={<ChamberView key="H" office="H" />} />
            <Route path="/governors" element={<ChamberView key="G" office="G" />} />
            <Route path="/race/:id" element={<RaceView />} />
            <Route path="/mine" element={<MyRacesView />} />
            <Route path="/map" element={<Navigate to="/map/senate" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ErrorBoundary>
        </main>
        <WatchlistDock />
      </div>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
