// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MIN_REQUIREMENTS_CHECK_MS } from '@/features/system';
import { AppStoreProvider, useAppState, type AppState, type SummaryEvent } from '@/store';
import { installFakeInstallerApi, sampleProbe, type FakeInstaller } from '@/test/fakeInstallerApi';
import { APP_VERSION } from '@/lib/version';
import { App } from '../App';

let fake: FakeInstaller;
let latest: AppState;

/** Reads the store, to check the logic is still wired up behind the placeholder UI. */
function StateSpy() {
  latest = useAppState();
  return null;
}

beforeEach(() => {
  // The requirements check takes at least MIN_REQUIREMENTS_CHECK_MS; tests skip ahead with finishCheck().
  // shouldAdvanceTime keeps waitFor's polling running on the fake clock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fake = installFakeInstallerApi();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Advances the clock by `ms` (default: the requirements check's minimum duration). */
const advance = (ms = MIN_REQUIREMENTS_CHECK_MS) => act(() => vi.advanceTimersByTimeAsync(ms));

const renderApp = () =>
  render(
    <AppStoreProvider>
      <App />
      <StateSpy />
    </AppStoreProvider>
  );

describe('App', () => {
  const activeStep = () =>
    within(screen.getByRole('complementary'))
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('aria-current') === 'step');

  test('renders the sidebar and content layout on the first step', () => {
    renderApp();
    const sidebar = screen.getByRole('complementary');
    const content = screen.getByRole('main');
    expect(sidebar.className).toContain('bg-sidebar');
    expect(sidebar.textContent).toContain(`Version: ${APP_VERSION}`);
    for (const title of ['Get ready', 'Install', 'Finish']) {
      expect(within(sidebar).getByText(title)).toBeTruthy();
    }
    expect(activeStep()?.textContent).toContain('Get ready');

    expect(content.className).toContain('bg-background');
    expect(within(content).getByRole('heading', { name: 'Welcome to Enterprise Brain' })).toBeTruthy();
    expect(within(content).getByText('Checking system requirements…')).toBeTruthy();
    expect(within(content).getByRole('button', { name: 'Get Started' })).toBeTruthy();
  });

  const footerButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name }) as HTMLButtonElement;
  const summary = (exitCode: number): SummaryEvent => ({ type: 'summary', results: {}, notes: [], exitCode, cancelled: false, failures: [] });

  /** Renders the app, waits for the probe and moves to the Install step. */
  const goToInstall = async () => {
    renderApp();
    await advance();
    expect(footerButton('Get Started').disabled).toBe(false);
    fireEvent.click(footerButton('Get Started'));
  };

  test('the footer says the requirements are being checked for at least 5 s, and Get Started waits for it', async () => {
    renderApp();
    expect(footerButton('Get Started').disabled).toBe(true);
    expect(screen.getByText('Checking system requirements…')).toBeTruthy();

    // The probe itself resolves at once, but the result is held back until 5 s have passed.
    await advance(MIN_REQUIREMENTS_CHECK_MS - 100);
    expect(fake.api.probe).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Checking system requirements…')).toBeTruthy();
    expect(footerButton('Get Started').disabled).toBe(true);

    await advance(100);
    expect(footerButton('Get Started').disabled).toBe(false);
    expect(screen.queryByText('Checking system requirements…')).toBeNull();
    expect(screen.getByText('Takes about 30 minutes')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'System check' })).toBeNull();
  });

  test('Get Started stays disabled when there is not enough disk space', async () => {
    installFakeInstallerApi({ ...sampleProbe, disk: { path: 'C:\\', freeGB: 20, requiredGB: 60 } });
    renderApp();
    await advance();
    expect(screen.getByText('Not enough disk space: 20.0 GB free on C:\\, needs 60 GB')).toBeTruthy();
    expect(footerButton('Get Started').disabled).toBe(true);
  });

  const allInstalled = {
    ...sampleProbe,
    dockerInstalled: 'desktop' as const,
    devContainer: 'running' as const,
    models: sampleProbe.models.map((m) => (m.isDefault ? { ...m, installed: true } : m)),
  };

  test('goes straight to Finish when everything is already installed', async () => {
    fake = installFakeInstallerApi(allInstalled);
    renderApp();
    expect(activeStep()?.textContent).toContain('Get ready');
    await advance();
    expect(activeStep()?.textContent).toContain('Finish');
    expect(fake.api.startInstall).not.toHaveBeenCalled();

    fireEvent.click(footerButton('Launch Enterprise Brain'));
    expect(fake.api.launchApp).toHaveBeenCalledTimes(1);
    expect(activeStep()?.textContent).toContain('Finish');
  });

  test('does not skip the install while the dev container is not running', async () => {
    fake = installFakeInstallerApi({ ...allInstalled, devContainer: 'stopped' });
    renderApp();
    await advance();
    expect(activeStep()?.textContent).toContain('Get ready');
    expect(footerButton('Get Started').disabled).toBe(false);
  });

  test('a failed system check can be retried', async () => {
    fake.api.probe.mockRejectedValueOnce(new Error('no hardware info'));
    renderApp();
    await advance();
    expect(screen.getByText("Couldn't check system requirements: no hardware info")).toBeTruthy();
    expect(footerButton('Get Started').disabled).toBe(true);

    // Retrying shows "checking" again (not the old error) for the minimum duration.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Checking system requirements…')).toBeTruthy();
    expect(screen.queryByText(/Couldn't check/)).toBeNull();
    await advance();
    expect(footerButton('Get Started').disabled).toBe(false);
    expect(fake.api.probe).toHaveBeenCalledTimes(2);
  });

  test('the Install step starts once with the recommended model, has no footer button and moves to Finish on success', async () => {
    await goToInstall();

    expect(activeStep()?.textContent).toContain('Install');
    expect(screen.queryByRole('heading', { name: 'Welcome to Enterprise Brain' })).toBeNull();
    expect(screen.getByText("Please don't turn off your computer")).toBeTruthy();
    await waitFor(() => expect(fake.api.startInstall).toHaveBeenCalledTimes(1));
    expect(fake.api.startInstall).toHaveBeenCalledWith({
      installOllama: true,
      installDocker: true,
      dockerEngineOnLinux: false,
      dryRun: false,
      models: ['llama3'],
    });
    const overall = () => screen.getByRole('progressbar', { name: 'Overall progress' }).textContent;
    expect(overall()).toBe('0%');
    expect(screen.getByText('AI model')).toBeTruthy();
    expect(screen.getByText('Dev container')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    act(() => fake.emit({ type: 'step', step: 'Ollama', status: 'done', detail: 'already present' }));
    act(() => fake.emit({ type: 'progress', step: 'Models', label: 'llama3: pulling', percent: 50 }));
    // Four equal stages: Ollama done (100) + the model half way (50) = 150 / 4.
    expect(overall()).toBe('38%');
    expect(activeStep()?.textContent).toContain('Install');

    await act(async () => {
      fake.emit(summary(0));
      fake.finishInstall();
    });
    expect(activeStep()?.textContent).toContain('Finish');
    expect(screen.getByRole('heading', { name: 'Enterprise Brain is ready' })).toBeTruthy();
    expect(footerButton('Launch Enterprise Brain')).toBeTruthy();
    expect(fake.api.startInstall).toHaveBeenCalledTimes(1);
  });

  test('a failed install stays on the Install step and offers Retry', async () => {
    await goToInstall();
    await waitFor(() => expect(fake.api.startInstall).toHaveBeenCalledTimes(1));

    await act(async () => {
      fake.emit({ ...summary(1), failures: [{ step: 'Docker', summary: 'download failed', hint: 'Check your connection' }] });
      fake.finishInstall();
    });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('download failed')).toBeTruthy();
    expect(activeStep()?.textContent).toContain('Install');

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fake.api.startInstall).toHaveBeenCalledTimes(2));
    expect(fake.api.startInstall.mock.calls[1][0].models).toEqual(['llama3']);
  });

  test('an install that cannot start offers Retry', async () => {
    fake.api.startInstall.mockRejectedValueOnce(new Error('An installation is already running.'));
    await goToInstall();
    await waitFor(() =>
      expect(screen.getByText('Setup could not start: An installation is already running.')).toBeTruthy()
    );
    expect(activeStep()?.textContent).toContain('Install');
  });

  test('probes the system on launch and selects the default models', async () => {
    renderApp();
    await advance();
    expect(latest.probe).toEqual(sampleProbe);
    expect(fake.api.probe).toHaveBeenCalledTimes(1);
    expect(latest.selectedModels).toEqual(['llama3']);
  });

  test('records a probe failure', async () => {
    fake.api.probe.mockRejectedValue(new Error('no hardware info'));
    renderApp();
    await advance();
    expect(latest.probeError).toBe('no hardware info');
  });

  test('feeds installer events into the store', () => {
    renderApp();
    expect(fake.api.onEvent).toHaveBeenCalledTimes(1);
    act(() => {
      fake.emit({ type: 'step', step: 'Docker', status: 'running' });
      fake.emit({ type: 'log', level: 'info', message: 'hi', timestamp: 't' });
    });
    expect(latest.install.steps.Docker.status).toBe('running');
    expect(latest.install.logLines).toEqual(['[info] hi\n']);
  });
});
