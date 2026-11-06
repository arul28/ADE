/**
 * Puts ADE's machine template into the person's Agent37 workspace, and keeps
 * it on the running ADE release.
 *
 * Agent37 templates are per workspace, so a workspace that has never seen ADE
 * has nothing to make a box from. Saving the key (and every app start with a
 * key saved) runs `ensure()`: ask Agent37 for the template; when it is missing,
 * or was built for an older ADE release than this one, run Agent37's cloud
 * build over its REST API (create build, upload the context, start, poll). No
 * CLI and no local Docker: the context is the two files in `infra/agent37/template`,
 * shipped with the app as the `agent37-template` resource and packed here.
 *
 * What the template installs is recorded in its own description
 * (`ADE <version> · template <hash>`), so every computer reads the same answer
 * from Agent37. A build in flight is recorded in the account vault (falling
 * back to this computer's credential file) with its Agent37 build id, so:
 *   - another computer on the account that sees a fresh record polls that
 *     build instead of starting a second one, and
 *   - an app restart resumes polling the same build.
 * One build at a time per process (single flight); failures retry with
 * backoff, then stop and wait for Retry.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Agent37TemplateProgress, Agent37TemplateStatus } from "../../../shared/agent37";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import { Agent37Error, type Agent37Client, type Agent37Template } from "./agent37Client";

export type Agent37TemplateContextFiles = {
  dockerfile: string;
  entrypoint: string;
};

/** The shared record of a build in flight. */
export type Agent37TemplateBuildRecord = {
  v: 1;
  template: string;
  buildId: string;
  /** Epoch ms. */
  startedAt: number;
  adeVersion: string;
  contextHash: string;
  /** Which computer started it, for the log. */
  by: string | null;
};

export type Agent37TemplateRecordStore = {
  /**
   * The record, or null when there is none. Throws when the account's shared
   * record can't be read: that is "unknown", never "nobody is building".
   */
  read(): Promise<Agent37TemplateBuildRecord | null>;
  /** Logs its own failures; never throws. */
  write(record: Agent37TemplateBuildRecord): Promise<void>;
  /** Logs its own failures; never throws. */
  clear(): Promise<void>;
};

export type Agent37TemplateBuilderDeps = {
  /** Null when no key is saved. */
  client: () => Promise<Agent37Client | null>;
  templateName: () => string;
  /**
   * The ADE release to bake in and compare against, or null for a build that
   * is not a published release (development, alpha): it bakes the newest
   * release and only ever creates a missing template, never replaces one.
   */
  adeVersion: string | null;
  readContext: () => Promise<Agent37TemplateContextFiles>;
  records: Agent37TemplateRecordStore;
  machineLabel?: string | null;
  onStatus: (status: Agent37TemplateStatus) => void;
  logger?: {
    info?(event: string, meta?: Record<string, unknown>): void;
    warn?(event: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Also how often the step a person sees can move. */
const POLL_MS = 5_000;
/** Agent37 times a build out at 45 min; past this a record is stale. */
const BUILD_RECORD_TTL_MS = 50 * 60_000;
/** A build still `created` this long after it was made will never start. */
const UNSTARTED_BUILD_MS = 3 * 60_000;
/** Automatic retries after a failed build, then it waits for Retry. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/**
 * After claiming a build, how long to wait before reading the shared record
 * back: long enough for another computer's claim, written at the same moment,
 * to reach this one through the account vault.
 */
const CLAIM_SETTLE_MS = 5_000;
/** Waits between reads that confirm a finished build published the template and its marker. */
const CONFIRM_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

const MARKER = /ADE (\S+) · template ([0-9a-f]{6,})/;

export function agent37TemplateDescription(adeVersion: string, contextHash: string): string {
  return `ADE's machine template. ADE ${adeVersion} · template ${contextHash}`;
}

export function readAgent37TemplateMarker(description: string | null): { adeVersion: string; contextHash: string } | null {
  const match = description ? MARKER.exec(description) : null;
  return match ? { adeVersion: match[1]!, contextHash: match[2]! } : null;
}

/**
 * Whether an existing template is good enough for this ADE.
 *
 * A release build replaces a template that ADE did not build (no marker), or
 * one from an older ADE release. A template from a newer release (built by a
 * newer ADE on another computer of the account) is kept whatever its files: an
 * older ADE must never put its older template back, or two computers on
 * different releases would replace each other's template on every start. Same
 * release, different files only happens between development builds of the
 * same version, and the files win. A non-release build never replaces an
 * existing template.
 */
export function agent37TemplateIsCurrent(
  template: Pick<Agent37Template, "description">,
  want: { adeVersion: string | null; contextHash: string },
): boolean {
  if (want.adeVersion == null) return true;
  const marker = readAgent37TemplateMarker(template.description);
  if (!marker) return false;
  if (marker.adeVersion === "latest") return false;
  const order = compareUpdateVersions(marker.adeVersion, want.adeVersion);
  if (order !== 0) return order > 0;
  return marker.contextHash === want.contextHash;
}

/** The four steps a person sees while the template builds. */
const TEMPLATE_PROGRESS_LABELS = [
  "Installing the desktop and browser",
  "Installing ADE",
  "Adding Docker and Android tools",
  "Saving the machine image",
] as const;

/** One Dockerfile step as BuildKit's plain log names it: `#7 [4/8] RUN …`. */
export type Agent37BuildLogStep = { index: number; total: number; text: string };

const BUILD_LOG_STEP = /^#\d+ \[(?:[^\]\s]+ )?(\d+)\/(\d+)\] (.+)$/;
const BUILD_LOG_EXPORT = /^#\d+ (?:exporting|writing image|naming to|pushing|exporting layers)/i;

/**
 * Reads one chunk of the build log: the last Dockerfile step it names, and
 * whether the build reached exporting the image. Lines BuildKit prints for a
 * running step (`#7 12.3 …`) carry no step and are skipped.
 */
export function readAgent37BuildLog(chunk: string): { step: Agent37BuildLogStep | null; exporting: boolean } {
  let step: Agent37BuildLogStep | null = null;
  let exporting = false;
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim();
    const match = BUILD_LOG_STEP.exec(line);
    if (match) {
      step = { index: Number(match[1]), total: Number(match[2]), text: match[3]! };
      continue;
    }
    if (BUILD_LOG_EXPORT.test(line)) exporting = true;
  }
  return { step, exporting };
}

/**
 * Where a build is, in the four steps a person sees. `status` is Agent 37's
 * build status; `step` the last Dockerfile step the log named; `exporting`
 * whether the log reached exporting the image. Null before anything is known.
 */
export function agent37TemplateProgress(
  status: string,
  step: Agent37BuildLogStep | null,
  exporting: boolean,
): Agent37TemplateProgress | null {
  const at = (index: number): Agent37TemplateProgress => ({
    step: index + 1,
    steps: TEMPLATE_PROGRESS_LABELS.length,
    label: TEMPLATE_PROGRESS_LABELS[index]!,
  });
  // Built: Agent 37 is copying the image into its storage, then publishing it.
  if (status === "ingesting" || status === "succeeded" || exporting) return at(3);
  if (!step) return status === "building" ? at(0) : null;
  const text = step.text;
  if (/^COPY\b|chmod 755 \/usr\/local\/bin\/ade-entrypoint/.test(text)) return at(3);
  // The Android step starts by installing Java (default-jre-headless) for sdkmanager.
  if (/android|sdkmanager|commandlinetools|default-jre-headless|download\.docker\.com|docker-ce/i.test(text)) return at(2);
  if (/install\.sh|ADE_VERSION|ade --version/.test(text)) return at(1);
  return at(0);
}

/** The Dockerfile with the ADE release pinned (install.sh takes the release tag). */
export function pinAgent37Dockerfile(dockerfile: string, adeVersion: string | null): string {
  if (!adeVersion) return dockerfile;
  const tag = adeVersion.startsWith("v") ? adeVersion : `v${adeVersion}`;
  return dockerfile.replace(/^ARG ADE_VERSION=latest$/m, `ARG ADE_VERSION=${tag}`);
}

export function agent37TemplateContextHash(files: Agent37TemplateContextFiles): string {
  return createHash("sha256")
    .update(files.dockerfile)
    .update("\0")
    .update(files.entrypoint)
    .digest("hex")
    .slice(0, 12);
}

/** One ustar entry: a 512-byte header, then the data padded to 512. */
function tarEntry(name: string, data: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const field = (offset: number, length: number, value: string) => {
    header.write(value.slice(0, length), offset, length, "ascii");
  };
  const octal = (offset: number, length: number, value: number) => {
    field(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  };
  field(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, data.length);
  octal(136, 12, Math.floor(Date.UTC(2026, 0, 1) / 1000));
  header.fill(0x20, 148, 156);
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, padding]);
}

/** The gzipped build context: Dockerfile and entrypoint at its root, nothing else. */
export function packAgent37TemplateContext(files: Agent37TemplateContextFiles): Buffer {
  const tar = Buffer.concat([
    tarEntry("Dockerfile", Buffer.from(files.dockerfile, "utf8"), 0o644),
    tarEntry("ade-entrypoint.sh", Buffer.from(files.entrypoint, "utf8"), 0o755),
    Buffer.alloc(1024, 0),
  ]);
  return gzipSync(tar);
}

/** A failed build's reason, in words. */
function buildFailureMessage(code: string | null, message: string | null): string {
  switch (code) {
    case "build_failed":
      return "a step of the template build failed on Agent 37.";
    case "build_timeout":
      return "the template build ran past Agent 37's 45-minute limit.";
    case "image_too_large":
      return "the template came out larger than Agent 37 allows.";
    case "try_again":
      return "Agent 37 had no build machine free.";
    case "image_ingest_failed":
    case "internal_error":
      return "Agent 37 had a problem on its side while building.";
    default:
      return message ? `Agent 37 said: ${message}` : "the template build failed on Agent 37.";
  }
}

class BuildFailed extends Error {}

/** No point retrying these on a timer: the key itself is the problem. */
function isFatal(error: unknown): boolean {
  return error instanceof Agent37Error
    && (error.code === "invalid_api_key" || error.code === "ip_not_allowed" || error.code === "insufficient_balance");
}

function plainReason(error: unknown): string {
  if (error instanceof Agent37Error && error.code === "insufficient_balance") {
    return "Agent 37 builds templates only for a workspace with money in its wallet. Top it up, then press Retry.";
  }
  if (error instanceof Agent37Error && error.code === "invalid_api_key") {
    return "Agent 37 no longer accepts the saved key. Connect a new key on this page.";
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\.$/, "") + ".";
}

export function createAgent37TemplateBuilder(deps: Agent37TemplateBuilderDeps) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  }));

  let status: Agent37TemplateStatus = {
    template: deps.templateName(),
    state: "idle",
    usable: false,
    adeVersion: deps.adeVersion,
    startedAt: null,
    minutesLeft: null,
    error: null,
    nextRetryAt: null,
  };
  let current: { controller: AbortController; promise: Promise<void> } | null = null;

  const publish = (next: Partial<Agent37TemplateStatus>) => {
    status = { ...status, ...next };
    deps.onStatus(status);
  };
  /** A pass that was cancelled (key removed, Retry) says nothing more. */
  const set = (signal: AbortSignal, next: Partial<Agent37TemplateStatus>) => {
    if (!signal.aborted) publish(next);
  };

  /**
   * Polls one build to its end through its log, so the status names the step
   * it is on. Resolves on success; throws `BuildFailed` on failure.
   */
  async function follow(client: Agent37Client, buildId: string, startedAt: number, usable: boolean, signal: AbortSignal) {
    set(signal, { state: "building", usable, startedAt, minutesLeft: null, progress: null, error: null, nextRetryAt: null });
    let offset = 0;
    let lastStep: Agent37BuildLogStep | null = null;
    let exporting = false;
    let shown: Agent37TemplateProgress | null = null;
    for (;;) {
      if (signal.aborted) return;
      // The log endpoint answers the build too. A log that can't be read
      // (an older API, a hiccup, a 404 before the log exists) only costs the
      // step name, never the build: the build itself says if it is gone.
      let build: Awaited<ReturnType<Agent37Client["getTemplateBuild"]>>;
      const read = await client.getTemplateBuildLog(buildId, offset).catch((error: unknown) => {
        deps.logger?.warn?.("agent37.template_build_log_failed", { buildId, error: plainReason(error) });
        return undefined;
      });
      if (read == null) {
        build = await client.getTemplateBuild(buildId);
      } else {
        build = read.build;
        offset = read.offset;
        const chunk = readAgent37BuildLog(read.data);
        if (chunk.step) lastStep = chunk.step;
        if (chunk.exporting) exporting = true;
      }
      if (!build) throw new BuildFailed("Agent 37 lost track of the template build.");
      if (build.status === "succeeded") return;
      if (build.status === "failed") throw new BuildFailed(buildFailureMessage(build.errorCode, build.errorMessage));
      // Made but never started: whoever made it stopped before uploading.
      if (build.status === "created" && now() - startedAt > UNSTARTED_BUILD_MS) {
        throw new BuildFailed("the template build was never started.");
      }
      if (now() - startedAt > BUILD_RECORD_TTL_MS) throw new BuildFailed("the template build didn't finish in time.");
      // Steps only move forward: BuildKit reprints cached steps quickly at the start.
      const next = agent37TemplateProgress(build.status, lastStep, exporting);
      if (next && (!shown || next.step > shown.step)) {
        shown = next;
        set(signal, { progress: next });
      }
      await sleep(POLL_MS, signal);
    }
  }

  /** One check-and-build pass. */
  async function pass(signal: AbortSignal): Promise<void> {
    const client = await deps.client();
    const template = deps.templateName();
    if (!client) {
      set(signal, { template, state: "idle", usable: false, startedAt: null, minutesLeft: null, progress: null, error: null, nextRetryAt: null });
      return;
    }
    if (status.state !== "building") set(signal, { template, state: "checking" });
    const files = await deps.readContext();
    const contextHash = agent37TemplateContextHash(files);
    const bakedVersion = deps.adeVersion ?? "latest";
    const want = { adeVersion: deps.adeVersion, contextHash };

    const existing = await client.getTemplate(template);
    if (existing && agent37TemplateIsCurrent(existing, want)) {
      set(signal, {
        template,
        state: "ready",
        usable: true,
        adeVersion: readAgent37TemplateMarker(existing.description)?.adeVersion ?? deps.adeVersion,
        startedAt: null,
        minutesLeft: null,
        progress: null,
        error: null,
        nextRetryAt: null,
      });
      return;
    }
    const usable = existing != null;
    if (signal.aborted) return;

    // Someone on the account may already be building this exact template. A
    // record that can't be read is unknown, not absent: starting a build then
    // could run a second one beside theirs, so this pass fails and retries.
    let record: Agent37TemplateBuildRecord | null;
    try {
      record = await deps.records.read();
    } catch (error) {
      deps.logger?.warn?.("agent37.template_record_read_failed", { template, error: plainReason(error) });
      throw new Error("ADE couldn't check your account for a template build already running on another computer");
    }
    const sameBuild = (candidate: Agent37TemplateBuildRecord | null): candidate is Agent37TemplateBuildRecord =>
      candidate != null
      && candidate.template === template
      && candidate.contextHash === contextHash
      && candidate.adeVersion === bakedVersion
      && now() - candidate.startedAt < BUILD_RECORD_TTL_MS;
    if (sameBuild(record)) {
      const build = await client.getTemplateBuild(record.buildId);
      if (build && build.status !== "failed") {
        deps.logger?.info?.("agent37.template_build_resumed", { template, buildId: record.buildId, by: record.by });
        await follow(client, record.buildId, record.startedAt, usable, signal);
        if (signal.aborted) return;
        await finish(client, template, bakedVersion, contextHash, signal);
        return;
      }
    }

    // Start a build.
    const description = agent37TemplateDescription(bakedVersion, contextHash);
    const context = packAgent37TemplateContext({ ...files, dockerfile: pinAgent37Dockerfile(files.dockerfile, deps.adeVersion) });
    const build = await client.createTemplateBuild({ name: template, sizeBytes: context.length, description });
    const startedAt = now();
    const ours: Agent37TemplateBuildRecord = {
      v: 1,
      template,
      buildId: build.id,
      startedAt,
      adeVersion: bakedVersion,
      contextHash,
      by: deps.machineLabel ?? null,
    };
    // Claim it before the slow part, so another computer that checks now waits on this one.
    await deps.records.write(ours);
    deps.logger?.info?.("agent37.template_build_started", { template, buildId: build.id, adeVersion: bakedVersion, contextHash, usable });
    set(signal, { state: "building", usable, startedAt, minutesLeft: null, progress: null, error: null, nextRetryAt: null });

    // The vault has no compare-and-set, so two computers can claim at once.
    // Read the record back after a moment: when another computer's claim for
    // the same template is there and its build has not failed, follow that
    // one. Ours is never uploaded or started, so it never runs (Agent37 has no
    // way to cancel a build; an unstarted one is simply left behind).
    await sleep(CLAIM_SETTLE_MS, signal);
    if (signal.aborted) return;
    let claimed: Agent37TemplateBuildRecord | null = null;
    try {
      claimed = await deps.records.read();
    } catch (error) {
      // Unknown is not "nobody else": leave ours unstarted and retry the pass,
      // rather than risk two computers building at once.
      deps.logger?.warn?.("agent37.template_claim_check_failed", { template, buildId: build.id, error: plainReason(error) });
      throw new Error("ADE couldn't confirm no other computer is setting up the template. It will try again.");
    }
    if (!claimed) {
      // Our own claim did not land (the shared record refused the write).
      deps.logger?.warn?.("agent37.template_claim_not_recorded", { template, buildId: build.id });
      throw new Error("ADE couldn't save that it's setting up the template. It will try again.");
    }
    if (sameBuild(claimed) && claimed.buildId !== build.id) {
      // The record's last write is the one answer every computer reads back,
      // so it decides: follow the build it names. Never overwrite it with ours,
      // since the computer that wrote it has already read it and started its
      // build; a rewrite here could only make two builds, or none.
      let theirs: Awaited<ReturnType<Agent37Client["getTemplateBuild"]>>;
      try {
        theirs = await client.getTemplateBuild(claimed.buildId);
      } catch (error) {
        // Unknown is not "failed": leave ours unstarted and retry the pass.
        deps.logger?.warn?.("agent37.template_claim_build_read_failed", { template, buildId: claimed.buildId, error: plainReason(error) });
        throw new Error("ADE couldn't check the template build another computer started. It will try again.");
      }
      if (theirs != null && theirs.status !== "failed") {
        deps.logger?.info?.("agent37.template_build_yielded", { template, buildId: build.id, followed: claimed.buildId, by: claimed.by });
        await follow(client, claimed.buildId, claimed.startedAt, usable, signal);
        if (signal.aborted) return;
        await finish(client, template, bakedVersion, contextHash, signal);
        return;
      }
      // Theirs failed or is gone (Agent 37 no longer has it): nobody is
      // building, so ours takes the record and runs.
      deps.logger?.info?.("agent37.template_build_claim_taken", { template, buildId: build.id, other: claimed.buildId, otherStatus: theirs?.status ?? "missing", by: claimed.by });
      await deps.records.write(ours);
    }
    await client.uploadTemplateContext(build.uploadUrl, context);
    try {
      await client.startTemplateBuild(build.id);
    } catch (error) {
      // Already started (a retried call) is fine; three builds already running is not ours to wait on.
      const alreadyStarted = error instanceof Agent37Error && error.code === "build_conflict"
        && (await client.getTemplateBuild(build.id).catch(() => null))?.status !== "created";
      if (!alreadyStarted) throw error;
    }
    await follow(client, build.id, startedAt, usable, signal);
    if (signal.aborted) return;
    await finish(client, template, bakedVersion, contextHash, signal);
  }

  /**
   * A finished build is ready only once Agent37 shows the template with this
   * build's marker, since that is what every computer reads. Until then the
   * build record stays, so a later pass (here or elsewhere) resumes here.
   */
  async function finish(client: Agent37Client, template: string, bakedVersion: string, contextHash: string, signal: AbortSignal) {
    const description = agent37TemplateDescription(bakedVersion, contextHash);
    let published: Agent37Template | null = null;
    let lastReason = "it isn't published yet";
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return;
      try {
        published = await client.getTemplate(template);
        const marker = readAgent37TemplateMarker(published?.description ?? null);
        if (published && marker?.adeVersion === bakedVersion && marker.contextHash === contextHash) break;
        if (published) {
          // Published without the marker: set it, then read it back on the next turn.
          await client.setTemplateDescription(template, description);
          lastReason = "its description didn't update yet";
        } else {
          lastReason = "it isn't published yet";
        }
      } catch (error) {
        lastReason = plainReason(error).replace(/\.$/, "");
        deps.logger?.warn?.("agent37.template_confirm_failed", { template, attempt, error: lastReason });
      }
      const delay = CONFIRM_DELAYS_MS[attempt];
      if (delay == null) {
        throw new Error(`Agent 37 finished the template build, but ADE couldn't confirm the template: ${lastReason}`);
      }
      await sleep(delay, signal);
    }
    await deps.records.clear();
    deps.logger?.info?.("agent37.template_build_succeeded", { template, revision: published?.revision ?? null });
    set(signal, { state: "ready", usable: true, adeVersion: bakedVersion, startedAt: null, minutesLeft: null, progress: null, error: null, nextRetryAt: null });
  }

  async function loop(signal: AbortSignal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await pass(signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        const reason = plainReason(error);
        deps.logger?.warn?.("agent37.template_build_failed", { template: deps.templateName(), attempt, error: reason });
        const delay = isFatal(error) ? null : RETRY_DELAYS_MS[attempt] ?? null;
        // A build that failed is over; drop the claim so the next try starts fresh.
        if (error instanceof BuildFailed) await deps.records.clear();
        set(signal, {
          state: "failed",
          error: reason,
          startedAt: null,
          minutesLeft: null,
          progress: null,
          nextRetryAt: delay == null ? null : now() + delay,
        });
        if (delay == null) return;
        await sleep(delay, signal);
        if (signal.aborted) return;
      }
    }
  }

  function start(): Promise<void> {
    if (current) return current.promise;
    const controller = new AbortController();
    const promise = loop(controller.signal).finally(() => {
      if (current?.controller === controller) current = null;
    });
    current = { controller, promise };
    return promise;
  }

  function cancel() {
    current?.controller.abort();
    current = null;
  }

  return {
    status: (): Agent37TemplateStatus => status,
    /** Checks, and builds when needed. One pass at a time; a call during one joins it. */
    ensure: (): Promise<void> => start(),
    /** Retry now: cancels a wait between automatic tries and starts over. */
    retry: (): Promise<void> => {
      if (status.state === "failed") cancel();
      return start();
    },
    /** The key was removed: stop following. A build already on Agent37 keeps going there. */
    reset: () => {
      cancel();
      publish({ template: deps.templateName(), state: "idle", usable: false, startedAt: null, minutesLeft: null, progress: null, error: null, nextRetryAt: null });
    },
  };
}

export type Agent37TemplateBuilder = ReturnType<typeof createAgent37TemplateBuilder>;
