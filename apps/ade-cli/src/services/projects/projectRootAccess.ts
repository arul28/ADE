import { execFile } from "node:child_process";
import os from "node:os";
import { codedError } from "../../../../desktop/src/shared/codedError";

/**
 * How long a project folder gets to answer a listing before the project is
 * treated as unreadable. A healthy folder answers in milliseconds.
 */
const PROJECT_ROOT_READ_TIMEOUT_MS = 4_000;

/**
 * Refuses to start a project whose folder this process cannot read right now,
 * asked from a child process so the brain's event loop never waits on it.
 *
 * macOS gates folders on an external drive, and in Desktop, Documents and
 * Downloads, behind a privacy permission kept per program. A program without
 * it waits inside `open()` until someone answers the prompt on that Mac's
 * screen, and opening a project is a run of synchronous reads: the first one
 * froze the whole brain, the wedge guard restarted it, and the restart froze
 * the same way (Mac Studio, 2026-10-27, 33 minutes offline). The listing here
 * hits the same gate; when it hangs or is refused, only this project fails, with
 * a reason, and the brain keeps serving the rest of the machine.
 *
 * macOS only: other platforms have no such per-program gate.
 */
export async function assertProjectRootReadable(projectRoot: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const failure = await new Promise<string | null>((resolve) => {
    execFile(
      "/bin/ls",
      ["-a", projectRoot],
      { timeout: PROJECT_ROOT_READ_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve(null);
          return;
        }
        if ((error as { killed?: boolean }).killed) {
          resolve(`it did not answer within ${PROJECT_ROOT_READ_TIMEOUT_MS / 1000} seconds`);
          return;
        }
        resolve(String(stderr ?? "").trim() || error.message);
      },
    );
  });
  if (!failure) return;
  throw codedError(
    `ADE can't read ${projectRoot} on ${os.hostname()} (${failure}). If macOS is asking on that Mac's screen whether ADE may use this drive or folder, allow it; if the drive is not responding, reconnect it. The project opens once it can be read.`,
    "storage_read_failed",
  );
}
