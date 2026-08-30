import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './ui/App';
import './index.css';

// Offline desde el primer arranque: un local de ensayo no siempre tiene
// cobertura, y el motor no necesita red para nada.
registerSW({ immediate: true });

const root = document.getElementById('root');
if (!root) throw new Error('Falta el nodo #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
