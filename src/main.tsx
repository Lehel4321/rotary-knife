import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { engine } from './engine/SimulationEngine';
import './index.css';

// Expose the machine data block on the console for scripted test
// campaigns (e.g. window.engine.updateRecipe({ thick: 20 })).
declare global { interface Window { engine: typeof engine } }
window.engine = engine;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
