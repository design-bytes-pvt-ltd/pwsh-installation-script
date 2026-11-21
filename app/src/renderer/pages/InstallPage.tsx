import { useCallback, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/button';
import { Typography } from '@/components/typography';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { FailureList, LogViewer, StatusRow, stepLabel, stepTone, useInstallActions } from '@/features/install';
import { recommendedModel } from '@/features/models';
import { useTimedText } from '@/hooks/useTimedText';
import { STEP_NAMES, useAppState } from '@/store';
import type { StepName } from '../../shared/types';

/** Heading for the current state of the run. */
function title(running: boolean, failed: boolean): string {
  if (failed) return 'Installation couldn\'t finish';
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
  const { start, showLog, copyErrorReport } = useInstallActions();
  const [copyLabel, flashCopyLabel] = useTimedText('Copy error report');

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

  const { summary, startError } = install;
  const failed = !install.running && (startError !== null || (summary !== null && summary.exitCode !== 0));

  const stepTitles: Record<StepName, string> = {
    Ollama: 'Install Ollama',
    Models: modelName ? `Download the AI model (${modelName})` : 'Download the AI model',
    Docker: 'Install Docker',
    Containers: 'Start the dev container (ubuntu-nix-hm)',
  };

  const copyReport = async () => flashCopyLabel((await copyErrorReport()) ? 'Copied' : 'Nothing to copy');

  return (
    <div className="w-full flex flex-col gap-[24px]">
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1">{title(install.running, failed)}</Typography>
        <Typography variant="body" className="text-subtle-foreground">
          We install Ollama, download the AI model that suits this computer, install Docker, then download and start the
          dev container. You may be asked for your password.
        </Typography>
      </div>

      <ul className="flex flex-col gap-2" aria-label="Install steps">
        {STEP_NAMES.map((name) => (
          <StatusRow key={name} name={stepTitles[name]} tone={stepTone(install.steps[name])} label={stepLabel(install.steps[name])} />
        ))}
      </ul>

      {install.running && (
        <div className="flex flex-col gap-[8px]">
          <Progress value={install.percent} aria-label="Install progress" />
          <Typography variant="caption" className="text-subtle-foreground">
            {install.progressLabel}
          </Typography>
        </div>
      )}

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

      {failed && (
        <div role="alert" className="flex flex-col gap-[12px]">
          {startError ? (
            <Typography variant="small" className="text-destructive">
              Setup could not start: {startError}
            </Typography>
          ) : summary?.cancelled ? (
            <Typography variant="small">Setup was cancelled.</Typography>
          ) : (
            summary?.failures && summary.failures.length > 0 && <FailureList failures={summary.failures} />
          )}
          <div className="flex flex-row flex-wrap gap-2">
            <Button onClick={() => void runInstall()}>Retry</Button>
            <Button variant="secondary" onClick={() => void showLog()}>
              Show log
            </Button>
            <Button variant="secondary" onClick={() => void copyReport()}>
              {copyLabel}
            </Button>
          </div>
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
