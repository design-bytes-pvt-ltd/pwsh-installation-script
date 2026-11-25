export type TargetOS = 'windows' | 'macos' | 'linux';
export type Arch = 'amd64' | 'arm64';
export type ModelTier = 'recommended' | 'may be slow' | 'too large' | '';
export type DockerKind = 'desktop' | 'engine' | 'none';
/** The dev container started by the install. `unknown`: Docker is installed but not reachable (e.g. not running). */
export type DevContainerStatus = 'running' | 'stopped' | 'missing' | 'unknown';

export interface ModelCatalogEntry {
  name: string;
  description?: string;
  size_gb?: number;
  min_memory_gb?: number;
}

export interface ModelBudget {
  budgetGB: number;
  ramGB: number | null;
  source: string;
}

export interface InstalledModelInfo {
  name: string;
  sizeGB: number | null;
}

export interface ModelRow {
  name: string;
  description: string;
  sizeGB: number | null;
  minMemoryGB: number | null;
  tier: ModelTier;
  installed: boolean;
  isDefault: boolean;
}

/** A graphics card with its own memory, found by nvidia-smi or rocm-smi. */
export interface GpuInfo {
  vendor: 'NVIDIA' | 'AMD';
  vramGB: number;
}

/** Free space on the drive the tools and models install to. */
export interface DiskInfo {
  /** The path that was measured (e.g. "C:\\" or the home folder). */
  path: string;
  freeGB: number;
  requiredGB: number;
}

/** Whether the internet answered during the system check. */
export interface NetworkStatus {
  online: boolean;
  /** Download hosts that did not answer (all of them when offline). */
  unreachable: string[];
}

export interface ProbeResult {
  os: TargetOS;
  arch: Arch;
  budget: ModelBudget | null;
  /** Null when no NVIDIA or AMD graphics card was found (Apple silicon shares memory instead). */
  gpu: GpuInfo | null;
  /** Null when free space could not be measured. */
  disk: DiskInfo | null;
  ollamaInstalled: boolean;
  ollamaPath: string | null;
  dockerInstalled: DockerKind;
  devContainer: DevContainerStatus;
  models: ModelRow[];
  network: NetworkStatus;
}

/** Options the renderer may send. The log path is chosen by the main process, never the renderer. */
export interface InstallOptions {
  installOllama: boolean;
  installDocker: boolean;
  dockerEngineOnLinux: boolean;
  models: string[];
  dryRun?: boolean;
}

export type StepName = 'Ollama' | 'Models' | 'Docker' | 'Containers';

/** Short form of a failure report, for the summary screen. */
export interface FailureSummary {
  step: string;
  summary: string;
  hint?: string;
  /** Id of the matched hint (e.g. "network"), used to build the error code shown to the user. */
  hintId?: string;
}
export type StepStatus = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type InstallEvent =
  | { type: 'step'; step: StepName; status: StepStatus; detail?: string }
  | { type: 'progress'; step: StepName; label: string; completed?: number; total?: number; percent?: number }
  /** `output: true` marks a line printed by an external command (logged as OUT). */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; timestamp: string; output?: boolean }
  | { type: 'note'; message: string }
  | { type: 'summary'; results: Record<string, string>; notes: string[]; exitCode: number; cancelled: boolean; logPath?: string; failures?: FailureSummary[] };
