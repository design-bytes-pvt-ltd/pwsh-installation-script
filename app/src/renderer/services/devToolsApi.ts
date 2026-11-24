/**
 * The only module that talks to the development-only preload bridge (`window.devToolsApi`).
 * It exists in unpackaged builds only; see src/main/preload.ts.
 */
export const devToolsApi = {
  isAvailable: (): boolean => typeof window !== 'undefined' && window.devToolsApi != null,
  /** Screenshot of the page as a PNG data URL. */
  capturePage: (): Promise<string> => {
    const api = window.devToolsApi;
    if (!api) return Promise.reject(new Error('Screenshot capture is only available in development builds (npm run dev).'));
    return api.capturePage();
  },
};
