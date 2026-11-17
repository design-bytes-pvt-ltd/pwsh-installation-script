export type TargetOS = 'windows' | 'macos' | 'linux';
export type Arch = 'amd64' | 'arm64';
export type ModelTier = 'recommended' | 'may be slow' | 'too large' | '';
export type DockerKind = 'desktop' | 'engine' | 'none';

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

export interface ProbeResult {
  os: TargetOS;
  arch: Arch;
  budget: ModelBudget | null;
  ollamaInstalled: boolean;
  ollamaPath: string | null;
  dockerInstalled: DockerKind;
  models: ModelRow[];
}

export interface InstallOptions {
  installOllama: boolean;
  installDocker: boolean;
  dockerEngineOnLinux: boolean;
  models: string[];
  dryRun?: boolean;
  logPath?: string;
}

export type InstallEvent =
  | { type: 'step'; step: 'Ollama' | 'Models' | 'Docker'; status: 'running' | 'done' | 'skipped' | 'failed'; detail?: string }
  | { type: 'progress'; step: 'Ollama' | 'Models' | 'Docker'; label: string; completed?: number; total?: number; percent?: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; timestamp: string }
  | { type: 'note'; message: string }
  | { type: 'summary'; results: Record<string, string>; notes: string[]; exitCode: number };
