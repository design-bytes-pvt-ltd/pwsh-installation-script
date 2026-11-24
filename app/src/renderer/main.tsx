import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary, installGlobalErrorReporting } from '@/app';
import { AppStoreProvider } from '@/store';
import './styles/globals.css';

installGlobalErrorReporting();

// Development builds only (`npm run dev`): the Figma design overlay. In production `__DEV_TOOLS__`
// is the constant `false`, so this branch and the overlay's chunk are left out of the bundle.
const DesignOverlay = __DEV_TOOLS__ ? lazy(() => import('@/features/design-overlay')) : null;

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing <div id="root">');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <AppStoreProvider>
        <App />
        {DesignOverlay && (
          <Suspense fallback={null}>
            <DesignOverlay />
          </Suspense>
        )}
      </AppStoreProvider>
    </ErrorBoundary>
  </StrictMode>
);
