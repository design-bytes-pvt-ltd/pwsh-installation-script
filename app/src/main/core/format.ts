/** Bytes as progress text, in the decimal units Docker uses: "850 KB", "312 MB", "1.21 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Elapsed time as progress text: "45s", "2m 10s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** A rough time left for a download: "about 40 sec left", "about 3 min left", "about 2 h left". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} sec left`;
  if (seconds < 5_400) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${Math.round(seconds / 3_600)} h left`;
}
