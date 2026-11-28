#!/usr/bin/env node
// Builds the template drive every DAEX Cloud Mac's first drive is a copy of
// (`access.drive_from` in `startMac`, apps/account-directory/src/cloud/macProvider.ts).
//
//   NOMAC_API_KEY=... node infra/ade-cloud-mac/build-template.mjs --drive adem:template:stable [--version 1.2.150] [--tools "codex claude-code opencode"]
//
// --drive    the drive's name. Production uses `adem:template:<channel>`; a
//            test Worker its own prefix (`ademdev:template:<channel>`), so
//            nothing of a test can look like production's.
// --version  the DAEX release on the drive; default "latest".
// --tools    the agents that release pins, baked on the drive; default
//            "codex claude-code opencode". "" bakes none.
// --source   TEST BUILDS ONLY: a branch or tag of the public repository whose
//            runtime replaces the release's (built on the Mac with
//            `build:static`), to prove unreleased brain changes on a real Mac.
//            Never for a production template: production carries a release.
//
// It starts one Mac on the named drive (no label, so it is the account's own
// Mac; the account has no secrets or signing for it to receive), puts
// drive/*.sh in ~/drive/.daex, installs DAEX into ~/drive/.daex/ade, bakes the
// agents into ~/drive/.daex/tools, removes everything that would give two
// Macs one identity, and stops the Mac, which saves the drive. Every exit
// path stops the Mac. Then the owner points the setting at it:
//   mac_template_drive_<channel> = <drive>   (scripts/cloud-owner.mjs settings)
// A drive already built is rebuilt in place: copies made before keep theirs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://nomac.app/api/v1";
const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
const drive = arg("drive", "");
const version = arg("version", "latest");
const tools = arg("tools", "codex claude-code opencode");
const source = arg("source", "");
const key = process.env.NOMAC_API_KEY?.trim();
const fail = (message) => {
  console.error(`build-template: ${message}`);
  process.exit(1);
};
if (!key) fail("set NOMAC_API_KEY (daex secrets exec --env nomac_key -- …, mapped to NOMAC_API_KEY).");
if (!/^[a-z]{2,12}:template:(stable|beta)$/.test(drive)) fail("--drive is <prefix>:template:<stable|beta>, such as adem:template:stable.");
if (!/^(latest|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.test(version)) fail("--version is a release such as 1.2.150, or latest.");
if (/[^a-z0-9 -]/.test(tools)) fail("--tools takes tool names (a-z, 0-9, -) separated by spaces.");
if (source && !/^[A-Za-z0-9._\/-]{1,120}$/.test(source)) fail("--source is a branch or tag name.");
if (source && !drive.startsWith("ademdev:")) fail("--source builds are for the test Worker's drives (ademdev:) only.");

const log = (line) => console.error(`${new Date().toISOString()} ${line}`);

async function call(method, path, body, idempotencyKey) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(70_000),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

let sessionId = null;
let stopping = null;
async function stop(why) {
  if (!sessionId) return;
  stopping ??= (async () => {
    log(`stopping the Mac ${sessionId} (${why})`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = await call("DELETE", `/mac/sessions/${encodeURIComponent(sessionId)}?confirm=true`).catch(() => ({ status: 0 }));
      if (answer.status < 300 || answer.status === 404 || answer.status === 410) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    // The drive is saved as the Mac stops: wait for it, so the setting never names a drive mid-save.
    for (let waited = 0; waited < 20 * 60_000; waited += 10_000) {
      const answer = await call("GET", `/mac/sessions/${encodeURIComponent(sessionId)}`).catch(() => ({ status: 0 }));
      const session = answer.body?.session;
      if (answer.status === 404 || (session && !["queued", "provisioning", "starting", "ready", "stopping"].includes(session.state))) {
        log(`the Mac stopped (${session?.state ?? "gone"}; ready ${session?.ready_at ?? "never"}, shut down ${session?.shutdown_at ?? "?"}, cost ${JSON.stringify(session?.cost ?? null)})`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    log("the Mac did not report stopped within 20 minutes: check it at nomac.app");
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void stop(signal).finally(() => process.exit(130));
  });
}

/** Runs a command on the Mac (a NoMac job), following it until it ends. */
async function run(label, script, timeoutSeconds = 600) {
  log(`${label}…`);
  let answer = await call("POST", `/mac/sessions/${encodeURIComponent(sessionId)}/jobs?wait=50`, {
    argv: ["/bin/bash", "-lc", script],
    timeout_seconds: timeoutSeconds,
  }, `daex-template-${sessionId}-${label.replace(/[^a-z0-9]+/gi, "-")}`);
  let job = answer.body?.job ?? answer.body;
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
  while (answer.status < 300 && typeof job?.exit_code !== "number" && typeof job?.id === "string" && Date.now() < deadline) {
    answer = await call("GET", `/mac/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}?wait=40`);
    job = answer.body?.job ?? answer.body;
  }
  if (job?.stdout) process.stderr.write(String(job.stdout).replace(/^/gm, "  | "));
  if (job?.stderr) process.stderr.write(String(job.stderr).replace(/^/gm, "  ! "));
  if (answer.status >= 300 || job?.exit_code !== 0) {
    throw new Error(`${label} failed (HTTP ${answer.status}, exit ${job?.exit_code ?? "none"}${answer.body?.error ? `, ${answer.body.error.code}` : ""})`);
  }
  return String(job.stdout ?? "");
}

/** A file from drive/ written to ~/drive/.daex on the Mac (each is a few KB). */
function putFile(name) {
  const content = Buffer.from(readFileSync(join(here, "drive", name))).toString("base64");
  return `printf %s '${content}' | base64 -D > "$HOME/drive/.daex/${name}" && chmod 755 "$HOME/drive/.daex/${name}"`;
}

const tag = version === "latest" ? "latest" : version.startsWith("v") ? version : `v${version}`;
const install = String.raw`
set -euo pipefail
case "$(uname -m)" in arm64|aarch64) target=darwin-arm64 ;; *) target=darwin-x64 ;; esac
stage="$(mktemp -d /tmp/daex-template.XXXXXX)"
# The release, installed in a throwaway home: install.sh also starts a brain
# under launchd there, which is stopped below and never touches ~/drive.
curl -fsSL https://ade-app.dev/install.sh -o "$stage/install.sh"
HOME="$stage/home" ADE_HOME="$stage/home/.ade" ADE_VERSION="${tag}" ADE_INSTALL_NO_PROMPT=1 ADE_INSTALL_NO_PATH=1 \
  DO_NOT_TRACK=1 ADE_SENTRY_DISABLED=1 sh "$stage/install.sh" < /dev/null
HOME="$stage/home" ADE_HOME="$stage/home/.ade" "$stage/home/.ade/bin/ade" brain stop >/dev/null 2>&1 || true
for plist in "$stage/home/Library/LaunchAgents"/*.plist; do
  [ -f "$plist" ] && launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
done
rm -rf "$HOME/drive/.daex/ade"
mkdir -p "$HOME/drive/.daex/ade/bin" "$HOME/drive/.daex/ade/runtime"
cp -a "$stage/home/.ade/bin/ade" "$HOME/drive/.daex/ade/bin/ade"
ln -sf ade "$HOME/drive/.daex/ade/bin/daex"
cp -a "$stage/home/.ade/runtime/$target" "$HOME/drive/.daex/ade/runtime/$target"
. "$HOME/drive/.daex/env.sh"
DO_NOT_TRACK=1 ADE_SENTRY_DISABLED=1 ADE_TEMPLATE_CHECK=1 "$daex_bin" --version
rm -rf "$stage"
`;
// The branch's runtime in place of the release's, laid out as install.sh lays a release out.
const fromSource = String.raw`
set -euo pipefail
case "$(uname -m)" in arm64|aarch64) target=darwin-arm64 ;; *) target=darwin-x64 ;; esac
src="$(mktemp -d /tmp/daex-src.XXXXXX)"
git clone --quiet --depth 1 --branch "${source}" https://github.com/arul28/ADE.git "$src/ADE"
cd "$src/ADE/apps/ade-cli"
npm ci --no-audit --no-fund --maxsockets=50 > "$src/npm.log" 2>&1 || { tail -n 40 "$src/npm.log"; exit 1; }
# build:static needs an official Node binary (Homebrew's has no SEA fuse): the release of the Mac's own version.
node_version="$(node -p process.version)"; node_arch="$([ "$target" = darwin-arm64 ] && echo arm64 || echo x64)"
curl -fsSL "https://nodejs.org/dist/$node_version/node-$node_version-darwin-$node_arch.tar.gz" | tar -xz -C "$src"
export ADE_STATIC_NODE_BINARY="$src/node-$node_version-darwin-$node_arch/bin/node"
PATH="$(dirname "$ADE_STATIC_NODE_BINARY"):$PATH" npm run build:static -- --target "$target" > "$src/build.log" 2>&1 || { tail -n 60 "$src/build.log"; exit 1; }
bin="$(find dist-static -maxdepth 2 -type f -name "ade-$target" | head -n 1)"
native="$(find dist-static -maxdepth 2 -type f -name "ade-$target.native.tar.gz" | head -n 1)"
[ -n "$bin" ] && [ -n "$native" ] || { ls -laR dist-static | head -n 40; echo "no runtime in dist-static"; exit 1; }
cp "$bin" "$HOME/drive/.daex/ade/bin/ade"; chmod 755 "$HOME/drive/.daex/ade/bin/ade"
rm -rf "$HOME/drive/.daex/ade/runtime/$target"; mkdir -p "$HOME/drive/.daex/ade/runtime/$target"
tar -xzf "$native" -C "$HOME/drive/.daex/ade/runtime/$target"
. "$HOME/drive/.daex/env.sh"
echo "source ${source} at $(git -C "$src/ADE" rev-parse --short HEAD)"
DO_NOT_TRACK=1 ADE_SENTRY_DISABLED=1 ADE_TEMPLATE_CHECK=1 "$daex_bin" --version
rm -rf "$src"
`;
const bake = String.raw`
set -uo pipefail
. "$HOME/drive/.daex/env.sh"
baked="$HOME/drive/.daex/tools"; scratch="$(mktemp -d /tmp/daex-bake.XXXXXX)"
rm -rf "$baked"; mkdir -p "$baked"
for tool in ${tools}; do
  root="$scratch/$tool"
  if ! HOME="$scratch/home" ADE_HOME="$scratch/home/.ade" ADE_TOOLS_ROOT="$root" DO_NOT_TRACK=1 ADE_SENTRY_DISABLED=1 ADE_TEMPLATE_CHECK=1 \
       "$daex_bin" tools ensure "$tool" > "$scratch/$tool.log" 2>&1 \
     || [ -z "$(find "$root" -name .install-complete 2>/dev/null | head -n 1)" ]; then
    echo "bake: $tool did not install; it downloads on first use"; tail -n 20 "$scratch/$tool.log"; rm -rf "$root"; continue
  fi
  rm -rf "$root/.staging" "$root/.locks" "$root"/.*.json
  cp -a "$root/." "$baked/"
  echo "bake: $tool baked ($(du -sh "$root" | cut -f1))"
done
rm -rf "$scratch"
`;
// Nothing that makes a machine: a copy must start signed out with its own
// identity, and with none of this build's caches.
const clean = String.raw`
set -euo pipefail
rm -rf "$HOME/drive/.ade" "$HOME/drive/.daex/home" "$HOME/drive/.cache"
find "$HOME/drive" -mindepth 1 -maxdepth 1 ! -name .daex -exec rm -rf {} +
echo "drive: $(du -sh "$HOME/drive" | cut -f1)"; ls -la "$HOME/drive" "$HOME/drive/.daex"
`;

try {
  log(`starting a Mac on drive ${drive} for DAEX ${tag}`);
  const started = await call("POST", "/mac/sessions", {
    access: { drive },
    queue_seconds: 600,
    limits: { max_duration_seconds: 3600, idle_timeout_seconds: 900, spend_cap_microunits: "1500000" },
  }, `daex-template-${drive}-${Date.now()}`);
  sessionId = started.body?.session?.id ?? null;
  if (started.status >= 300 || !sessionId) throw new Error(`the start failed (HTTP ${started.status}, ${started.body?.error?.code ?? "no session"})`);
  log(`Mac ${sessionId} started (${started.body.session.state}); drive ${JSON.stringify(started.body.session.drive?.name ?? started.body.drive?.name ?? drive)}`);
  for (let waited = 0; ; waited += 5_000) {
    const answer = await call("GET", `/mac/sessions/${encodeURIComponent(sessionId)}`);
    const state = answer.body?.session?.state;
    if (state === "ready") break;
    if (!["queued", "provisioning", "starting"].includes(state) || waited > 15 * 60_000) throw new Error(`the Mac did not become ready (${state ?? `HTTP ${answer.status}`})`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  log("the Mac is ready");
  await run("put the scripts", ["mkdir -p \"$HOME/drive/.daex\"", ...["env.sh", "boot.sh", "supervise.sh"].map(putFile)].join(" && "), 60);
  await run("install DAEX", install, 1200);
  if (source) await run(`build DAEX from ${source}`, fromSource, 3000);
  if (tools.trim()) await run("bake the agents", bake, 1800);
  await run("clean the drive", clean, 120);
  await stop("built");
  log(`built ${drive}. Point the channel's setting at it: mac_template_drive_${drive.split(":").pop()} = ${drive}`);
} catch (error) {
  log(`build-template: ${error instanceof Error ? error.message : String(error)}`);
  await stop("failed");
  process.exit(1);
}
