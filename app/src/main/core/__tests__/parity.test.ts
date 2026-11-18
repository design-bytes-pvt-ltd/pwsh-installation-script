import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeModelBudget, GpuInfo, parseNvidiaSmiOutput, parseRocmSmiJson } from '../hardware';
import { buildModelRows } from '../models';
import { InstalledModelInfo, ModelBudget, ModelCatalogEntry } from '../types';

// Shared with tests/Install.Tests.ps1 so the app and install.ps1 can't drift apart.
const fixturePath = path.resolve(__dirname, '../../../../../tests/fixtures/model-rows.parity.json');
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

describe('parity with install.ps1 (tests/fixtures/model-rows.parity.json)', () => {
  for (const c of fixture.rowCases) {
    it(`builds the same rows: ${c.label}`, () => {
      const budget: ModelBudget | null = c.budget ? { ...c.budget, source: 'fixture' } : null;
      const rows = buildModelRows(fixture.catalog, installed, budget);
      expect(rows.map((r) => r.name)).toEqual(fixture.rowOrder);
      expect(rows.map((r) => r.tier)).toEqual(c.tiers);
      expect(rows.filter((r) => r.isDefault).map((r) => r.name)).toEqual([c.default]);
      expect(rows.filter((r) => r.installed).map((r) => r.name)).toEqual(fixture.installedNames);
    });
  }

  for (const c of fixture.budgetCases) {
    it(`computes the same budget: ram=${c.ramGB} gpu=${c.gpu?.vendor ?? 'none'} apple=${c.appleSilicon}`, () => {
      const budget = computeModelBudget(c.ramGB, c.gpu, c.appleSilicon ? 'macos' : 'linux', c.appleSilicon ? 'arm64' : 'amd64');
      expect(budget ? { budgetGB: budget.budgetGB, source: budget.source } : null).toEqual(c.expected);
    });
  }

  it('parses GPU tool output the same way', () => {
    expect(parseNvidiaSmiOutput(fixture.gpuParsing.nvidiaSmi.output)).toBe(fixture.gpuParsing.nvidiaSmi.expectedGB);
    expect(parseRocmSmiJson(fixture.gpuParsing.rocmSmi.output)).toBe(fixture.gpuParsing.rocmSmi.expectedGB);
  });
});
