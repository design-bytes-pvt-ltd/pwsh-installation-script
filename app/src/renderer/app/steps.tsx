import type { ComponentType, ReactNode } from 'react';
import type { StepperStep } from '@/components/stepper';
import { diskTooLow, everythingInstalled, requirementsStatus } from '@/features/system';
import { FinishPage, GetReadyFooterNote, GetReadyPage, InstallPage } from '@/pages';
import { installerApi } from '@/services/installerApi';
import type { AppState } from '@/store';

/**
 * Everything that changes with the active step: its sidebar entry, the content area and the footer.
 * Steps are referenced by `id` everywhere; their order here is the order of the flow.
 */
type AppStep = StepperStep & {
  /** Content area for this step. */
  Content: ComponentType;
  /** Text on the left of the footer. */
  footerNote: ReactNode;
  /** Label of the footer's primary button, which moves to the next step. Omitted: no button. */
  actionLabel?: string;
  /** What the footer button does instead of moving to the next step. */
  onAction?: () => Promise<void>;
  /** Whether the footer button is enabled. Omitted: always enabled. */
  canProceed?: (state: AppState) => boolean;
  /** When this returns true the footer button becomes a secondary "Exit" that closes the installer. */
  exitWhen?: (state: AppState) => boolean;
  /** Moves on by itself as soon as this returns true: to `advanceTo`, or else the next step. */
  advanceWhen?: (state: AppState) => boolean;
  /** Step id `advanceWhen` moves to. Omitted: the next step. */
  advanceTo?: string;
};

export const STEPS = [
  {
    id: 'get-ready',
    title: 'Get ready',
    description: 'Check your PC',
    Content: GetReadyPage,
    // Shows the system check's progress (or what blocks it) until it is done.
    footerNote: <GetReadyFooterNote />,
    actionLabel: 'Get Started',
    // The system check must have finished, and found enough disk space (unknown space does not block).
    canProceed: (state) => state.probe !== null && !diskTooLow(state.probe),
    // The check failed or found a blocker: setup can't go on, so offer to close the installer instead.
    exitWhen: (state) => {
      const { kind } = requirementsStatus(state.probe, state.probeError);
      return kind === 'error' || kind === 'blocked';
    },
    // Nothing to install (Ollama, Docker, the model and the running dev container are there): skip to Finish.
    advanceWhen: (state) => everythingInstalled(state.probe),
    advanceTo: 'finish',
  },
  {
    id: 'install',
    title: 'Install',
    description: 'Set up the app',
    Content: InstallPage,
    footerNote: 'Please don\'t turn off your computer',
    // No footer button: once every install step has succeeded, go straight to Finish.
    advanceWhen: (state) => state.install.summary?.exitCode === 0 && !state.install.running,
  },
  {
    id: 'finish',
    title: 'Finish',
    description: 'Open and go',
    Content: FinishPage,
    footerNote: null,
    actionLabel: 'Launch Enterprise Brain',
    // Opens the launch URL from app-config.json (main process) in the default browser.
    onAction: () => installerApi.launchApp(),
  },
] as const satisfies readonly AppStep[];

export type StepId = (typeof STEPS)[number]['id'];
