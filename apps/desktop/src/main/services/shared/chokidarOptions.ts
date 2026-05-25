import type { ChokidarOptions } from "chokidar";

const MACOS_SAFE_WATCH_OPTIONS: ChokidarOptions = {
  usePolling: true,
  interval: 1_000,
  binaryInterval: 2_000,
};

export function withMacosSafeChokidarOptions(options: ChokidarOptions): ChokidarOptions {
  if (process.platform !== "darwin") return options;
  // Electron's native fs.watch/FSEvents path can block Node's main loop when a
  // watcher is closed while macOS is still registering the stream.
  return {
    ...options,
    ...MACOS_SAFE_WATCH_OPTIONS,
  };
}
