import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary, installGlobalErrorReporting } from '@/app';
import { AppStoreProvider } from '@/store';
import './styles/globals.css';

installGlobalErrorReporting();

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing <div id="root">');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <AppStoreProvider>
        <App />
      </AppStoreProvider>
    </ErrorBoundary>
  </StrictMode>
);
