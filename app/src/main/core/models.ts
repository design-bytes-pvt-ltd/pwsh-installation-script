import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTargetOS } from './platform';
import type { InstalledModelInfo, ModelBudget, ModelCatalogEntry, ModelRow, ModelTier, TargetOS } from '../../shared/types';

const FALLBACK_CATALOG: ModelCatalogEntry[] = [
  { name: 'qwen3:0.6b', description: 'Qwen3 0.6B (built-in default)', size_gb: 0.5, min_memory_gb: 2 },
];

export function normalizeModelKey(name: string): string {
  let n = name.trim().toLowerCase();
  if (!/:[^/]+$/.test(n)) n += ':latest';
  if (n.startsWith('registry.ollama.ai/')) n = n.slice('registry.ollama.ai/'.length);
  if (n.startsWith('library/')) n = n.slice('library/'.length);
  return n;
}

export function getModelMinMemory(model: ModelCatalogEntry): number | null {
  if (typeof model.min_memory_gb === 'number' && model.min_memory_gb > 0) return model.min_memory_gb;
  if (typeof model.size_gb === 'number' && model.size_gb > 0) return Math.ceil(model.size_gb * 1.2 + 1);
  return null;
}

export function getModelTier(model: ModelCatalogEntry, budget: ModelBudget | null): ModelTier {
  const need = getModelMinMemory(model);
  if (!budget || need === null) return '';
  if (need <= budget.budgetGB) return 'recommended';
  const ram = budget.ramGB ?? budget.budgetGB;
  if (need <= ram) return 'may be slow';
  return 'too large';
}

export function loadModelCatalog(catalogPath?: string): ModelCatalogEntry[] {
  if (!catalogPath || !fs.existsSync(catalogPath)) return FALLBACK_CATALOG;
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as { models?: ModelCatalogEntry[] };
    const models = (parsed.models ?? []).filter((m) => m && typeof m.name === 'string' && m.name.trim().length > 0);
    return models.length > 0 ? models : FALLBACK_CATALOG;
  } catch {
    return FALLBACK_CATALOG;
  }
}

export function getOllamaBaseUrl(envHost: string | undefined = process.env.OLLAMA_HOST): string {
  const raw = (envHost ?? '').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  const host = ['0.0.0.0', '::', '[::]'].includes(url.hostname) ? '127.0.0.1' : url.hostname;
  const hasExplicitPort = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:]+):(\d+)/.test(withScheme);
  const port = hasExplicitPort ? url.port : url.protocol === 'http:' ? '11434' : url.port;
  return port ? `${url.protocol}//${host}:${port}` : `${url.protocol}//${host}`;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export async function getInstalledModels(
  baseUrl: string = getOllamaBaseUrl(),
  targetOS: TargetOS = getTargetOS(),
  env: NodeJS.ProcessEnv = process.env
): Promise<Map<string, InstalledModelInfo>> {
  const installed = new Map<string, InstalledModelInfo>();
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = (await resp.json()) as { models?: Array<{ name?: string; size?: number }> };
      for (const m of data.models ?? []) {
        if (m.name) {
          installed.set(normalizeModelKey(m.name), {
            name: m.name,
            sizeGB: typeof m.size === 'number' ? Math.round((m.size / (1024 ** 3)) * 10) / 10 : null,
          });
        }
      }
      return installed;
    }
  } catch {
    // Fallback to manifest inspection on disk
  }

  const roots: string[] = [];
  if (env.OLLAMA_MODELS) roots.push(env.OLLAMA_MODELS);
  roots.push(path.join(os.homedir(), '.ollama', 'models'));
  if (targetOS === 'linux') roots.push('/usr/share/ollama/.ollama/models');

  for (const root of roots) {
    const manifestsDir = path.join(root, 'manifests');
    for (const file of walkFiles(manifestsDir)) {
      const rel = path.relative(manifestsDir, file).split(path.sep).filter(Boolean);
      if (rel.length < 3) continue;
      let ref = `${rel.slice(0, -1).join('/')}:${rel[rel.length - 1]}`;
      const key = normalizeModelKey(ref);
      if (installed.has(key)) continue;
      ref = ref.replace(/^registry\.ollama\.ai\//, '').replace(/^library\//, '');

      let sizeGB: number | null = null;
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          layers?: Array<{ size?: number }>;
          config?: { size?: number };
        };
        const items = [...(manifest.layers ?? []), ...(manifest.config ? [manifest.config] : [])];
        const totalBytes = items.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
        if (totalBytes > 0) sizeGB = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
      } catch {
        // Ignore malformed manifest
      }
      installed.set(key, { name: ref, sizeGB });
    }
  }

  return installed;
}

export function buildModelRows(
  catalog: ModelCatalogEntry[],
  installed: Map<string, InstalledModelInfo>,
  budget: ModelBudget | null
): ModelRow[] {
  const sortedCatalog = [...catalog].sort(
    (a, b) => (a.size_gb ?? 0) - (b.size_gb ?? 0) || a.name.localeCompare(b.name)
  );
  const catalogKeys = new Set(sortedCatalog.map((m) => normalizeModelKey(m.name)));

  const extras: ModelCatalogEntry[] = [];
  for (const [key, info] of installed.entries()) {
    if (!catalogKeys.has(key)) {
      extras.push({
        name: info.name.replace(/:latest$/, ''),
        description: 'Downloaded earlier (not in models.json)',
        size_gb: info.sizeGB ?? undefined,
      });
    }
  }
  extras.sort((a, b) => (a.size_gb ?? 0) - (b.size_gb ?? 0) || a.name.localeCompare(b.name));

  const combined = [...sortedCatalog, ...extras];
  const rows: ModelRow[] = combined.map((m) => ({
    name: m.name,
    description: m.description ?? '',
    sizeGB: m.size_gb ?? null,
    minMemoryGB: getModelMinMemory(m),
    tier: getModelTier(m, budget),
    installed: installed.has(normalizeModelKey(m.name)),
    isDefault: false,
  }));

  let defaultIndex = -1;
  for (let i = sortedCatalog.length - 1; i >= 0; i--) {
    if (rows[i].tier === 'recommended') {
      defaultIndex = i;
      break;
    }
  }
  if (defaultIndex === -1 && rows.length > 0) defaultIndex = 0;
  if (defaultIndex >= 0) rows[defaultIndex].isDefault = true;

  return rows;
}
