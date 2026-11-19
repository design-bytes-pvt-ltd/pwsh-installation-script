// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppStoreProvider, useAppState, type AppState } from '@/store';
import { installFakeInstallerApi, sampleProbe, type FakeInstaller } from '@/test/fakeInstallerApi';
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
  test('renders the sidebar and content layout', () => {
    renderApp();
    const sidebar = screen.getByRole('complementary');
    const content = screen.getByRole('main');
    expect(sidebar.textContent).toBe('hello');
    expect(sidebar.className).toContain('bg-sidebar');
    expect(content.textContent).toBe('world');
    expect(content.className).toContain('bg-background');
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
