/**
 * The shell commands ADE runs on an ADE Cloud computer for a move and around
 * it: hand its home folder over, take one in, pause and unpause its ADE, stop
 * its running turns, and read whether its agent works. One copy, imported by
 * the server's move (`moves.ts`) and by the ADE apps' own steps (the
 * desktop's `cloudMachineCopy.ts`, `cloudLaneLife.ts` and `cloudSleep.ts`).
 *
 * Plain functions with no imports, so the Worker, Node and the browser can
 * all load it. Nothing here is a secret but a signed URL handed to
 * `receiveHomeCommand` and a copy's join code handed to
 * `handCopyJoinCommand`, which never reach a log.
 */

/** The port the old computer serves its home folder on, once, behind a short-lived signed URL. */
export const MOVE_SERVE_PORT = 7338;
/** Moving a home folder: a 730 MB lane copied in 33 s; this bounds a very large one. */
export const MOVE_TRANSFER_TIMEOUT_MS = 40 * 60_000;
/** A move's hold on sleep (`cloudHoldCommand`); it expires by itself if the move stops mid-way. */
export const MOVE_HOLD_MS = 45 * 60_000;
/**
 * The most agent history a move carries from ADE's own provider homes. Past
 * it, the oldest conversations stay behind, and those chats go on from ADE's
 * transcript (as every chat did before).
 */
export const MOVE_AGENT_HISTORY_MAX_BYTES = 1024 * 1024 * 1024;

/** The account metadata key a computer carries once it joined: its ADE machine key. */
export const CLOUD_MACHINE_KEY_METADATA = "ade_machine_key";
/**
 * The machine keys of the computers a move replaced, oldest first, joined by
 * commas. A lane's delete takes their saved chats too. A copy does not carry
 * it: a copy's lane has its own chats.
 */
export const CLOUD_FORMER_MACHINE_KEYS_METADATA = "ade_former_machine_keys";
/** A move keeps at most this many former keys, so the value stays short. */
const FORMER_MACHINE_KEYS_KEPT = 16;

/** The former machine keys a computer's metadata lists (`CLOUD_FORMER_MACHINE_KEYS_METADATA`). */
export function formerMachineKeysOf(metadata: Record<string, string> | null | undefined): string[] {
  return (metadata?.[CLOUD_FORMER_MACHINE_KEYS_METADATA] ?? "").split(",").map((key) => key.trim()).filter(Boolean);
}

/** The value a move writes on the new computer: the old one's former keys, then its own key. */
export function formerMachineKeysAfterMove(source: Record<string, string>, sourceKey: string | null): string {
  const keys = formerMachineKeysOf(source);
  if (sourceKey) keys.push(sourceKey);
  return keys.slice(-FORMER_MACHINE_KEYS_KEPT).join(",");
}

/** UTF-8 text as base64, the same in the Worker, Node and a browser. */
function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/* ---- Sleep holds ---- */

/** Shell: keeps the computer awake for `reason` (`holdCloudBusy` in cloudKeepAwake.ts); expires by itself. */
export function cloudHoldCommand(reason: string, ttlMs: number): string {
  return `d="$ADE_HOME/cloud/holds"; mkdir -p "$d"; printf '{"reason":"${reason}","until":%s}' "$(( $(date +%s%3N) + ${Math.round(ttlMs)} ))" > "$d/${reason}.json"`;
}

export function cloudReleaseHoldCommand(reason: string): string {
  return `rm -f "$ADE_HOME/cloud/holds/${reason}.json"`;
}

/* ---- The agent's work and the chats' saved copy ---- */

/** The computer's own note of what keeps it busy (`cloudKeepAwake.ts`). */
export const KEEP_AWAKE_STATE_COMMAND = 'cat "$ADE_HOME/cloud/keep-awake.json" 2>/dev/null';
/** Busy reasons that are not the agent's work: a person watching a tool, a timer due soon. */
const NOT_AGENT_WORK = new Set(["in_use", "schedule"]);

/** `KEEP_AWAKE_STATE_COMMAND`'s output read: idle, busy, or unknown when it can't be read. */
export function agentWorkOf(stdout: string): "idle" | "busy" | "unknown" {
  try {
    const state = JSON.parse(stdout.trim()) as { busy?: unknown; reasons?: unknown };
    const reasons = Array.isArray(state.reasons) ? state.reasons.filter((reason): reason is string => typeof reason === "string") : [];
    return state.busy !== true || reasons.every((reason) => NOT_AGENT_WORK.has(reason)) ? "idle" : "busy";
  } catch {
    return "unknown";
  }
}

/** A job id as a shell word: ids are ADE's own UUIDs; anything else is dropped to letters, digits, `-` and `_`. */
export const shellJobId = (jobId: string): string => jobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "job";

/**
 * Interrupts running turns and agent CLIs and writes the saved chat copy
 * (`ade cloud prepare-stop`). A disk-only grow keeps the turns instead: the
 * computer notes the restart as a disk grow, so they continue after it. An
 * ADE there that predates `--disk-grow` stops them, as before.
 */
export const prepareStopCommand = (diskGrow: { gb: number; jobId: string } | null): string => [
  'export PATH="$ADE_HOME/bin:$PATH"',
  diskGrow
    ? `ade cloud prepare-stop --timeout 40 --disk-grow ${Math.ceil(diskGrow.gb)} --grow-id ${shellJobId(diskGrow.jobId)} || ade cloud prepare-stop --timeout 40`
    : "ade cloud prepare-stop --timeout 40",
].join("\n");

/* ---- A move: the old computer's side ---- */

/** The projects ADE knows on the computer, as JSON (`readProjectRoots`). Needs its ADE running. */
export const PROJECTS_LIST_COMMAND = 'cd "$HOME" && ade projects list --json 2>/dev/null';

/** The project folders in `PROJECTS_LIST_COMMAND`'s output, under the home folder only. */
export function readProjectRoots(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { projects?: unknown })?.projects;
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => (entry && typeof entry === "object" ? (entry as { rootPath?: unknown }).rootPath : null))
      .filter((root): root is string => typeof root === "string" && root.startsWith("/home/node/"));
  } catch {
    return [];
  }
}

/**
 * Serves the home folder once, gzipped, to whoever has the signed URL; then
 * exits.
 *
 * `~/.ade` stays behind: it holds ADE's identity and every sign-in. But a chat
 * on one of ADE's own accounts (a Claude pass, an added account, a preset or
 * route) keeps its agent's conversation in that account's home under
 * `~/.ade/provider-homes`, and without it the agent can't resume its own
 * session on the new machine. So a second archive follows the first inside
 * the same gzip stream, with only those conversation files: Claude's
 * `projects/<cwd slug>/<session id>.jsonl` and the folder of the same name
 * beside it, and Codex's `rollout-*.jsonl` files under `sessions` and
 * `archived_sessions`. Nothing else in those homes (logins, settings) goes.
 * The home path is the same on both machines, so the cwd in each file and in
 * Claude's folder name stays correct. The second archive is made in full
 * before the stream starts, so a failure there leaves only the first.
 */
export function serveHomeCommand(port: number): string {
  const script = `
import glob, gzip, http.server, os, subprocess, tempfile, threading, zlib
HOME = "/home/node"
EXCLUDE = ["./.ade", "./.docker-data", "./.cache/ms-playwright", "*/.ade/secrets/sync-site-id", "*/.ade/sock"]
HISTORY_MAX_BYTES = ${MOVE_AGENT_HISTORY_MAX_BYTES}

def real_dir(path):
    return os.path.isdir(path) and not os.path.islink(path)

def real_file(path):
    return os.path.isfile(path) and not os.path.islink(path)

def tree(root):
    """Every folder and file under root (root too), with the bytes of the files."""
    entries, size = [root], 0
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if real_dir(os.path.join(dirpath, name))]
        entries.extend(os.path.join(dirpath, name) for name in dirs)
        for name in files:
            path = os.path.join(dirpath, name)
            if real_file(path):
                entries.append(path)
                size += os.path.getsize(path)
    return entries, size

def conversations():
    """Each agent conversation in ADE's provider homes: (time, bytes, home, paths)."""
    found = []
    root = os.path.join(HOME, ".ade", "provider-homes")
    homes = glob.glob(os.path.join(root, "*", "*")) + glob.glob(os.path.join(root, "credential", "*", "*"))
    for home in homes:
        if not real_dir(home):
            continue
        for transcript in glob.glob(os.path.join(home, "projects", "*", "*.jsonl")):
            if not real_file(transcript):
                continue
            paths, size = [transcript], os.path.getsize(transcript)
            beside = transcript[:-len(".jsonl")]
            if real_dir(beside):
                more, more_size = tree(beside)
                paths += more
                size += more_size
            found.append((os.path.getmtime(transcript), size, home, paths))
        for folder in ("sessions", "archived_sessions"):
            for dirpath, dirs, files in os.walk(os.path.join(home, folder)):
                dirs[:] = [name for name in dirs if real_dir(os.path.join(dirpath, name))]
                for name in files:
                    path = os.path.join(dirpath, name)
                    if name.startswith("rollout-") and (name.endswith(".jsonl") or name.endswith(".jsonl.zst")) and real_file(path):
                        found.append((os.path.getmtime(path), os.path.getsize(path), home, [path]))
    return found

def pack_history():
    """A gzipped archive of the newest conversations that fit, or None."""
    archive = None
    try:
        kept, total = [], 0
        for _time, size, home, paths in sorted(conversations(), key=lambda item: item[0], reverse=True):
            if total + size > HISTORY_MAX_BYTES:
                continue
            total += size
            # Each folder from the home down, so a new folder gets the mode it had here.
            for path in paths:
                parent = os.path.dirname(path)
                chain = []
                while len(parent) >= len(home):
                    chain.append(parent)
                    parent = os.path.dirname(parent)
                kept.extend(reversed(chain))
                kept.append(path)
        if not kept:
            return None
        seen, ordered = set(), []
        for path in kept:
            if path not in seen:
                seen.add(path)
                ordered.append("./" + os.path.relpath(path, HOME))
        fd, archive = tempfile.mkstemp(prefix="ade-move-history-", suffix=".tar.gz")
        os.close(fd)
        listing = ("\\0".join(ordered) + "\\0").encode("utf-8", "surrogateescape")
        done = subprocess.run(["tar", "-C", HOME, "--no-recursion", "-czf", archive, "--null", "-T", "-"], input=listing)
        # 1 is "a file changed while it was read": the archive is still whole.
        if done.returncode in (0, 1):
            return archive
    except Exception:
        pass
    if archive:
        try:
            os.unlink(archive)
        except OSError:
            pass
    return None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/home.tar.gz":
            self.send_response(404); self.end_headers(); return
        history = pack_history()
        self.send_response(200)
        self.send_header("content-type", "application/gzip")
        self.end_headers()
        # One gzip stream around both archives, one after the other: the
        # receiver's tar reads past the first one's end into the second.
        packer = zlib.compressobj(6, zlib.DEFLATED, 31)
        def send(chunk):
            out = packer.compress(chunk)
            if out:
                self.wfile.write(out)
        args = ["tar", "-C", HOME, "-cf", "-"] + ["--exclude=" + e for e in EXCLUDE] + ["."]
        proc = subprocess.Popen(args, stdout=subprocess.PIPE)
        for chunk in iter(lambda: proc.stdout.read(1 << 20), b""):
            send(chunk)
        proc.wait()
        if history:
            try:
                with gzip.open(history, "rb") as handle:
                    for chunk in iter(lambda: handle.read(1 << 20), b""):
                        send(chunk)
            finally:
                os.unlink(history)
        self.wfile.write(packer.flush())
        threading.Thread(target=self.server.shutdown, daemon=True).start()
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", ${port}), Handler).serve_forever()
`;
  // Only the server goes to the background, every stream redirected: a
  // backgrounded list that still held the exec call's output kept the call
  // open for as long as the server ran.
  return [
    `printf %s '${base64Of(script)}' | base64 -d > /tmp/ade-move-serve.py`,
    "nohup timeout 3600 python3 /tmp/ade-move-serve.py > /tmp/ade-move-serve.log 2>&1 < /dev/null &",
    "sleep 1",
    "echo started",
  ].join("\n");
}

/**
 * Quiets the old computer's ADE so its databases are copied whole (the
 * entrypoint holds the brain while `brain.paused` exists, and clears a pause
 * two hours old by itself), then serves its home folder. Prints `started`.
 */
export function pauseAndServeHomeCommand(port: number = MOVE_SERVE_PORT): string {
  return [
    'touch "$ADE_HOME/brain.paused"',
    'pkill -f "serve --socket $ADE_HOME/sock/ade.sock" || true',
    "sleep 2",
    serveHomeCommand(port),
  ].join("\n");
}

/** Lets the old computer's ADE start again after a move that stopped. The brackets keep pkill from matching this command's own shell. */
export const MOVE_UNPAUSE_COMMAND = 'pkill -f "python3 /tmp/ade-move-serve[.]py"; rm -f "$ADE_HOME/brain.paused"';

/** The address the new computer pulls from: the signed link to the serve port, at the archive's path. */
export function moveArchiveUrl(signedUrl: string): string {
  const [base = "", query = ""] = signedUrl.split("?");
  return `${base.replace(/\/$/, "")}/home.tar.gz?${query}`;
}

/* ---- A move: the new computer's side ---- */

/**
 * Pulls the old machine's home folder into this one, in the background (a big
 * home outlasts one exec call); the exit code lands in a file. The signed URL
 * goes through a file so no shell ever re-quotes it. `--ignore-zeros` reads
 * on past the end of the first archive into the agent history after it
 * (`serveHomeCommand`).
 */
export function receiveHomeCommand(url: string): string {
  return [
    "rm -f /tmp/ade-move.exit /tmp/ade-move.log",
    `printf %s '${base64Of(url)}' | base64 -d > /tmp/ade-move.url`,
    `nohup sh -c 'curl -fsS --retry 3 "$(cat /tmp/ade-move.url)" | tar --ignore-zeros -xzf - -C /home/node; echo $? > /tmp/ade-move.exit; rm -f /tmp/ade-move.url' > /tmp/ade-move.log 2>&1 < /dev/null &`,
    "echo started",
  ].join("\n");
}

/**
 * `receiveHomeCommand` once per move: a second run (a step tried again after
 * its answer was lost) finds the marker and starts nothing, so two pulls never
 * write the same folders. Prints `started` either way.
 */
export function receiveHomeOnceCommand(url: string): string {
  return `if [ -e /tmp/ade-move.started ]; then echo started; else touch /tmp/ade-move.started\n${receiveHomeCommand(url)}\nfi`;
}

/** The pull's exit code once it ended; empty while it runs. */
export const MOVE_EXIT_COMMAND = "cat /tmp/ade-move.exit 2>/dev/null";
/** Whether a pull was started on this computer (`receiveHomeOnceCommand`). */
export const MOVE_STARTED_COMMAND = "[ -e /tmp/ade-move.started ] && echo started";
/**
 * Both in one call, for a poll: the exit code once the pull ended, nothing
 * while it runs, `not_started` when no pull was ever started here.
 */
export const MOVE_COPY_STATE_COMMAND = `${MOVE_EXIT_COMMAND} || { ${MOVE_STARTED_COMMAND} >/dev/null || echo not_started; }`;

export type MoveCopyState = { kind: "running" } | { kind: "not_started" } | { kind: "exited"; code: number };

/** `MOVE_COPY_STATE_COMMAND`'s output read. Anything unreadable reads as still running (the copy's time limit ends it). */
export function moveCopyStateOf(stdout: string): MoveCopyState {
  const text = stdout.trim();
  if (text === "not_started") return { kind: "not_started" };
  const code = /^\d+$/.test(text) ? Number(text) : null;
  return code == null ? { kind: "running" } : { kind: "exited", code };
}

/** The pull's last words, for a failure's sentence. */
export const MOVE_LOG_TAIL_COMMAND = "tail -n 3 /tmp/ade-move.log";

/**
 * Registers each moved project with the new computer's ADE. Each project's
 * database still names the old machine as its sync host; the marker hands
 * that role to this machine on first open (the same one the copied-home guard
 * leaves; deviceRegistryService.ts). Prints `failed <root>` for each that
 * didn't register.
 */
export function registerProjectsCommand(roots: readonly string[]): string {
  return roots.map((raw) => {
    const root = raw.replace(/'/g, "");
    return `mkdir -p '${root}/.ade/secrets' && printf moved > '${root}/.ade/secrets/sync-host-copied'; ade projects add '${root}' >/dev/null 2>&1 || echo "failed ${root}"`;
  }).join("; ");
}

/** Busy reasons that are a lane still being set up (`cloudKeepAwake.ts`), not an agent at work. */
const SETUP_WORK = new Set(["setup", "lane_setup", "first_clone", "lane_launch"]);

/**
 * `KEEP_AWAKE_STATE_COMMAND`'s output read for freeing a computer: `setup`
 * when only a lane's setup keeps it busy (a launch still cloning, or waiting
 * for a provider sign-in), `busy` for an agent's work, `unknown` when it
 * can't be read.
 */
export function keepAwakeOf(stdout: string): "idle" | "busy" | "setup" | "unknown" {
  try {
    const state = JSON.parse(stdout.trim()) as { busy?: unknown; reasons?: unknown };
    const reasons = (Array.isArray(state.reasons) ? state.reasons.filter((reason): reason is string => typeof reason === "string") : [])
      .filter((reason) => !NOT_AGENT_WORK.has(reason));
    if (state.busy !== true || reasons.length === 0) return "idle";
    return reasons.every((reason) => SETUP_WORK.has(reason)) ? "setup" : "busy";
  } catch {
    return "unknown";
  }
}

/** When the computer last wrote `KEEP_AWAKE_STATE_COMMAND`'s file (its `updatedAt`), 0 when it can't be read. */
export function keepAwakeWrittenAt(stdout: string): number {
  try {
    const updatedAt = (JSON.parse(stdout.trim()) as { updatedAt?: unknown }).updatedAt;
    return typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0;
  } catch {
    return 0;
  }
}

/* ---- A computer's lanes, pushed to GitHub ---- */

/**
 * Commits and pushes every project's lanes on the computer (`ade cloud
 * push-work`), or with `check` only reads what isn't pushed (`ade cloud
 * work-state`; never `push-work --check`: an older ADE ignores the flag and
 * pushes). ADE on the computer answers a few seconds after a start.
 */
export function pushWorkCommand(check: boolean): string {
  return [
    'export PATH="$ADE_HOME/bin:$PATH"',
    'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
    check ? "ade cloud work-state --json" : "ade cloud push-work --json",
  ].join("\n");
}

/** One lane as `ade cloud push-work` left it (`CloudPushWorkLane` in the CLI). */
export type PushWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  state: "pushed" | "clean" | "unpushed" | "failed" | "skipped" | string;
  /** Uncommitted files / commits GitHub doesn't have, as read; null when the ADE didn't say. */
  dirty: boolean | null;
  ahead: number | null;
};

/** `push-work`'s or `work-state`'s answer; `lanes` is null from an ADE too old to list them. Null when unreadable. */
export function readPushWorkTally(stdout: string): { pushed: number; failed: number; skipped: number; lanes: PushWorkLane[] | null } | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: Record<string, unknown> } & Record<string, unknown>;
    const tally = (parsed.result ?? parsed) as Record<string, unknown>;
    const lanes = Array.isArray(tally.lanes)
      ? tally.lanes.flatMap((entry): PushWorkLane[] => {
        if (!entry || typeof entry !== "object") return [];
        const lane = entry as Record<string, unknown>;
        if (typeof lane.laneId !== "string") return [];
        return [{
          laneId: lane.laneId,
          laneName: typeof lane.laneName === "string" ? lane.laneName : "",
          branchRef: typeof lane.branchRef === "string" ? lane.branchRef : "",
          primary: lane.primary === true,
          state: typeof lane.state === "string" ? lane.state : "unpushed",
          dirty: typeof lane.dirty === "boolean" ? lane.dirty : null,
          ahead: typeof lane.ahead === "number" ? lane.ahead : null,
        }];
      })
      : null;
    return { pushed: Number(tally.pushed) || 0, failed: Number(tally.failed) || 0, skipped: Number(tally.skipped) || 0, lanes };
  } catch {
    return null;
  }
}

/* ---- A copy: a new computer with the original's disk ---- */

/**
 * Metadata a copy must not carry: it is a new computer, not the original's
 * row. Its account key and former keys, who made the original, the request
 * and launch that made it, a move it came from (a copy of a moved computer
 * replaces nothing), and the old ready machines' keys (removed in Cloud 5; an
 * older ADE elsewhere would still take a copy that carried them as a
 * project's ready machine).
 */
const COPY_DROPPED_METADATA: ReadonlySet<string> = new Set([
  CLOUD_MACHINE_KEY_METADATA,
  CLOUD_FORMER_MACHINE_KEYS_METADATA,
  "ade_made_by_chat",
  "ade_made_by_agent",
  "ade_request_id",
  "ade_launch_id",
  "ade_moved_from",
  "ade_move_id",
  "ade_ready_for", "ade_ready", "ade_ready_name", "ade_ready_path", "ade_ready_lane",
  "ade_ready_claimed_at", "ade_ready_claim", "ade_ready_by", "ade_ready_ade",
]);

/** A copy's metadata: the original's (its lane facts and the rest) without what names the original, then `extra`. */
export function copiedComputerMetadata(source: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!COPY_DROPPED_METADATA.has(key)) metadata[key] = value;
  }
  return { ...metadata, created_by: "ade", ...extra };
}

/**
 * Hands a server copy's fork its sign-in (`copies.ts`). The fork can't be
 * given env, so its launch id and join code go into `CLOUD_LAUNCH_JOIN_FILE`
 * (mode 600, through base64 so no shell re-quotes the code), the original's
 * copied sign-in files and the copy's own hold come off, and its brain
 * restarts (the entrypoint loop starts it again), so the new brain reads the
 * file, deletes it, and signs in. pkill's pattern is expanded and the
 * command's own shell holds it unexpanded, so pkill never matches itself.
 * Prints `handed`. The command holds the code: never logged, never kept.
 */
export function handCopyJoinCommand(launchId: string, joinCode: string): string {
  const file = JSON.stringify({ launchId, join: joinCode });
  return [
    "umask 077",
    'd="$ADE_HOME/cloud"; mkdir -p "$d"',
    `printf %s '${base64Of(file)}' | base64 -d > "$d/launch-join.json.tmp" && chmod 600 "$d/launch-join.json.tmp" && mv -f "$d/launch-join.json.tmp" "$d/launch-join.json" || exit 1`,
    'rm -f "$ADE_HOME/logs/cloud-sign-in.log" "$ADE_HOME/logs/cloud-sign-in.pid" "$ADE_HOME/brain.paused"',
    cloudReleaseHoldCommand("copy"),
    'pkill -f "serve --socket $ADE_HOME/sock/ade.sock" || true',
    "echo handed",
  ].join("\n");
}
