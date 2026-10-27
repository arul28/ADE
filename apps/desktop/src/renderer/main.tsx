/**
 * Outside Electron (a Vite-only preview) the browser mock stubs \`window.ade\`
 * before any app module runs. Inside Electron the preload has already set it,
 * and the mock (about 300 KB) is never loaded: it used to be part of every
 * launch. The test is the mock's own: a real preload has \`sync.getStatus\`.
 */
const w = window as unknown as { ade?: { sync?: { getStatus?: unknown } }; __adeBrowserMock?: unknown };
const hasElectronPreload = Boolean(w.ade && !w.__adeBrowserMock && typeof w.ade.sync?.getStatus === "function");
void (async () => {
  if (!hasElectronPreload) await import("./browserMock");
  await import("./rendererBoot");
})();

export {};
