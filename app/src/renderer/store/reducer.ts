import type { InstallEvent, ProbeResult, StepName, StepStatus } from '../../shared/types';

export type Screen = 'configure' | 'progress' | 'summary';
export type SummaryEvent = Extract<InstallEvent, { type: 'summary' }>;

export const STEP_NAMES: readonly StepName[] = ['Ollama', 'Models', 'Docker'];

export interface StepState {
  status: StepStatus | 'pending';
  detail?: string;
}

export interface InstallOptionsState {
  installOllama: boolean;
  installDocker: boolean;
  dockerEngineOnLinux: boolean;
  dryRun: boolean;
}

export interface InstallState {
  steps: Record<StepName, StepState>;
  progressLabel: string;
  /** 0–100. */
  percent: number;
  /** Formatted log lines, each ending in "\n". */
  logLines: string[];
  /** True while startInstall() is in flight (the whole run). Disables Start. */
  running: boolean;
  /** True once Cancel was pressed for this run. Disables Cancel. */
  cancelling: boolean;
  summary: SummaryEvent | null;
}

export interface AppState {
  screen: Screen;
  probe: ProbeResult | null;
  /** Set when the last probe failed. Older probe data, if any, is kept. */
  probeError: string | null;
  /** Selected model names, in selection order. */
  selectedModels: string[];
  options: InstallOptionsState;
  install: InstallState;
}

export type Action =
  | { type: 'probeLoaded'; probe: ProbeResult }
  | { type: 'probeFailed'; message: string }
  | { type: 'modelToggled'; name: string; selected: boolean }
  | { type: 'selectionCleared' }
  | { type: 'selectionReset' }
  | { type: 'optionChanged'; key: keyof InstallOptionsState; value: boolean }
  | { type: 'installStarting' }
  | { type: 'installStartFailed'; message: string }
  | { type: 'installSettled' }
  | { type: 'cancelRequested' }
  | { type: 'installEvent'; event: InstallEvent }
  | { type: 'backToStart' };

function freshInstall(): InstallState {
  return {
    steps: { Ollama: { status: 'pending' }, Models: { status: 'pending' }, Docker: { status: 'pending' } },
    progressLabel: 'Preparing...',
    percent: 0,
    logLines: [],
    running: false,
    cancelling: false,
    summary: null,
  };
}

export const initialState: AppState = {
  screen: 'configure',
  probe: null,
  probeError: null,
  selectedModels: [],
  options: { installOllama: true, installDocker: true, dockerEngineOnLinux: false, dryRun: false },
  install: freshInstall(),
};

function defaultSelection(probe: ProbeResult | null): string[] {
  return (probe?.models ?? []).filter((m) => m.isDefault).map((m) => m.name);
}

function applyInstallEvent(state: AppState, event: InstallEvent): AppState {
  const install = state.install;
  switch (event.type) {
    case 'step':
      return {
        ...state,
        install: { ...install, steps: { ...install.steps, [event.step]: { status: event.status, detail: event.detail } } },
      };
    case 'progress':
      return {
        ...state,
        install: {
          ...install,
          progressLabel: `${event.step}: ${event.label}`,
          percent: typeof event.percent === 'number' ? event.percent : install.percent,
        },
      };
    case 'log':
      return {
        ...state,
        install: { ...install, logLines: [...install.logLines, `[${event.level}] ${event.message}\n`] },
      };
    case 'summary':
      return { ...state, screen: 'summary', install: { ...install, summary: event } };
    default:
      // 'note' events are only collected into the summary by the main process.
      return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'probeLoaded':
      return { ...state, probe: action.probe, probeError: null, selectedModels: defaultSelection(action.probe) };
    case 'probeFailed':
      return { ...state, probeError: action.message };
    case 'modelToggled': {
      const without = state.selectedModels.filter((n) => n !== action.name);
      return { ...state, selectedModels: action.selected ? [...without, action.name] : without };
    }
    case 'selectionCleared':
      return { ...state, selectedModels: [] };
    case 'selectionReset':
      return { ...state, selectedModels: defaultSelection(state.probe) };
    case 'optionChanged':
      return { ...state, options: { ...state.options, [action.key]: action.value } };
    case 'installStarting':
      return {
        ...state,
        screen: 'progress',
        install: { ...freshInstall(), progressLabel: 'Starting setup...', running: true },
      };
    case 'installStartFailed':
      return { ...state, install: { ...state.install, progressLabel: `Could not start: ${action.message}` } };
    case 'installSettled':
      return { ...state, install: { ...state.install, running: false } };
    case 'cancelRequested':
      return { ...state, install: { ...state.install, cancelling: true, progressLabel: 'Cancelling...' } };
    case 'installEvent':
      return applyInstallEvent(state, action.event);
    case 'backToStart':
      return { ...state, screen: 'configure' };
  }
}
