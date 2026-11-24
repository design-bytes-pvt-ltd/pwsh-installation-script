import { useCallback, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Typography } from '@/components/typography';
import { SegmentedProgress } from '@/components/segmented-progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LogViewer, progressCaption, stepSegment, useInstallActions } from '@/features/install';
import { recommendedModel } from '@/features/models';
import { STEP_NAMES, useAppState } from '@/store';
import type { StepName } from '../../shared/types';

/** Names under the progress card's bars. */
const SEGMENT_LABELS: Record<StepName, string> = {
  Ollama: 'Installing Ollama',
  Models: 'Pulling AI model',
  Docker: 'Setting up Docker',
  Containers: 'Installing container',
};

/** Heading for the current state of the run. A failed or cancelled run has its own page (see App). */
function title(running: boolean): string {
  return running ? 'Installing Enterprise Brain' : 'Getting ready to install';
}

/**
 * Content area for the "Install" step. Starts the install on mount: Ollama, then the recommended
 * model (the main process skips it when already downloaded), then Docker, then the dev container
 * (pulled from ghcr.io and started with docker compose). When the run succeeds the
 * app moves on to the Finish step by itself (see `advanceWhen` in app/steps.tsx).
 */
export function InstallPage() {
  const { probe, install } = useAppState();
  const { start } = useInstallActions();

  const modelName = probe ? recommendedModel(probe.models)?.name : undefined;
  const runInstall = useCallback(() => start({ models: modelName ? [modelName] : [] }), [start, modelName]);

  // Start exactly once. StrictMode runs effects twice in development, and the main process refuses
  // a second run while one is active; the ref survives StrictMode's remount.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !probe || install.running || install.summary) return;
    started.current = true;
    void runInstall();
  }, [probe, install.running, install.summary, runInstall]);

  const { summary } = install;

  const segments = STEP_NAMES.map((name) => ({ id: name, label: SEGMENT_LABELS[name], ...stepSegment(install.steps[name]) }));

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1" className="tracking-[-0.005em]">
          {title(install.running)}
        </Typography>
        <Typography variant="body" className="text-subtle-foreground">
          Please keep this window open. This takes about 15 minutes.
        </Typography>
      </div>

      <div className="flex flex-col gap-[8px]">
        <SegmentedProgress segments={segments} />
        {install.running && (
          <Typography variant="caption" aria-live="polite" className="px-[4px] text-subtle-foreground">
            {progressCaption(install.progressLabel)}
          </Typography>
        )}
      </div>

      {summary && summary.notes.length > 0 && (
        <div className="flex flex-col gap-[6px]">
          <Typography variant="small" className="font-medium">
            Before you continue
          </Typography>
          <ul className="list-disc pl-5">
            {summary.notes.map((note) => (
              <li key={note}>
                <Typography variant="small">{note}</Typography>
              </li>
            ))}
          </ul>
        </div>
      )}

      {install.logLines.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-subtle-foreground">
            <ChevronDown aria-hidden size={14} className="transition-transform group-data-[state=open]:rotate-180" />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-[8px]">
            <LogViewer lines={install.logLines} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
