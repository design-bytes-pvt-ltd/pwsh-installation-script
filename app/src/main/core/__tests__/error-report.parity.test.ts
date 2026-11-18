import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createErrorReport,
  formatDuration,
  formatFailureReport,
  formatHeader,
  formatRunEnd,
  formatSummary,
  formatTimelineLine,
  HeaderFields,
  HINTS,
  redact,
  ReportInput,
  SummaryFields,
} from '../errors';

// Shared with tests/Install.Tests.ps1 so the app and install.ps1 write the same log.
const fixturePath = path.resolve(__dirname, '../../../../../tests/fixtures/error-report.parity.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  hints: Array<{ id: string; exitCodes: number[]; pattern: string; text: string }>;
  reportCases: Array<{ label: string; input: ReportInput; index: number; total: number; hintId: string | null; expected: string }>;
  redactCases: Array<{ input: string; expected: string }>;
  timelineCases: Array<{ time: string; level: string; step: string; message: string; expected: string }>;
  durationCases: Array<{ ms: number; expected: string }>;
  summaryCase: { input: SummaryFields; expected: string };
  cancelledSummaryCase: { input: SummaryFields; expected: string };
  runEndCase: { summary: SummaryFields; reports: ReportInput[]; expected: string };
  headerCase: { input: HeaderFields; expected: string };
};

describe('failure log parity with install.ps1 (tests/fixtures/error-report.parity.json)', () => {
  it('uses the same hint table', () => {
    expect(HINTS.map((h) => ({ id: h.id, exitCodes: h.exitCodes ?? [], pattern: h.pattern ?? '', text: h.text }))).toEqual(fixture.hints);
  });

  for (const c of fixture.reportCases) {
    it(`report: ${c.label}`, () => {
      const report = createErrorReport(c.input);
      expect(report.hintId ?? null).toBe(c.hintId);
      expect(formatFailureReport(report, c.index, c.total)).toBe(c.expected);
    });
  }

  it('redacts secrets the same way', () => {
    for (const c of fixture.redactCases) expect(redact(c.input)).toBe(c.expected);
  });

  it('formats timeline lines the same way', () => {
    for (const c of fixture.timelineCases) expect(formatTimelineLine(c.time, c.level, c.step, c.message)).toBe(c.expected);
  });

  it('formats durations the same way', () => {
    for (const c of fixture.durationCases) expect(formatDuration(c.ms)).toBe(c.expected);
  });

  it('formats the summary, run end and header the same way', () => {
    expect(formatSummary(fixture.summaryCase.input)).toBe(fixture.summaryCase.expected);
    expect(formatSummary(fixture.cancelledSummaryCase.input)).toBe(fixture.cancelledSummaryCase.expected);
    expect(formatRunEnd(fixture.runEndCase.summary, fixture.runEndCase.reports.map(createErrorReport))).toBe(fixture.runEndCase.expected);
    expect(formatHeader(fixture.headerCase.input)).toBe(fixture.headerCase.expected);
  });
});
