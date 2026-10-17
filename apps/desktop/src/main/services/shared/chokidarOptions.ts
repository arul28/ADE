import type { ChokidarOptions } from "chokidar";

const MACOS_SAFE_WATCH_OPTIONS: ChokidarOptions = {
  usePolling: true,
  interval: 1_000,
  binaryInterval: 2_000,
};

export function withMacosSafeChokidarOptions(options: ChokidarOptions): ChokidarOptions {
  if (process.platform !== "darwin") return options;
  // chokidar's native mode opens one watch per directory, and closing a few
  // thousand of them blocks Node's main loop for seconds.
  // Polling costs a check of every path each second, so it is only for a
  // handful of files. A directory tree goes through `watchTree`
  // (`treeWatcher.ts`), which uses one recursive watch on macOS.
  return {
    ...options,
    ...MACOS_SAFE_WATCH_OPTIONS,
  };
}
