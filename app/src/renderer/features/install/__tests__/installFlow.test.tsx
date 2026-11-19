// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { ModelPicker } from '@/features/models';
import { useProbe } from '@/features/system';
import { AppStoreProvider, useAppState } from '@/store';
import { installFakeInstallerApi, polyfillResizeObserver, type FakeInstaller } from '@/test/fakeInstallerApi';
import {
  FailureList,
  InstallOptions,
  LogViewer,
  ResultList,
  StepList,
  summaryTitle,
  useInstallActions,
  useInstallerEvents,
} from '..';

/**
 * Exercises the install feature end to end through its own components, with no pages involved:
 * the same building blocks a future screen will compose.
 */
function Harness() {
  useProbe();
  useInstallerEvents();
  const { install } = useAppState();
  const { canStart, start, cancel, copyErrorReport, showLog } = useInstallActions();
  const summary = install.summary;
  return (
    <>
      <InstallOptions />
      <ModelPicker
        action={
          <Button disabled={!canStart} onClick={() => void start()}>
            Start
          </Button>
        }
      />
      <StepList />
      <p data-testid="progress">{install.progressLabel}</p>
      <Button disabled={install.cancelling} onClick={() => void cancel()}>
        Cancel
      </Button>
      <LogViewer lines={install.logLines} />
      {summary && (
        <section aria-label="Summary">
          <h2>{summaryTitle(summary)}</h2>
          <ResultList results={summary.results} />
          <FailureList failures={summary.failures ?? []} />
          <Button onClick={() => void copyErrorReport()}>Copy report</Button>
          <Button onClick={() => void showLog()}>Show log</Button>
        </section>
      )}
    </>
  );
}

let fake: FakeInstaller;

beforeAll(polyfillResizeObserver);
beforeEach(() => {
  fake = installFakeInstallerApi();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderHarness = async () => {
  render(
    <AppStoreProvider>
      <Harness />
    </AppStoreProvider>
  );
  await screen.findByText('1 selected (4.7 GB to download)');
};

describe('install feature', () => {
  test('options and model selection', async () => {
    await renderHarness();
    expect(screen.getByText('(already installed)')).toBeTruthy();
    expect(screen.getByLabelText('Use Docker Engine instead of Desktop (Linux)')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select tiny'));
    expect(screen.getByText('2 selected (5.2 GB to download)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select None' }));
    expect(screen.getByText('0 selected (0.0 GB to download)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(screen.getByText('1 selected (4.7 GB to download)')).toBeTruthy();
  });

  test('full run: start, events, cancel, summary', async () => {
    await renderHarness();
    fireEvent.click(screen.getByLabelText(/Dry run/));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(fake.api.startInstall).toHaveBeenCalledWith({
      installOllama: true,
      installDocker: true,
      dockerEngineOnLinux: false,
      dryRun: true,
      models: ['llama3'],
    });
    expect(screen.getByTestId('progress').textContent).toBe('Starting setup...');
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      fake.emit({ type: 'step', step: 'Ollama', status: 'done' });
      fake.emit({ type: 'step', step: 'Models', status: 'running', detail: 'llama3' });
      fake.emit({ type: 'progress', step: 'Models', label: 'llama3: pulling', percent: 30 });
      fake.emit({ type: 'log', level: 'info', message: 'Pulling llama3', timestamp: 't' });
    });
    const steps = within(screen.getByRole('list', { name: 'Install steps' }));
    expect(steps.getByText('done')).toBeTruthy();
    expect(steps.getByText('running: llama3')).toBeTruthy();
    expect(screen.getByTestId('progress').textContent).toBe('Models: llama3: pulling');
    expect(screen.getByLabelText('Installer log').textContent).toBe('[info] Pulling llama3\n');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fake.api.cancelInstall).toHaveBeenCalled();
    expect(screen.getByTestId('progress').textContent).toBe('Cancelling...');

    act(() => {
      fake.emit({
        type: 'summary',
        results: { Ollama: 'done', Models: 'FAILED: network', Docker: 'skipped' },
        notes: [],
        exitCode: 1,
        cancelled: false,
        logPath: '/tmp/install.log',
        failures: [{ step: 'Models', summary: 'Download failed', hint: 'Check your connection' }],
      });
    });
    await act(async () => fake.finishInstall());

    const summary = within(screen.getByRole('region', { name: 'Summary' }));
    expect(summary.getByText('Setup Finished with Errors')).toBeTruthy();
    expect(summary.getByText('FAILED: network')).toBeTruthy();
    expect(summary.getByText('Check your connection')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(summary.getByRole('button', { name: 'Copy report' }));
    fireEvent.click(summary.getByRole('button', { name: 'Show log' }));
    expect(fake.api.copyErrorReport).toHaveBeenCalled();
    expect(fake.api.showLog).toHaveBeenCalled();
  });

  test('asks before pulling models that are too large', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderHarness();
    fireEvent.click(screen.getByLabelText('Select giant'));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('giant'));
    expect(fake.api.startInstall).not.toHaveBeenCalled();
  });

  test('reports a failure to start', async () => {
    fake.api.startInstall.mockRejectedValue(new Error('An installation is already running.'));
    await renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(screen.getByTestId('progress').textContent).toBe('Could not start: An installation is already running.')
    );
  });
});
