import { useCallback, useEffect, useReducer, useState } from 'react';
import { flushSync } from 'react-dom';
import { devToolsApi } from '@/services/devToolsApi';
import { captureApp, downloadDataUrl, timestampedName } from '../capture';
import type { ReferenceLayout } from '../diff';
import { guessDensity, referenceSize, type Size } from '../geometry';
import { readReferenceImage } from '../image';
import { loadImage, loadSettings, saveImage, saveSettings } from '../persistence';
import {
  DEFAULT_SETTINGS,
  effectiveOpacity,
  normalize,
  overlayReducer,
  settingsOf,
  type OverlayState,
} from '../state';
import { useOverlayShortcuts, usesArrowKeys } from '../useOverlayShortcuts';
import { useViewport } from '../useViewport';
import { ComparePanel } from './ComparePanel';
import { OverlayToolbar, type CompareView } from './OverlayToolbar';
import { ReferenceLayer } from './ReferenceLayer';

/** Restores the overlay from this session (sessionStorage), if anything was saved. */
function restore(): OverlayState {
  return normalize({ ...(loadSettings() ?? DEFAULT_SETTINGS), image: loadImage() });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Comparison {
  view: CompareView;
  screenshot: string;
  /** Snapshots taken at capture time, so the diff matches what was on screen. */
  layout: ReferenceLayout;
  viewport: Size;
}

/**
 * Development-only design overlay (see the renderer README). Mounted next to <App/> in dev builds
 * only. While inactive it renders nothing and only listens for Cmd/Ctrl+Shift+D.
 */
export function DesignOverlay() {
  const [state, dispatch] = useReducer(overlayReducer, undefined, restore);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const viewport = useViewport();
  const { image } = state;

  // Remember everything for the rest of the session (survives a window reload).
  useEffect(() => {
    saveSettings(settingsOf(state));
  }, [state]);
  useEffect(() => {
    const stored = saveImage(image);
    setNotice(image && !stored ? 'Too large to keep after a reload; settings are kept.' : null);
  }, [image]);

  const size = image ? referenceSize(image, state, viewport) : { width: 0, height: 0 };
  const layout: ReferenceLayout = { x: state.x, y: state.y, ...size };

  const loadFile = useCallback(async (file: File, requireExtension = true) => {
    setError(null);
    try {
      const next = await readReferenceImage(file, { requireExtension });
      dispatch({ type: 'loadImage', image: next, density: guessDensity(next.width, window.innerWidth) });
    } catch (e) {
      setError(message(e));
    }
  }, []);

  // Paste an image (e.g. Figma's "Copy as PNG") while the overlay is open.
  useEffect(() => {
    if (!state.active) return;
    const onPaste = (e: ClipboardEvent) => {
      if (usesArrowKeys(e.target)) return; // A text field: let it paste normally.
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void loadFile(file, false);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [state.active, loadFile]);

  const close = useCallback(() => {
    setComparison(null);
    dispatch({ type: 'setActive', active: false });
  }, []);

  useOverlayShortcuts(
    {
      active: state.active,
      hasImage: image != null,
      canNudge: image != null && state.visible && !state.locked && comparison == null,
    },
    {
      toggleActive: () => {
        if (state.active) close();
        else dispatch({ type: 'setActive', active: true });
      },
      adjustOpacity: (delta) => dispatch({ type: 'adjustOpacity', delta }),
      reset: () => dispatch({ type: 'reset' }),
      flipShow: () => dispatch({ type: 'flipShow' }),
      nudge: (dx, dy) => dispatch({ type: 'nudge', dx, dy }),
    }
  );

  /** Screenshots the app with the overlay hidden. */
  const capture = async (): Promise<string | null> => {
    setError(null);
    setBusy(true);
    try {
      return await captureApp(
        () => flushSync(() => setCapturing(true)),
        () => setCapturing(false)
      );
    } catch (e) {
      setError(`Screenshot failed: ${message(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveScreenshot = async () => {
    const shot = await capture();
    if (shot) downloadDataUrl(shot, timestampedName('app'));
  };

  const compare = async (view: CompareView) => {
    const shot = await capture();
    if (shot) setComparison({ view, screenshot: shot, layout, viewport });
  };

  if (!state.active) return null;

  return (
    // `display: none` while capturing, not `visibility: hidden`: buttons with `transition-all` would
    // animate the inherited visibility and still be painted in the screenshot.
    <div data-design-overlay className={capturing ? 'hidden' : undefined}>
      {image && state.visible && (
        <ReferenceLayer
          src={image.src}
          name={image.name}
          layout={layout}
          opacity={effectiveOpacity(state)}
          blend={state.blend}
          draggable={!state.locked && !state.clickThrough && state.show !== 'app'}
          onMove={(x, y) => dispatch({ type: 'moveTo', x, y })}
        />
      )}
      <OverlayToolbar
        state={state}
        dispatch={dispatch}
        viewport={viewport}
        error={error}
        notice={notice}
        busy={busy}
        canCapture={devToolsApi.isAvailable()}
        onFile={(file) => void loadFile(file)}
        onCapture={() => void saveScreenshot()}
        onCompare={(view) => void compare(view)}
        onClose={close}
      />
      {comparison && image && (
        <ComparePanel
          view={comparison.view}
          screenshot={comparison.screenshot}
          reference={image}
          layout={comparison.layout}
          viewport={comparison.viewport}
          busy={busy}
          onRecapture={() => void compare(comparison.view)}
          onClose={() => setComparison(null)}
        />
      )}
    </div>
  );
}
