// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppStoreProvider, useAppState, type AppState } from '@/store';
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
  fake = installFakeInstallerApi();
});
afterEach(cleanup);

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
    expect(within(content).getByText('world')).toBeTruthy();
    expect(within(content).getByText('Takes about 30 minutes')).toBeTruthy();
    expect(within(content).getByRole('button', { name: 'Get Started' })).toBeTruthy();
  });

  test('the footer button moves to the next step, updating stepper, content and footer', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }));

    expect(activeStep()?.textContent).toContain('Install');
    const content = screen.getByRole('main');
    expect(within(content).queryByText('world')).toBeNull();
    expect(within(content).getByText('Installing…')).toBeTruthy();
    expect(within(content).getByText('This can take a while')).toBeTruthy();

    fireEvent.click(within(content).getByRole('button', { name: 'Continue' }));
    expect(activeStep()?.textContent).toContain('Finish');
    expect(within(content).getByText('All set.')).toBeTruthy();
    expect(within(content).getByRole('button', { name: 'Launch Enterprise Brain' })).toBeTruthy();
  });

  test('probes the system on launch and selects the default models', async () => {
    renderApp();
    await waitFor(() => expect(latest.probe).toEqual(sampleProbe));
    expect(fake.api.probe).toHaveBeenCalledTimes(1);
    expect(latest.selectedModels).toEqual(['llama3']);
  });

  test('records a probe failure', async () => {
    fake.api.probe.mockRejectedValue(new Error('no hardware info'));
    renderApp();
    await waitFor(() => expect(latest.probeError).toBe('no hardware info'));
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
