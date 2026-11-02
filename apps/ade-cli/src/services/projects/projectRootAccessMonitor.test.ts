import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../../../../desktop/src/main/services/projects/readOnlySqlite";
import {
  onProjectRootStorageWaitChange,
  readProjectRootStorageWait,
  reportProjectRootNotAnswering,
} from "./projectRootAccessMonitor";

/** Resolves on the next change the monitor announces. */
function nextChange(): Promise<void> {
  return new Promise((resolve) => {
    const stop = onProjectRootStorageWaitChange(() => {
      stop();
      resolve();
    });
  });
}

describe("projectRootAccessMonitor", () => {
  // A named pipe blocks `open()` until a writer arrives: the same wait a macOS
  // permission prompt or a hung drive puts on a file.
  it.skipIf(process.platform === "win32")(
    "fails fast under a folder whose file hung, and lets it back in once the file answers",
    async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-root-wait-")));
      const hung = path.join(root, "hung");
      execFileSync("mkfifo", [hung]);
      const dbPath = path.join(root, ".ade", "ade.db");
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // A writer opening the pipe answers the probe's pending open.
        void fs.promises.open(hung, "w").then((handle) => handle.close());
      };
      try {
        reportProjectRootNotAnswering(root, "test", { path: hung });

        expect(readProjectRootStorageWait()).toMatchObject({ path: root, reason: "not_answering" });
        // A native open under the folder would join the wait; it fails at once instead.
        expect(() => openReadOnlyDatabase(dbPath)).toThrow(
          expect.objectContaining({ code: "storage_read_failed" }),
        );

        const recovered = nextChange();
        release();
        await recovered;

        expect(readProjectRootStorageWait()).toBeNull();
        // The guard is gone: the open now fails for its own reason (no file), not the wait.
        let error: unknown;
        try {
          openReadOnlyDatabase(dbPath).close();
        } catch (caught) {
          error = caught;
        }
        expect((error as { code?: unknown } | undefined)?.code).not.toBe("storage_read_failed");
      } finally {
        release();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
