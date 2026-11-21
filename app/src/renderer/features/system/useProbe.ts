import { useCallback, useEffect } from 'react';
import { errorMessage } from '@/lib/format';
import { installerApi } from '@/services/installerApi';
import { useAppDispatch } from '@/store';

/** How long the Get ready page's requirements check takes at least, so its "checking" text does not just flash. */
export const MIN_REQUIREMENTS_CHECK_MS = 3600;

/**
 * Returns a callback that probes hardware and installed tools (e.g. "Try again"). The result,
 * success or failure, is held back until at least `minDurationMs` has passed since the start.
 * A reprobe keeps the previous probe data in the store until the new result arrives.
 */
export function useReprobe(minDurationMs = 0): () => Promise<void> {
  const dispatch = useAppDispatch();
  return useCallback(async () => {
    dispatch({ type: 'probeStarted' });
    const minDuration = new Promise((resolve) => setTimeout(resolve, minDurationMs));
    try {
      const probe = await installerApi.probe();
      await minDuration;
      dispatch({ type: 'probeLoaded', probe });
    } catch (err) {
      await minDuration;
      dispatch({ type: 'probeFailed', message: errorMessage(err) });
    }
  }, [dispatch, minDurationMs]);
}

/** Probes hardware and installed tools once on mount (taking at least `minDurationMs`). Returns `reprobe`. */
export function useProbe(minDurationMs = 0): () => Promise<void> {
  const reprobe = useReprobe(minDurationMs);

  useEffect(() => {
    void reprobe();
  }, [reprobe]);

  return reprobe;
}
