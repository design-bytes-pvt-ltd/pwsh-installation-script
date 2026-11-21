import fs from 'node:fs';
import os from 'node:os';
import { execCommand } from './exec';
import { commandExists, getArch, getTargetOS } from './platform';
import type { Arch, DiskInfo, ModelBudget, TargetOS } from '../../shared/types';

/** Free space Ollama, the model and Docker need, in GB. */
export const REQUIRED_DISK_GB = 60;

export interface GpuInfo {
  vendor: 'NVIDIA' | 'AMD';
  vramGB: number;
}

export function getSystemMemoryGB(): number | null {
  const bytes = os.totalmem();
  if (!bytes || bytes <= 0) return null;
  return Math.round((bytes / (1024 ** 3)) * 10) / 10;
}

export function parseNvidiaSmiOutput(output: string): number | null {
  const mib = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number(line));
  if (mib.length === 0) return null;
  return Math.round((Math.max(...mib) / 1024) * 10) / 10;
}

export function parseRocmSmiJson(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const sizes: number[] = [];
    for (const card of Object.values(parsed)) {
      if (!card || typeof card !== 'object') continue;
      for (const [k, v] of Object.entries(card)) {
        if (/vram.*total/i.test(k) && (typeof v === 'number' || typeof v === 'string')) {
          const bytes = Number(v);
          if (Number.isFinite(bytes) && bytes > 0) {
            sizes.push(bytes / (1024 ** 3));
          }
        }
      }
    }
    if (sizes.length === 0) return null;
    return Math.round(Math.max(...sizes) * 10) / 10;
  } catch {
    return null;
  }
}

export async function getGpuMemoryGB(targetOS: TargetOS = getTargetOS()): Promise<GpuInfo | null> {
  const nvidiaSmi = await commandExists('nvidia-smi', targetOS);
  if (nvidiaSmi) {
    try {
      const res = await execCommand(nvidiaSmi, ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
      const vramGB = parseNvidiaSmiOutput(res.stdout);
      if (vramGB) return { vendor: 'NVIDIA', vramGB };
    } catch {
      // Ignore probe failure and fall through
    }
  }

  const rocmSmi = await commandExists('rocm-smi', targetOS);
  if (rocmSmi) {
    try {
      const res = await execCommand(rocmSmi, ['--showmeminfo', 'vram', '--json']);
      const vramGB = parseRocmSmiJson(res.stdout);
      if (vramGB) return { vendor: 'AMD', vramGB };
    } catch {
      // Ignore probe failure and fall through
    }
  }

  return null;
}

export function computeModelBudget(
  ramGB: number | null,
  gpu: GpuInfo | null,
  targetOS: TargetOS,
  arch: Arch
): ModelBudget | null {
  if (gpu) {
    return {
      budgetGB: gpu.vramGB,
      ramGB,
      source: `${gpu.vendor} GPU with ${gpu.vramGB} GB VRAM`,
    };
  }
  if (!ramGB) return null;
  if (targetOS === 'macos' && arch === 'arm64') {
    return {
      budgetGB: Math.round(ramGB * 0.65 * 10) / 10,
      ramGB,
      source: `Apple silicon with ${ramGB} GB unified memory`,
    };
  }
  return {
    budgetGB: Math.round(ramGB * 0.5 * 10) / 10,
    ramGB,
    source: `CPU with ${ramGB} GB RAM`,
  };
}

export async function getModelBudget(targetOS: TargetOS = getTargetOS()): Promise<ModelBudget | null> {
  const ramGB = getSystemMemoryGB();
  const gpu = await getGpuMemoryGB(targetOS);
  const arch = await getArch(targetOS);
  return computeModelBudget(ramGB, gpu, targetOS, arch);
}

/** The folder whose drive gets Ollama, the models and Docker: the system drive on Windows, else home. */
export function diskCheckPath(targetOS: TargetOS, env: NodeJS.ProcessEnv = process.env): string {
  if (targetOS === 'windows') return `${env.SystemDrive || 'C:'}\\`;
  return os.homedir();
}

/** Free space from a statfs result (space available to unprivileged users), rounded to 0.1 GB. */
export function computeDiskInfo(stats: { bavail: number | bigint; bsize: number | bigint }, diskPath: string): DiskInfo {
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  return { path: diskPath, freeGB: Math.round((freeBytes / (1024 ** 3)) * 10) / 10, requiredGB: REQUIRED_DISK_GB };
}

export async function getDiskInfo(targetOS: TargetOS = getTargetOS()): Promise<DiskInfo | null> {
  const diskPath = diskCheckPath(targetOS);
  try {
    return computeDiskInfo(await fs.promises.statfs(diskPath), diskPath);
  } catch {
    return null;
  }
}
