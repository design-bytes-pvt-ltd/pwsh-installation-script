import { useEffect } from 'react';
import { installerApi } from '@/services/installerApi';
import { useAppDispatch } from '@/store';

/** Feeds install events from the main process into the store for as long as the app is mounted. */
export function useInstallerEvents(): void {
  const dispatch = useAppDispatch();
  useEffect(() => installerApi.onEvent((event) => dispatch({ type: 'installEvent', event })), [dispatch]);
}
