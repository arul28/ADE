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

const moveSaveFile = (jobId: string, kind: "started" | "exit" | "log") => `/tmp/ade-move-save-${shellJobId(jobId)}.${kind}`;

/** The old computer's mark while a move holds it, under `$ADE_HOME/cloud` (the CLI's `cloudMovingOut` reads it). */
export const CLOUD_MOVING_MARK_FILE = "moving.json";

/**
 * Shell: marks the old computer as moving, from the making of the new one:
 * its ADE refuses a chat send from another device (`computer_moving`), which
 * then goes to the account's queue the move holds. Written with the move's
 * hold, and expires by itself as the hold does. `$ADE_HOME` stays out of the
 * home folder's copy, so the new computer never has it.
 */
export function moveOutMarkCommand(ttlMs: number): string {
  return `d="$ADE_HOME/cloud"; mkdir -p "$d"; printf '{"until":%s}' "$(( $(date +%s%3N) + ${Math.round(ttlMs)} ))" > "$d/${CLOUD_MOVING_MARK_FILE}"`;
}

/** Shell: the old computer takes chat sends again (a move that stopped, or one that kept it). */
export const MOVE_OUT_CLEAR_COMMAND = `rm -f "$ADE_HOME/cloud/${CLOUD_MOVING_MARK_FILE}"`;

/**
 * A move's save (`prepareStopCommand`), in the background: the move starts it
 * while it makes the new computer, so the two run at once instead of one
 * after the other, and reads its end with `moveSaveStateCommand`. Once per
 * move (the marker is named for it): a second run, a step tried again after
 * its answer was lost, finds the marker and starts nothing. Prints `started`
 * either way.
 */
export function startMoveSaveCommand(jobId: string): string {
  const started = moveSaveFile(jobId, "started");
  const exit = moveSaveFile(jobId, "exit");
  return [
    `if [ -e ${started} ]; then echo started; else touch ${started}`,
    `rm -f ${exit}`,
    `nohup sh -c 'export PATH="$ADE_HOME/bin:$PATH"; ade cloud prepare-stop --timeout 40; echo $? > ${exit}' > ${moveSaveFile(jobId, "log")} 2>&1 < /dev/null &`,
    "echo started",
    "fi",
  ].join("\n");
}

/**
 * The move's save for a poll, in `moveCopyStateOf`'s words: its exit code once
 * it ended, nothing while it runs, `not_started` when none was started here
 * (the computer restarted since, which empties /tmp).
 */
export function moveSaveStateCommand(jobId: string): string {
  return `cat ${moveSaveFile(jobId, "exit")} 2>/dev/null || { [ -e ${moveSaveFile(jobId, "started")} ] || echo not_started; }`;
}

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
        # Level 1: this single thread is the move's bottleneck. On node_modules
        # level 6 packed 23 MB/s, level 1 77 MB/s, for 29% of the size instead
        # of 25% (2026-11-25), so a 7.9 GB home copies in about a third of the time.
        packer = zlib.compressobj(1, zlib.DEFLATED, 31)
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

/**
 * Detached, on the new computer once its home arrived: `ade tools ensure`,
 * the brain's own startup fetch of the agents this machine runs. Its brain
 * started before the home did, so that startup fetch saw no record of use,
 * and the lane's first message after the move waited on its agent's download
 * ("Getting Claude Code ready"). The copied `~/.ade/tools/.last-used.json`
 * names them now. Run for every move, projects or not.
 */
export const FETCH_USED_AGENT_TOOLS_COMMAND = "(setsid ade tools ensure >/dev/null 2>&1 < /dev/null &)";

/**
 * Asks the computer's ADE to send the chat messages the account holds for it
 * (`ade cloud messages drain`), detached, so the step that asks never waits
 * on the sends. It waits up to a minute for ADE to answer first: an ADE a
 * move paused is starting again. A move runs it on the new computer once the
 * lane is there, and on the old one when the move stops before that.
 */
export const DRAIN_MESSAGES_DETACHED_COMMAND = `(setsid sh -c 'export PATH="$ADE_HOME/bin:$PATH"; i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 60 ]; do sleep 1; i=$((i+1)); done; ade cloud messages drain --json' >/dev/null 2>&1 < /dev/null &)`;

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
 * A wake drops the computer's file cache, and the first `git status` of a
 * large repository then takes longer than the 8 s an older ADE on the
 * computer gives each read, so its push or check reports the lane unreadable
 * and the free fails. One `git status` per worktree first loads the index and
 * the tree into the cache (30 s each, a minute in all, and it can never fail
 * the command); the reads after it take well under a second.
 */
const WARM_GIT_COMMAND = [
  "timeout 60 sh -c 'ade projects list --json 2>/dev/null | sed -n \"s/^ *\\\"rootPath\\\": *\\\"\\(.*\\)\\\",\\{0,1\\}$/\\1/p\" | while IFS= read -r root; do",
  "  git -C \"$root\" worktree list --porcelain 2>/dev/null | sed -n \"s/^worktree //p\" | while IFS= read -r tree; do timeout 30 git -C \"$tree\" status --porcelain >/dev/null 2>&1; done",
  "done' || true",
].join("\n");

/**
 * Commits and pushes every project's lanes on the computer (`ade cloud
 * push-work`), or with `check` only reads what isn't pushed (`ade cloud
 * work-state`; never `push-work --check`: an older ADE ignores the flag and
 * pushes). ADE on the computer answers a few seconds after a start.
 */
export function pushWorkCommand(check: boolean, options: { afterPush?: boolean } = {}): string {
  return [
    'export PATH="$ADE_HOME/bin:$PATH"',
    'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
    // A check right after a push (the free's recheck) finds the cache warm and has a shorter budget.
    ...(options.afterPush ? [] : [WARM_GIT_COMMAND]),
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
  /** Why GitHub stopped a failed lane (`github_refused`, `github_unreachable`); null when it didn't, or the ADE didn't say. */
  reason: string | null;
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
          reason: typeof lane.reason === "string" ? lane.reason : null,
        }];
      })
      : null;
    return { pushed: Number(tally.pushed) || 0, failed: Number(tally.failed) || 0, skipped: Number(tally.skipped) || 0, lanes };
  } catch {
    return null;
  }
}

/**
 * Whether GitHub stopped push-work's fetch or push of a lane at risk
 * (`reason` in its tally): `refused` (the repository is gone, or the
 * computer's GitHub access can't reach it) wins over `unreachable`. Null when
 * GitHub didn't, or the computer's ADE is too old to say.
 */
export function pushWorkGithubProblem(lanes: ReadonlyArray<{ state: string; reason?: string | null }> | null): "refused" | "unreachable" | null {
  const atRisk = (lanes ?? []).filter((lane) => lane.state === "failed" || lane.state === "unpushed");
  if (atRisk.some((lane) => lane.reason === "github_refused")) return "refused";
  if (atRisk.some((lane) => lane.reason === "github_unreachable")) return "unreachable";
  return null;
}

/**
 * The sentence for a GitHub problem, the same on every client. `kept`: a free
 * or a delete that stopped, so the computer stays. `unknown`: a check before a
 * delete, which can't say what isn't on GitHub.
 */
export function pushWorkGithubMessage(problem: "refused" | "unreachable", outcome: "kept" | "unknown"): string {
  if (problem === "refused") {
    return outcome === "kept"
      ? "GitHub refused this computer access to the lane's repository, so nothing was deleted. The repository may have moved, or your GitHub connection (Settings › GitHub) can't reach it. Fix that, then try again."
      : "GitHub refused this computer access to the lane's repository, so Daex can't tell what isn't on GitHub.";
  }
  return outcome === "kept"
    ? "This computer couldn't reach GitHub to check the lane's work, so nothing was deleted. Try again in a minute."
    : "This computer couldn't reach GitHub, so Daex can't tell what isn't on GitHub.";
}

/**
 * A free whose push-work lists the computer's lanes without this one: a
 * launch that failed before it made the lane (a provider refused its key)
 * leaves the computer with only its main checkout. A delete is the way out.
 */
export const LANE_NOT_ON_COMPUTER_MESSAGE = "This lane isn't on the computer (its setup didn't finish, or it was removed there), so there is no lane to keep. Delete the computer instead.";

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
