import type { Logger } from "../logging/logger";
import type { AdeProjectEvent, AdeProjectSnapshot } from "../../../shared/types";
import { watchFileSet, type FileSetWatcher } from "../shared/fileSetWatcher";
import { nowIso } from "../shared/utils";

type ConfigReloadServiceArgs = {
  paths: {
    sharedPath: string;
    localPath: string;
    secretPath: string;
  };
  projectConfigService: {
    get: () => unknown;
  };
  adeProjectService: {
    getSnapshot: () => AdeProjectSnapshot;
  };
  automationService?: {
    reloadFromConfig?: () => void;
  } | null;
  secretService?: {
    reload?: () => unknown;
  } | null;
  logger?: Logger | null;
  onEvent?: (event: AdeProjectEvent) => void;
};

export function createConfigReloadService(args: ConfigReloadServiceArgs) {
  let watcher: FileSetWatcher | null = null;
  let starting = false;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPaths = new Set<string>();

  const flushChanges = (): void => {
    debounceTimer = null;
    const paths = pendingPaths;
    pendingPaths = new Set();
    for (const filePath of paths) {
      handleChange(filePath);
    }
  };

  const scheduleChange = (filePath: string): void => {
    pendingPaths.add(filePath);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushChanges, 300);
  };

  const handleChange = (filePath: string): void => {
    try {
      args.projectConfigService.get();
    } catch (error) {
      args.logger?.warn("project.config_reload.validation_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (filePath === args.paths.secretPath) {
      try {
        args.secretService?.reload?.();
      } catch (error) {
        args.logger?.warn("project.config_reload.secret_reload_failed", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      args.automationService?.reloadFromConfig?.();
    } catch (error) {
      args.logger?.warn("project.config_reload.automation_reload_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // A half-written or malformed local.yaml makes the snapshot read throw.
    // Inside this timer that would escape as an uncaught error and skip the
    // other changed paths; the next write reloads it.
    let snapshot: AdeProjectSnapshot;
    try {
      snapshot = args.adeProjectService.getSnapshot();
    } catch (error) {
      args.logger?.warn("project.config_reload.snapshot_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    args.onEvent?.({
      type: "config-changed",
      at: nowIso(),
      filePath,
      snapshot,
    });
  };

  return {
    async start(): Promise<void> {
      if (watcher || starting) return;
      starting = true;
      disposed = false;
      try {
        // A native watch on each file, with a slow poll only for a file that
        // is missing or refused a watch (`fileSetWatcher.ts`). The debounce
        // below waits for a write to go quiet before the reload reads it.
        const next = await watchFileSet(
          [args.paths.sharedPath, args.paths.localPath, args.paths.secretPath],
          scheduleChange,
        );
        if (disposed) {
          next.close();
          return;
        }
        watcher = next;
      } finally {
        starting = false;
      }
    },

    async dispose(): Promise<void> {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      pendingPaths.clear();
      disposed = true;
      watcher?.close();
      watcher = null;
    },
  };
}

export type ConfigReloadService = ReturnType<typeof createConfigReloadService>;
