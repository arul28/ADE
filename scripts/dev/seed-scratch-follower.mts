// cd apps/ade-cli && npx tsx ../../scripts/dev/seed-scratch-follower.mts [scratch-root] [--host 192.0.2.1] [--port 8788] [--machine "Scratch Mac Studio"] [--last-seen-minutes 2]
// Seeds a SCRATCH project that follows a machine which is not there, so the Stop following flow can be
// checked in a dev app on a private socket. The project gets its own .ade/ade.db under a fresh directory
// inside the OS temp dir. Its sync cluster row names a device whose address is a fake host. The default
// 192.0.2.1 is TEST-NET-1 (RFC 5737), a documentation range that is never routed.
// The script writes only under the scratch root. It refuses any root that is not under the OS temp dir,
// or that is under ~/ADE or ~/.ade, and it checks that before it creates anything. It never starts a runtime,
// never reads or writes the machine's secrets, and never touches a socket.
// The runtime treats a cluster record whose brain was last seen more than 5 minutes ago as stale and reclaims
// it on refresh (syncService.ts STALE_BRAIN_LAST_SEEN_MS). So check within that window, or seed a new root.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../apps/desktop/src/main/services/logging/logger";
import { openKvDb } from "../../apps/desktop/src/main/services/state/kvDb";

// The cluster id the device registry uses for the one cluster a project has (DEFAULT_SYNC_CLUSTER_ID).
const DEFAULT_CLUSTER_ID = "default";

type Options = {
  root: string | null;
  host: string;
  port: number;
  machine: string;
  lastSeenMinutes: number;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    root: null,
    host: "192.0.2.1",
    port: 8788,
    machine: "Scratch Mac Studio",
    lastSeenMinutes: 2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    if (arg === "--host") options.host = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--machine") options.machine = next();
    else if (arg === "--last-seen-minutes") options.lastSeenMinutes = Number(next());
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
    else if (options.root === null) options.root = arg;
    else throw new Error(`Only one scratch root is allowed, got ${arg} as well.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`--port must be a port number, got ${options.port}.`);
  }
  if (!Number.isFinite(options.lastSeenMinutes) || options.lastSeenMinutes < 0) {
    throw new Error(`--last-seen-minutes must be zero or more, got ${options.lastSeenMinutes}.`);
  }
  return options;
}

/**
 * The real path a scratch root would have, checked before anything is created.
 * It must be a new directory strictly inside the OS temp dir, and it must not
 * be under the user's ADE projects folder or ADE home. `tmp` and `home` are
 * injectable so the check can be exercised without touching the real ones.
 */
export function checkedScratchRoot(
  requested: string,
  { home = os.homedir(), tmp = os.tmpdir() }: { home?: string; tmp?: string } = {},
): string {
  const target = path.resolve(requested);
  // The parent must exist, so a refused root never creates a directory on the way.
  const real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  const realTmp = fs.realpathSync(tmp);
  const realHome = fs.realpathSync(home);
  const forbidden = [
    path.join(home, "ADE"),
    path.join(home, ".ade"),
    path.join(realHome, "ADE"),
    path.join(realHome, ".ade"),
  ];
  for (const candidate of [target, real]) {
    for (const dir of forbidden) {
      if (candidate === dir || candidate.startsWith(dir + path.sep)) {
        throw new Error(`Refusing ${requested}: it is under ${dir}, the user's ADE projects or ADE home.`);
      }
    }
  }
  if (!real.startsWith(realTmp + path.sep)) {
    throw new Error(`Refusing ${requested}: a scratch root must be inside ${realTmp}.`);
  }
  if (fs.existsSync(real) && fs.readdirSync(real).length > 0) {
    throw new Error(`Refusing ${requested}: the directory is not empty. Pick a new root.`);
  }
  return real;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=ade-scratch", "-c", "user.email=scratch@invalid", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  // Checked before anything is created, so a refused root leaves no directory behind.
  const root = checkedScratchRoot(
    options.root ?? path.join(os.tmpdir(), `ade-scratch-follower-${randomUUID().slice(0, 8)}`),
  );
  fs.mkdirSync(root, { recursive: true });
  // The dev app's private ADE home, named in the summary below. The script never writes to it.
  fs.mkdirSync(path.join(root, "ade-home"), { recursive: true });

  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Scratch follower project\n\nSeeded by scripts/dev/seed-scratch-follower.mts.\n");
  git(projectRoot, ["init", "-q"]);
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-q", "-m", "scratch: seed follower project"]);

  // openKvDb creates the schema (devices, sync_cluster_state) on first open.
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), logger);
  try {
    const now = Date.now();
    const brainDeviceId = `scratch-brain-${randomUUID()}`;
    const lastSeenAt = new Date(now - options.lastSeenMinutes * 60_000).toISOString();
    const nowIso = new Date(now).toISOString();
    db.run(
      `insert into devices(
        device_id, site_id, name, platform, device_type,
        created_at, updated_at, last_seen_at, last_host, last_port,
        tailscale_ip, ip_addresses_json, metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brainDeviceId,
        randomBytes(16).toString("hex"),
        options.machine,
        "darwin",
        "desktop",
        nowIso,
        nowIso,
        lastSeenAt,
        options.host,
        options.port,
        null,
        JSON.stringify([options.host]),
        "{}",
      ],
    );
    db.run(
      `insert into sync_cluster_state(cluster_id, brain_device_id, brain_epoch, updated_at, updated_by_device_id)
       values (?, ?, ?, ?, ?)`,
      [DEFAULT_CLUSTER_ID, brainDeviceId, 1, nowIso, brainDeviceId],
    );
    db.flushNow();
  } finally {
    db.close();
  }

  process.stdout.write([
    `Scratch follower project seeded at ${projectRoot}`,
    `  follows: ${options.machine} at ${options.host}:${options.port} (unreachable by design)`,
    `  last seen: ${options.lastSeenMinutes} minute(s) ago`,
    `  dev app: run it with ADE_HOME=${path.join(root, "ade-home")} on a private socket, never ~/.ade.`,
    `  open ${projectRoot} there, then check Connections > This computer.`,
    "",
  ].join("\n"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
