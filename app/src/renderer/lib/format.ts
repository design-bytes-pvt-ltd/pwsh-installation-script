/** "4.7 GB", or "?" when the size is unknown. */
export function formatGB(sizeGB: number | null | undefined): string {
  return sizeGB ? `${sizeGB.toFixed(1)} GB` : '?';
}

/** Message text from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
