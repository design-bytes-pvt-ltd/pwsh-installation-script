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
  redact,
  ReportInput,
  SummaryFields,
} from '../errors';

// Expected log text. If you change the report format, hints or masking on purpose, update the fixture.
const fixturePath = path.join(__dirname, 'fixtures', 'error-report.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  reportCases: Array<{ label: string; input: ReportInput; index: number; total: number; hintId: string | null; expected: string }>;
  redactCases: Array<{ input: string; expected: string }>;
  timelineCases: Array<{ time: string; level: string; step: string; message: string; expected: string }>;
  durationCases: Array<{ ms: number; expected: string }>;
  summaryCase: { input: SummaryFields; expected: string };
  cancelledSummaryCase: { input: SummaryFields; expected: string };
  runEndCase: { summary: SummaryFields; reports: ReportInput[]; expected: string };
  headerCase: { input: HeaderFields; expected: string };
};

describe('failure log format (fixtures/error-report.json)', () => {
  for (const c of fixture.reportCases) {
    it(`report: ${c.label}`, () => {
      const report = createErrorReport(c.input);
      expect(report.hintId ?? null).toBe(c.hintId);
      expect(formatFailureReport(report, c.index, c.total)).toBe(c.expected);
    });
  }

  it('redacts secrets', () => {
    for (const c of fixture.redactCases) expect(redact(c.input)).toBe(c.expected);
  });

  it('formats timeline lines', () => {
    for (const c of fixture.timelineCases) expect(formatTimelineLine(c.time, c.level, c.step, c.message)).toBe(c.expected);
  });

  it('formats durations', () => {
    for (const c of fixture.durationCases) expect(formatDuration(c.ms)).toBe(c.expected);
  });

  it('formats the summary, run end and header', () => {
    expect(formatSummary(fixture.summaryCase.input)).toBe(fixture.summaryCase.expected);
    expect(formatSummary(fixture.cancelledSummaryCase.input)).toBe(fixture.cancelledSummaryCase.expected);
    expect(formatRunEnd(fixture.runEndCase.summary, fixture.runEndCase.reports.map(createErrorReport))).toBe(fixture.runEndCase.expected);
    expect(formatHeader(fixture.headerCase.input)).toBe(fixture.headerCase.expected);
  });
});
