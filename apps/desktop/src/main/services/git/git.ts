import { spawn } from "node:child_process";

export type GitRunOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type GitRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return await new Promise<GitRunResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ exitCode: 124, stdout, stderr: stderr.length ? stderr : "git timed out" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("close", (code) => {
      clearTimeout(onTimeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function runGitOrThrow(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  if (res.exitCode !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(msg);
  }
  return res.stdout;
}

