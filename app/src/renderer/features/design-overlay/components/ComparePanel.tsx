import { useEffect, useState } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { Spinner } from '@/components/spinner';
import { Typography } from '@/components/typography';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { downloadDataUrl, timestampedName } from '../capture';
import { buildDiff, type DiffResult, type ReferenceLayout } from '../diff';
import type { Size } from '../geometry';
import type { CompareView } from './OverlayToolbar';

interface ComparePanelProps {
  view: CompareView;
  screenshot: string;
  reference: { src: string; name: string };
  layout: ReferenceLayout;
  viewport: Size;
  busy: boolean;
  onRecapture: () => void;
  onClose: () => void;
}

function Pane({ title, src }: { title: string; src: string }) {
  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <Typography as="figcaption" variant="caption" tone="muted">{title}</Typography>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-black/40 p-2">
        <img src={src} alt={title} className="max-h-full max-w-full object-contain" />
      </div>
    </figure>
  );
}

function DiffView({ screenshot, reference, layout, viewport }: Pick<ComparePanelProps, 'screenshot' | 'reference' | 'layout' | 'viewport'>) {
  const [threshold, setThreshold] = useState(16);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    buildDiff(screenshot, reference.src, layout, viewport, threshold)
      .then((r) => !cancelled && setResult(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [screenshot, reference.src, layout, viewport, threshold]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex w-56 items-center gap-2">
          <Typography variant="caption" tone="muted" className="shrink-0">Tolerance</Typography>
          <Slider thumbLabel="Tolerance" min={0} max={128} step={1} value={[threshold]} onValueChange={([v]) => setThreshold(v)} />
          <Typography variant="caption" font="secondary" className="w-8 text-right">{threshold}</Typography>
        </div>
        {result && (
          <Typography variant="caption" font="secondary" role="status">
            {(result.ratio * 100).toFixed(2)}% different ({result.mismatched.toLocaleString()} of {result.compared.toLocaleString()} px)
          </Typography>
        )}
        {result && (
          <Button type="button" variant="outline" size="xs" onClick={() => downloadDataUrl(result.src, timestampedName('diff'))}>
            <Save /> Save diff
          </Button>
        )}
      </div>
      {error && <Typography role="alert" variant="caption" className="text-destructive">Couldn't compare the images: {error}</Typography>}
      {result ? <Pane title="Magenta = different · grey = matches (only where the design covers the app)" src={result.src} /> : !error && <Spinner color="currentColor" />}
    </div>
  );
}

/** Full-window comparison: the captured app and the design side by side, or their pixel difference. */
export function ComparePanel({ view, screenshot, reference, layout, viewport, busy, onRecapture, onClose }: ComparePanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dark">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={view === 'diff' ? 'Pixel difference' : 'Side by side'}
        className="fixed inset-0 z-[2147483002] flex flex-col gap-3 bg-background/95 p-4 text-foreground backdrop-blur-sm"
      >
        <div className="flex items-center gap-2">
          <Typography variant="small" className="flex-1 font-medium">
            {view === 'diff' ? 'Pixel difference' : 'Side by side'}
          </Typography>
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRecapture}>
            <RefreshCw /> Recapture
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => downloadDataUrl(screenshot, timestampedName('app'))}>
            <Save /> Save screenshot
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
            <X />
          </Button>
        </div>
        {view === 'diff' ? (
          <DiffView screenshot={screenshot} reference={reference} layout={layout} viewport={viewport} />
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <Pane title="App (captured)" src={screenshot} />
            <Pane title={`Design: ${reference.name}`} src={reference.src} />
          </div>
        )}
      </div>
    </div>
  );
}
