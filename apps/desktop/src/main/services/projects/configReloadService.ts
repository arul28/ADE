import chokidar, { type FSWatcher } from "chokidar";
import type { Logger } from "../logging/logger";
import type { AdeProjectEvent } from "../../../shared/types";
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
    getSnapshot: () => import("../../../shared/types").AdeProjectSnapshot;
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
  let watcher: FSWatcher | null = null;
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

    args.onEvent?.({
      type: "config-changed",
      at: nowIso(),
      filePath,
      snapshot: args.adeProjectService.getSnapshot(),
    });
  };

  return {
    async start(): Promise<void> {
      if (watcher) return;
      watcher = chokidar.watch(
        [args.paths.sharedPath, args.paths.localPath, args.paths.secretPath],
        {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 150,
            pollInterval: 50,
          },
        },
      );

      const onFsEvent = (filePath: string) => scheduleChange(filePath);
      watcher.on("add", onFsEvent);
      watcher.on("change", onFsEvent);
      watcher.on("unlink", onFsEvent);
    },

    async dispose(): Promise<void> {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      pendingPaths.clear();
      if (!watcher) return;
      await watcher.close();
      watcher = null;
    },
  };
}

export type ConfigReloadService = ReturnType<typeof createConfigReloadService>;
