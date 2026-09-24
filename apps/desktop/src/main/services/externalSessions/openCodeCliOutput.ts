import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCliSpawnInvocation } from "../shared/processExecution";

export type OpenCodeCliOutput =
  | { ok: true; stdout: string }
  | { ok: false; reason: "spawn_failed" | "timeout" | "exit_code" | "too_large"; detail: string };

/**
 * Runs the OpenCode CLI and returns its full stdout.
 *
 * stdout goes to a temp file, not a pipe: OpenCode 1.18 exits before a piped
 * stdout drains, so a Node pipe gets a cut-off JSON document (64 KB for
 * `session list`, 128 KB for `export`; verified 2026-09-23). Runs async through
 * the shared spawn helper, so a Windows `opencode.cmd` shim works and the
 * Electron main process never blocks.
 */
export async function runOpenCodeToFile(args: {
  executable: string;
  argv: string[];
  cwd?: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
}): Promise<OpenCodeCliOutput> {
  const invocation = resolveCliSpawnInvocation(args.executable, args.argv, args.env);
  const cwd = args.cwd && fs.existsSync(args.cwd) ? path.resolve(args.cwd) : undefined;
  const outPath = path.join(os.tmpdir(), `ade-opencode-${randomUUID()}.out`);
  let out: fs.promises.FileHandle | null = null;
  try {
    out = await fs.promises.open(outPath, "w");
    const outFd = out.fd;
    const result = await new Promise<{ code: number | null; timedOut: boolean; error: string | null }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; timedOut: boolean; error: string | null }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(invocation.command, invocation.args, {
          ...(cwd ? { cwd } : {}),
          env: args.env,
          stdio: ["ignore", outFd, "ignore"],
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
      } catch (error) {
        finish({ code: null, timedOut: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ code: null, timedOut: true, error: null });
      }, args.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        finish({ code: null, timedOut: false, error: error.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish({ code, timedOut: false, error: null });
      });
    });
    await out.close();
    out = null;
    if (result.error) return { ok: false, reason: "spawn_failed", detail: result.error };
    if (result.timedOut) return { ok: false, reason: "timeout", detail: `timed out after ${args.timeoutMs} ms` };
    if (result.code !== 0) return { ok: false, reason: "exit_code", detail: `exited with code ${result.code}` };
    const size = (await fs.promises.stat(outPath)).size;
    if (size > args.maxBytes) return { ok: false, reason: "too_large", detail: `${size} bytes` };
    return { ok: true, stdout: await fs.promises.readFile(outPath, "utf8") };
  } finally {
    await out?.close().catch(() => undefined);
    await fs.promises.rm(outPath, { force: true }).catch(() => undefined);
  }
}
