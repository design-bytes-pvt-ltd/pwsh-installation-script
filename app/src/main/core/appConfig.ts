import fs from 'node:fs';

/** Opened by "Launch Enterprise Brain" when nothing (valid) is configured. */
export const DEFAULT_LAUNCH_URL = 'https://google.com';

/** Only web links: shell.openExternal would also run file:// and custom-protocol handlers. */
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The page "Launch Enterprise Brain" opens: ENTERPRISE_BRAIN_URL (dev override), then `launchUrl`
 * in app-config.json, then the default. Read on every click, so editing the file needs no rebuild.
 */
export function loadLaunchUrl(configPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates: unknown[] = [env.ENTERPRISE_BRAIN_URL];
  try {
    candidates.push((JSON.parse(fs.readFileSync(configPath, 'utf8')) as { launchUrl?: unknown })?.launchUrl);
  } catch {
    // Missing or invalid config: fall through to the default.
  }
  const url = candidates.find(isWebUrl);
  return url ? url.trim() : DEFAULT_LAUNCH_URL;
}
