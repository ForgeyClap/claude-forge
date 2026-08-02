/**
 * Forge Workspace — entry point.
 *
 * Mounts the prototype into #root. Nothing else happens here: no runtime is
 * started, no session is opened, no endpoint is configured. The whole app is a
 * visual prototype over local example data.
 *
 * Import order is load-bearing. The global stylesheet is pulled in FIRST so that
 * component stylesheets — which are imported transitively by App — land after it
 * in the cascade and can refine it rather than fight it.
 */

import '@/styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Forge prototype: #root is missing from index.html — nothing to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
