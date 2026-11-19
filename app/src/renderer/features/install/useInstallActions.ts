import { useCallback } from 'react';
import { tooLargeSelected } from '@/features/models';
import { errorMessage } from '@/lib/format';
import { installerApi } from '@/services/installerApi';
import { useAppDispatch, useAppState } from '@/store';

export function useInstallActions() {
  const { probe, selectedModels, options, install } = useAppState();
  const dispatch = useAppDispatch();

  /** Start needs probe results and no run in progress. */
  const canStart = probe !== null && !install.running;

  /** Starts an install with the current options and selection. Resolves when the run ends. */
  const start = useCallback(async () => {
    if (!probe) return;
    const tooLarge = tooLargeSelected(probe.models, selectedModels);
    if (tooLarge.length > 0) {
      const ok = window.confirm(
        `The following models are tagged "too large" for this machine: ${tooLarge.map((m) => m.name).join(', ')}. Pull anyway?`
      );
      if (!ok) return;
    }

    dispatch({ type: 'installStarting' });
    try {
      await installerApi.startInstall({ ...options, models: [...selectedModels] });
    } catch (err) {
      dispatch({ type: 'installStartFailed', message: errorMessage(err) });
    } finally {
      dispatch({ type: 'installSettled' });
    }
  }, [probe, selectedModels, options, dispatch]);

  const cancel = useCallback(async () => {
    dispatch({ type: 'cancelRequested' });
    await installerApi.cancelInstall();
  }, [dispatch]);

  /** Copies the failure report of the last run. Resolves false when there was nothing to copy. */
  const copyErrorReport = useCallback(() => installerApi.copyErrorReport(), []);

  /** Reveals the last run's log file in the file manager. */
  const showLog = useCallback(() => installerApi.showLog(), []);

  return { canStart, start, cancel, copyErrorReport, showLog };
}
