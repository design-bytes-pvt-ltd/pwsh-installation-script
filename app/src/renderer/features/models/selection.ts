import type { ModelRow, ModelTier } from '../../../shared/types';

/** GB still to download for the selection (installed models and unknown sizes count as 0). */
export function downloadSizeGB(models: readonly ModelRow[], selected: readonly string[]): number {
  const chosen = new Set(selected);
  return models.reduce((sum, m) => (chosen.has(m.name) && !m.installed && m.sizeGB ? sum + m.sizeGB : sum), 0);
}

export function selectionSummary(models: readonly ModelRow[], selected: readonly string[]): string {
  return `${selected.length} selected (${downloadSizeGB(models, selected).toFixed(1)} GB to download)`;
}

/** The model the installer pulls: the one the main process marked as the default for this machine. */
export function recommendedModel(models: readonly ModelRow[]): ModelRow | null {
  return models.find((m) => m.isDefault) ?? null;
}

/** Selected models tagged "too large" for this machine. */
export function tooLargeSelected(models: readonly ModelRow[], selected: readonly string[]): ModelRow[] {
  const chosen = new Set(selected);
  return models.filter((m) => chosen.has(m.name) && m.tier === 'too large');
}

/** Text color for a model's fit tier. */
export function tierClassName(tier: ModelTier): string {
  if (tier === 'recommended') return 'text-success';
  if (tier === 'may be slow') return 'text-warning';
  return 'text-muted-foreground';
}
