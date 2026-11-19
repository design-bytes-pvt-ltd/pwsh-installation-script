import { useCallback, useEffect } from 'react';
import { errorMessage } from '@/lib/format';
import { installerApi } from '@/services/installerApi';
import { useAppDispatch } from '@/store';

/**
 * Probes hardware and installed tools once on mount. Returns `reprobe` for "Back to Start".
 * A reprobe keeps the previous data on screen until the new result arrives.
 */
export function useProbe(): () => Promise<void> {
  const dispatch = useAppDispatch();

  const reprobe = useCallback(async () => {
    try {
      dispatch({ type: 'probeLoaded', probe: await installerApi.probe() });
    } catch (err) {
      dispatch({ type: 'probeFailed', message: errorMessage(err) });
    }
  }, [dispatch]);

  useEffect(() => {
    void reprobe();
  }, [reprobe]);

  return reprobe;
}
