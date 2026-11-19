import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeModelBudget, GpuInfo, parseNvidiaSmiOutput, parseRocmSmiJson } from '../hardware';
import { buildModelRows } from '../models';
import { InstalledModelInfo, ModelBudget, ModelCatalogEntry } from '../types';

// Expected model rows, tiers, defaults and budgets for edge-case inputs.
const fixturePath = path.join(__dirname, 'fixtures', 'model-rows.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  catalog: ModelCatalogEntry[];
  installed: Array<{ key: string; name: string; sizeGB: number }>;
  rowOrder: string[];
  installedNames: string[];
  rowCases: Array<{ label: string; budget: { budgetGB: number; ramGB: number } | null; tiers: string[]; default: string }>;
  budgetCases: Array<{ ramGB: number | null; gpu: GpuInfo | null; appleSilicon: boolean; expected: { budgetGB: number; source: string } | null }>;
  gpuParsing: { nvidiaSmi: { output: string; expectedGB: number }; rocmSmi: { output: string; expectedGB: number } };
};

const installed = new Map<string, InstalledModelInfo>(fixture.installed.map((m) => [m.key, { name: m.name, sizeGB: m.sizeGB }]));

describe('model rows and budgets (fixtures/model-rows.json)', () => {
  for (const c of fixture.rowCases) {
    it(`builds the rows: ${c.label}`, () => {
      const budget: ModelBudget | null = c.budget ? { ...c.budget, source: 'fixture' } : null;
      const rows = buildModelRows(fixture.catalog, installed, budget);
      expect(rows.map((r) => r.name)).toEqual(fixture.rowOrder);
      expect(rows.map((r) => r.tier)).toEqual(c.tiers);
      expect(rows.filter((r) => r.isDefault).map((r) => r.name)).toEqual([c.default]);
      expect(rows.filter((r) => r.installed).map((r) => r.name)).toEqual(fixture.installedNames);
    });
  }

  for (const c of fixture.budgetCases) {
    it(`computes the budget: ram=${c.ramGB} gpu=${c.gpu?.vendor ?? 'none'} apple=${c.appleSilicon}`, () => {
      const budget = computeModelBudget(c.ramGB, c.gpu, c.appleSilicon ? 'macos' : 'linux', c.appleSilicon ? 'arm64' : 'amd64');
      expect(budget ? { budgetGB: budget.budgetGB, source: budget.source } : null).toEqual(c.expected);
    });
  }

  it('parses GPU tool output', () => {
    expect(parseNvidiaSmiOutput(fixture.gpuParsing.nvidiaSmi.output)).toBe(fixture.gpuParsing.nvidiaSmi.expectedGB);
    expect(parseRocmSmiJson(fixture.gpuParsing.rocmSmi.output)).toBe(fixture.gpuParsing.rocmSmi.expectedGB);
  });
});
