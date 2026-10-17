// cd apps/ade-cli && npx tsx ../../scripts/dev/seed-scratch-follower.mts [--host 192.0.2.1] [--port 8788] [--machine "Scratch Mac Studio"] [--last-seen-minutes 2]
// Seeds a SCRATCH project that follows a machine which is not there, so the Stop following flow can be
// checked in a dev app on a private socket. The project gets its own .ade/ade.db under a fresh directory
// inside the OS temp dir. Its sync cluster row names a device whose address is a fake host. The default
// 192.0.2.1 is TEST-NET-1 (RFC 5737), a documentation range that is never routed.
// The script writes only under a new directory that mkdtemp creates atomically in the OS temp dir; it takes
// no path from the caller, and it re-checks that the result is not under ~/ADE or ~/.ade. It never starts a runtime,
// never reads or writes the machine's secrets, and never touches a socket.
// A stale brain is reclaimed on refresh only while the project has no saved viewer draft: a brain last seen more
// than 5 minutes ago (syncService.ts STALE_BRAIN_LAST_SEEN_MS). The first viewer dial saves a draft, and from then
// on a failed dial reclaims a remote brain only once it has been unseen for 3 days (STALE_VIEWER_DRAFT_BRAIN_LAST_SEEN_MS;
// 1 hour when its hostname matches this machine). So seed a new root for each check; a seeded root that has been dialed stays a viewer.
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
  host: string;
  port: number;
  machine: string;
  lastSeenMinutes: number;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
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
    else throw new Error(`Unexpected argument ${arg}: the scratch root is always a new temp directory.`);
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
 * Creates the scratch root. mkdtemp makes a new, uniquely named directory in one
 * atomic step, so no caller path, symlink or swapped parent can redirect it. The
 * result is still checked against the user's ADE projects folder and ADE home
 * before anything is written into it. `tmp` and `home` are injectable for tests.
 */
export function createScratchRoot(
  { home = os.homedir(), tmp = os.tmpdir() }: { home?: string; tmp?: string } = {},
): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "ade-scratch-follower-")));
  const realHome = fs.realpathSync(home);
  const forbidden = [path.join(home, "ADE"), path.join(home, ".ade"), path.join(realHome, "ADE"), path.join(realHome, ".ade")];
  const lower = (value: string) => value.toLowerCase();
  for (const dir of forbidden) {
    if (lower(root) === lower(dir) || lower(root).startsWith(lower(dir) + path.sep)) {
      fs.rmdirSync(root);
      throw new Error(`Refusing ${root}: it is under ${dir}, the user's ADE projects or ADE home.`);
    }
  }
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=ade-scratch", "-c", "user.email=scratch@invalid", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const root = createScratchRoot();
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
