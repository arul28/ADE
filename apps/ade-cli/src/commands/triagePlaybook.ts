import fs from "node:fs";
import path from "node:path";

import { DIAGNOSTIC_ISSUE_REPO } from "../services/diagnostics/diagnosticReport";

/**
 * Where `ade triage` gets the playbook it hands to a coding agent.
 *
 * Preference order: an explicit override, the copy this build shipped, the ADE
 * checkout this CLI is actually installed in, then the working directory. The
 * maintained copy on `main` is fetched first when the network answers quickly.
 */

const TRIAGE_PLAYBOOK_REPO_SEGMENTS = ["docs", "triage", "PLAYBOOK.md"] as const;
const TRIAGE_PLAYBOOK_REPO_PATH = TRIAGE_PLAYBOOK_REPO_SEGMENTS.join("/");
export const TRIAGE_PLAYBOOK_REMOTE_URL =
  `https://raw.githubusercontent.com/${DIAGNOSTIC_ISSUE_REPO}/main/${TRIAGE_PLAYBOOK_REPO_PATH}`;
/** Short on purpose: a broken machine is often a machine with no network. */
const TRIAGE_PLAYBOOK_FETCH_TIMEOUT_MS = 3_000;
/** The playbook is prose. Anything larger than this is not the playbook. */
const TRIAGE_PLAYBOOK_MAX_BYTES = 512 * 1024;
/** Environment kill switch for the network fetch (air-gapped hosts, tests). */
export const TRIAGE_NO_FETCH_ENV = "ADE_TRIAGE_NO_FETCH";
/** Explicit local playbook override, for development and for packagers. */
export const TRIAGE_PLAYBOOK_PATH_ENV = "ADE_TRIAGE_PLAYBOOK";
/** How far up from the entry point an ADE checkout may be. Matches bootstrap. */
const TRIAGE_PLAYBOOK_WALK_MAX_DEPTH = 8;

export type TriagePlaybookSource = "remote" | "local";

export type TriagePlaybook = {
  text: string;
  source: TriagePlaybookSource;
  /** The URL or file path the text actually came from, for the record. */
  origin: string;
};

/**
 * The last-resort copy, used when this build shipped without the doc and the
 * network is unreachable. It is deliberately not a second copy of the playbook
 * — a stale duplicate would be worse than a short one — it is the safety rules
 * plus where to read the real thing.
 */
const EMBEDDED_TRIAGE_PLAYBOOK = `# ADE triage playbook (built-in minimum)

The full playbook could not be read from this machine or fetched from GitHub, so
this is the reduced copy compiled into the ADE CLI. Read the full one at
${TRIAGE_PLAYBOOK_REMOTE_URL} when you have a network.

## Safety rules

1. Diagnose read-only first. \`ade doctor --text\`, \`ade brain status --text\`,
   \`ade runtime service-status --text\`, \`ade sync status --text\`,
   \`ade auth status --text\` and \`ade tools status --text\` all change nothing.
2. Propose every mutation before running it, and say how to undo it.
3. Never delete anything under \`~/.ade\` / \`$ADE_HOME\` or under a project's
   \`.ade/\` — databases, secrets, artifacts, transcripts. Never delete
   \`ade.db\`, \`ade.db-wal\` or \`ade.db-shm\`.
4. Never kill processes by name or pattern. Use \`ade brain stop\` /
   \`ade brain restart\`, or an exact PID whose command line you verified.
5. Prefer the ADE command over the OS command: \`ade brain restart\` over
   \`launchctl\`, \`ade runtime install-service\` over editing a plist,
   \`ade brain repair-credentials\` over touching the keychain.
6. Never print secrets. Report whether a file is readable, never its contents.
7. One change at a time, then re-run \`ade doctor --text\` and report what moved.

## First moves

\`\`\`bash
ade doctor --text            # one ok/warn/fail row per check
ade brain status --text      # endpoint, service, sync, last failure
ade runtime status --text    # reports \`starting: true\` while the brain boots
\`\`\`

A brain reported as \`starting\` is coming up, not broken: wait, do not restart.
If a row still fails and nothing explains it, \`ade report-issue --open\` files a
redacted report.
`;

function readPlaybookFile(candidate: string): string | null {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size === 0 || stat.size > TRIAGE_PLAYBOOK_MAX_BYTES) return null;
    const text = fs.readFileSync(candidate, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * The file, canonicalized, only if it really sits inside `boundary`.
 *
 * Mirrors `canonicalDirectoryWithin` in `apps/ade-cli/src/bootstrap.ts` (the
 * helper behind `trustedAgentSkillsRootForCliEntry`), for a file rather than a
 * directory: `realpath` both ends first, so a symlink planted inside an
 * accepted tree cannot point the CLI at a playbook outside it.
 */
function canonicalFileWithin(file: string | null, boundary: string | null): string | null {
  if (!file || !boundary) return null;
  try {
    const canonicalFile = fs.realpathSync(file);
    const canonicalBoundary = fs.realpathSync(boundary);
    if (!fs.statSync(canonicalFile).isFile()) return null;
    const relative = path.relative(canonicalBoundary, canonicalFile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}

/**
 * The playbook belonging to the ADE install this CLI was launched from, or
 * nothing.
 *
 * This is the anchored walk from `trustedAgentSkillsRootForCliEntry` in
 * `apps/ade-cli/src/bootstrap.ts`, applied to the same problem. An unanchored
 * "try `docs/triage/PLAYBOOK.md` at every ancestor" walk climbs straight out of
 * an npm-global install into `$HOME`, where any `~/docs/triage/PLAYBOOK.md`
 * would out-rank the shipped copy — and this file becomes instructions a coding
 * agent follows on a machine its owner is trying to repair. So: stop at the
 * first `ade-cli` ancestor, take the playbook that belongs to it, and
 * containment-check the result. No marker, no candidate.
 */
function anchoredPlaybookForEntryDir(startDir: string | null): string | null {
  if (!startDir) return null;
  let current: string;
  try {
    current = fs.realpathSync(startDir);
  } catch {
    return null;
  }
  for (let depth = 0; depth < TRIAGE_PLAYBOOK_WALK_MAX_DEPTH; depth += 1) {
    if (path.basename(current) === "ade-cli") {
      const parent = path.dirname(current);
      // `apps/ade-cli` is the repo layout: the doc lives at the repo root.
      if (path.basename(parent) === "apps") {
        const repoRoot = path.dirname(parent);
        return canonicalFileWithin(
          path.join(repoRoot, ...TRIAGE_PLAYBOOK_REPO_SEGMENTS),
          repoRoot,
        );
      }
      // The packaged layout: the CLI is unpacked at `<Resources>/ade-cli` and
      // `extraResources` ships `docs/triage` beside it. One level, contained —
      // the same sibling lookup `trustedAgentSkillsRootForCliEntry` does for
      // `<Resources>/agent-skills`.
      return canonicalFileWithin(
        path.join(parent, ...TRIAGE_PLAYBOOK_REPO_SEGMENTS),
        parent,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export type TriagePlaybookLookupOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string | null;
  /** The module directory. Defaults to `__dirname` when the bundle has one. */
  dirname?: string | null;
  /**
   * The entry script (`process.argv[1]`). Only consulted by default when no
   * `dirname` was passed — an explicit `dirname` means the caller is pinning
   * the install root and a stray entry script must not reopen it — but a test
   * can pass it directly to exercise this rung on its own.
   */
  argv1?: string | null;
  resourcesPath?: string | null;
};

/**
 * Where a local copy of the playbook can be, in preference order: an explicit
 * override, the copy this build shipped, the ADE install this CLI is running
 * from, then the working directory.
 *
 * The packaged and install-anchored copies outrank the working directory on
 * purpose. `ade triage` is run from wherever the user's shell happens to be,
 * and any checkout that carries a `docs/triage/PLAYBOOK.md` — an old ADE clone,
 * a fork, a vendored copy — would otherwise silently out-rank the playbook this
 * build was tested with. `ADE_TRIAGE_PLAYBOOK` stays first so a developer can
 * still point at their working copy deliberately.
 */
function triagePlaybookLocalCandidates(options: TriagePlaybookLookupOptions = {}): string[] {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const push = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    if (!candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(env[TRIAGE_PLAYBOOK_PATH_ENV]);

  // One packaged path, matching the single `extraResources` entry that ships
  // `docs/triage`. A second guessed layout would only ever mask a packaging
  // change that should fail loudly instead.
  const resourcesPath = options.resourcesPath
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? null;
  if (resourcesPath) push(path.join(resourcesPath, ...TRIAGE_PLAYBOOK_REPO_SEGMENTS));

  // Two entry points, because neither covers both builds: `__dirname` is the
  // bundled `dist/` in a release CLI but is absent under an ESM loader, and
  // `argv[1]` is the entry script, which is what a `tsx src/cli.ts` run has
  // instead. Both are walked to their ADE install root and no further, and
  // both rank ABOVE cwd so a checkout the shell happens to sit in cannot
  // out-rank the playbook this install ships.
  const entryDirs = [
    options.dirname ?? (typeof __dirname !== "undefined" ? __dirname : null),
    (options.argv1 !== undefined
      ? options.argv1
      : (options.dirname === undefined ? process.argv[1] ?? null : null)),
  ];
  for (const [index, entry] of entryDirs.entries()) {
    if (!entry) continue;
    // The first entry is already a directory; the second is a script path.
    push(anchoredPlaybookForEntryDir(index === 0 ? entry : path.dirname(entry)));
  }

  const cwd = options.cwd ?? process.cwd();
  if (cwd) push(path.join(cwd, ...TRIAGE_PLAYBOOK_REPO_SEGMENTS));

  return candidates;
}

/**
 * The last-resort playbook: no disk read, no network, no way to fail.
 *
 * Exported so the triage command can reach for the same value when its own
 * resolver rejects, rather than shipping a bundle with no playbook at all.
 */
export function embeddedTriagePlaybook(): TriagePlaybook {
  return { text: EMBEDDED_TRIAGE_PLAYBOOK, source: "local", origin: "built into this ADE CLI" };
}

export function readLocalTriagePlaybook(
  options: TriagePlaybookLookupOptions = {},
): TriagePlaybook {
  for (const candidate of triagePlaybookLocalCandidates(options)) {
    const text = readPlaybookFile(candidate);
    if (text) return { text, source: "local", origin: candidate };
  }
  return embeddedTriagePlaybook();
}

/**
 * The maintained copy on `main`, falling back to whatever this machine has.
 *
 * The fetch is short, best effort, and skippable: the machine that needs triage
 * is often the machine with no working network, and a command that hangs for 30
 * seconds before printing a path is a command nobody runs twice.
 */
export async function resolveTriagePlaybook(
  options: TriagePlaybookLookupOptions & {
    fetchImpl?: typeof fetch | null;
    timeoutMs?: number;
    url?: string;
  } = {},
): Promise<TriagePlaybook> {
  const env = options.env ?? process.env;
  const local = () => readLocalTriagePlaybook(options);
  if (env[TRIAGE_NO_FETCH_ENV]?.trim()) return local();
  const fetchImpl = options.fetchImpl === undefined
    ? (typeof fetch === "function" ? fetch : null)
    : options.fetchImpl;
  if (!fetchImpl) return local();

  const url = options.url ?? TRIAGE_PLAYBOOK_REMOTE_URL;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? TRIAGE_PLAYBOOK_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // The pinned raw.githubusercontent.com URL answers directly. A redirect
      // means something rewrote the request — a captive portal, a proxy, a
      // hijacked DNS answer — and following it would fetch instructions for a
      // coding agent from an origin nobody pinned. Fail to the local copy.
      redirect: "error",
      headers: { accept: "text/plain" },
    });
    if (!response.ok) return local();
    // Checked before the body is read, so a mis-served giant file is refused
    // rather than buffered.
    const declaredLength = Number(response.headers?.get?.("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > TRIAGE_PLAYBOOK_MAX_BYTES) return local();
    const text = await response.text();
    if (!text.trim() || text.length > TRIAGE_PLAYBOOK_MAX_BYTES) return local();
    return { text, source: "remote", origin: url };
  } catch {
    // Offline, DNS down, TLS interception, aborted by the timeout — all the
    // same answer: use what is on this machine.
    return local();
  } finally {
    clearTimeout(timer);
  }
}
