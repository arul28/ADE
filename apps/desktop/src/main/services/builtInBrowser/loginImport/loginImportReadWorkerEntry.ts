/**
 * Child-process entry for {@link readLoginImportSource}.
 *
 * One request in on stdin, one JSON response out on stdout, then exit. Nothing
 * else runs in this process, so the synchronous Keychain / keyring / DPAPI /
 * SQLite work it does is free — which is the entire point of moving it off the
 * Electron main thread.
 *
 * Cookie values travel back over the pipe and are never written to a file or a
 * log; the parent drops them into the browser session and forgets them.
 */
import { readLoginImportSource, type LoginImportReadRequest } from "./loginImportRead";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

void (async () => {
  try {
    const raw = await readStdin();
    const request = JSON.parse(raw) as LoginImportReadRequest;
    process.stdout.write(JSON.stringify(readLoginImportSource(request)));
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      status: "read_failed",
      reason: error instanceof Error ? error.message : "The cookie database could not be read.",
    }));
    process.exitCode = 1;
  }
})();
