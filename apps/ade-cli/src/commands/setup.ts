/**
 * `ade setup` -- the interactive half of installation.
 *
 * The shell installers can only own what happens before this binary exists:
 * download the runtime, verify it, register the brain. Everything after that
 * (agent CLIs, account, desktop app, verification, the closing summary) lives
 * here, once, in a form that can be unit-tested -- instead of twice, in
 * PowerShell and POSIX sh, where the two copies had already drifted.
 *
 * The installer invokes it as:
 *   ade setup --continue --runtime-version <v> --runtime-path <p> \
 *             --elapsed-ms <n> --downloaded-bytes <n>
 * so the summary can report all five steps even though the first two happened
 * before this process started.
 *
 * Every step is independently idempotent and non-fatal: a failure marks its own
 * step and the run continues, because a failed sign-in must not cost the user
 * the desktop app. Nothing here reports success it did not achieve.
 */
import {
  SetupReporter,
  detectTerminalCapabilities,
  type SetupProgress,
  type SetupStep,
  type SetupTotals,
} from "./setupRender";
import {
  assetUrl,
  defaultDesktopAppPath,
  downloadWithResume,
  installDesktopArtifact,
  launchDesktopApp,
  manifestNameForPlatform,
  parseDesktopManifest,
  sha512Base64,
  DEFAULT_ADE_RELEASE_REPO,
  type DesktopManifestEntry,
} from "./setupDesktop";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class SetupUsageError extends Error {}

export type SetupOptions = {
  /** Installer already printed the banner and steps 1-2. */
  continueFromInstaller: boolean;
  desktop: boolean;
  prompt: boolean;
  runtimeVersion: string | null;
  runtimePath: string | null;
  nativePath: string | null;
  elapsedMs: number;
  downloadedBytes: number;
  repo: string;
  releaseVersion: string;
};

export type SetupAccountStatus = {
  signedIn: boolean;
  identity: string | null;
};

export type SetupStepResult = {
  ok: boolean;
  detail: string;
  nextAction?: string;
};

export type SetupDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  reporter?: SetupReporter;
  /** Numbered/boolean prompt. Returns the chosen index, or null when unusable. */
  ask?: (question: string, choices: readonly string[]) => Promise<number | null>;

  ensureAgentTools: (
    onProgress: (progress: SetupProgress) => void,
  ) => Promise<SetupStepResult>;
  getAccountStatus: () => Promise<SetupAccountStatus>;
  runConnect: () => Promise<SetupStepResult>;
  readInstalledDesktop: () => { version: string | null; path: string | null };
  fetchImpl?: typeof fetch;
  installDesktop?: typeof installDesktopArtifact;
  launchDesktop?: typeof launchDesktopApp;
  /** Final end-to-end check; its failure downgrades the summary heading. */
  verify: () => Promise<SetupStepResult>;
};

export type SetupResult = {
  ok: boolean;
  action: "setup";
  steps: SetupStep[];
  verified: boolean;
  totals: SetupTotals;
};

function readValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new SetupUsageError(`${flag} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function readSwitch(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function readNumber(args: string[], flag: string): number {
  const raw = readValue(args, flag);
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new SetupUsageError(`${flag} must be a non-negative number`);
  }
  return value;
}

export function parseSetupArgs(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SetupOptions {
  const args = [...rest];
  const continueFromInstaller = readSwitch(args, "--continue");
  const noDesktop = readSwitch(args, "--no-desktop");
  const noPrompt = readSwitch(args, "--no-prompt");
  const runtimeVersion = readValue(args, "--runtime-version");
  const runtimePath = readValue(args, "--runtime-path");
  const nativePath = readValue(args, "--native-path");
  const elapsedMs = readNumber(args, "--elapsed-ms");
  const downloadedBytes = readNumber(args, "--downloaded-bytes");
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) throw new SetupUsageError(`Unknown option ${unknown}`);
  return {
    continueFromInstaller,
    desktop: !noDesktop,
    prompt: !noPrompt && env.ADE_INSTALL_NO_PROMPT !== "1",
    runtimeVersion,
    runtimePath,
    nativePath,
    elapsedMs,
    downloadedBytes,
    repo: env.ADE_RELEASE_REPO?.trim() || DEFAULT_ADE_RELEASE_REPO,
    releaseVersion: env.ADE_VERSION?.trim() || "latest",
  };
}

/** Reads one line from the terminal. Null when there is no usable terminal. */
export async function askOnStdin(
  question: string,
  choices: readonly string[],
  write: (text: string) => void,
): Promise<number | null> {
  if (!process.stdin.isTTY) return null;
  const rendered = choices.length > 2
    ? `${question}\n${choices
      .map((choice, index) => `      ${index + 1}) ${choice}${index === 0 ? "  (default)" : ""}`)
      .join("\n")}\n    Choose [1]: `
    : `${question} [Y/n]: `;
  write(rendered);

  const answer = await new Promise<string>((resolve) => {
    const finish = (value: string) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => finish(chunk.toString("utf8").trim());
    // Without these the installer hangs forever on a closed stdin instead of
    // falling through to the default -- a hang is a far worse failure than a
    // wrong default, and it strands the user mid-install with no prompt back.
    const onEnd = () => finish("");
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onEnd);
  });

  if (choices.length > 2) {
    if (answer === "") return 0;
    const index = Number(answer) - 1;
    return Number.isInteger(index) && index >= 0 && index < choices.length
      ? index
      : 0;
  }
  if (answer === "") return 0;
  return /^(n|no)$/i.test(answer) ? 1 : 0;
}

const STEP_LABELS: Record<string, string> = {
  runtime: "ADE runtime",
  native: "Native dependencies",
  tools: "Agent CLIs",
  account: "Account",
  desktop: "Desktop app",
};

function makeStep(id: SetupStep["id"]): SetupStep {
  return { id, label: STEP_LABELS[id] ?? id, state: "pending", detail: "" };
}

export async function runSetupCommand(
  rest: readonly string[],
  deps: SetupDeps,
): Promise<SetupResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const options = parseSetupArgs(rest, env);
  const startedAt = now();

  const reporter = deps.reporter
    ?? new SetupReporter(
      (text) => process.stderr.write(text),
      detectTerminalCapabilities(process.stderr, env, platform),
    );
  const ask = deps.ask
    ?? ((question, choices) =>
      askOnStdin(question, choices, (text) => reporter.prompt(text)));
  const interactive = options.prompt && reporter.caps.interactive;

  if (!options.continueFromInstaller) reporter.banner();

  // Steps 1-2 already happened in the shell; carry them so the summary is whole.
  const runtimeStep = makeStep("runtime");
  runtimeStep.state = options.runtimeVersion ? "ok" : "skipped";
  runtimeStep.detail = options.runtimeVersion ?? "already installed";
  runtimeStep.location = options.runtimePath ?? undefined;

  // The shell prints this one live while it extracts the archive; carrying it
  // here keeps the summary a complete recap rather than one that quietly drops
  // a step the user just watched succeed.
  const nativeStep = makeStep("native");
  nativeStep.state = options.nativePath ? "ok" : "skipped";
  nativeStep.detail = options.nativePath ? "installed" : "already installed";
  nativeStep.location = options.nativePath ?? undefined;

  const toolsStep = makeStep("tools");
  const accountStep = makeStep("account");
  const desktopStep = makeStep("desktop");
  const steps = [runtimeStep, nativeStep, toolsStep, accountStep, desktopStep];
  let downloadedBytes = options.downloadedBytes;

  // --- step: agent CLIs ------------------------------------------------------
  // Non-fatal by design: the brain retries this in the background on every
  // `ade serve`, so a flaky network here costs a wait, not an install.
  toolsStep.state = "active";
  reporter.beginStep(toolsStep);
  try {
    const result = await deps.ensureAgentTools((progress) => {
      reporter.updateStep(toolsStep, progress);
    });
    toolsStep.state = result.ok ? "ok" : "failed";
    toolsStep.detail = result.detail;
    toolsStep.nextAction = result.nextAction;
  } catch (error) {
    toolsStep.state = "failed";
    toolsStep.detail = describeError(error);
    toolsStep.nextAction = "ade tools ensure";
  }
  reporter.completeStep(toolsStep);

  // --- step: account ---------------------------------------------------------
  try {
    await runAccountStep({ step: accountStep, ask, interactive, deps });
  } catch (error) {
    accountStep.state = "failed";
    accountStep.detail = describeError(error);
    accountStep.nextAction = "ade connect";
  }
  reporter.completeStep(accountStep);

  // --- step: desktop app -----------------------------------------------------
  if (!options.desktop) {
    desktopStep.state = "skipped";
    desktopStep.detail = "skipped by --no-desktop";
  } else {
    try {
      downloadedBytes += await runDesktopStep({
        step: desktopStep,
        options,
        platform,
        env,
        reporter,
        ask,
        interactive,
        deps,
      });
    } catch (error) {
      desktopStep.state = "failed";
      desktopStep.detail = describeError(error);
      desktopStep.nextAction = "ade setup";
    }
  }
  reporter.completeStep(desktopStep);

  // --- verification ----------------------------------------------------------
  // "The files copied" is not the same claim as "it works". This is the check
  // that would have caught the install reporting success after sign-in failed.
  let verified = false;
  try {
    const result = await deps.verify();
    verified = result.ok;
    if (!result.ok && accountStep.state === "ok") {
      accountStep.state = "failed";
      accountStep.detail = result.detail;
      accountStep.nextAction = result.nextAction ?? "ade connect";
    }
  } catch {
    verified = false;
  }

  const totals: SetupTotals = {
    elapsedMs: options.elapsedMs + (now() - startedAt),
    downloadedBytes,
  };
  reporter.summary(steps, totals);

  return {
    ok: steps.every((step) => step.state !== "failed"),
    action: "setup",
    steps,
    verified,
    totals,
  };
}

function applyStepResult(
  step: SetupStep,
  result: SetupStepResult,
  fallbackAction: string,
): void {
  step.state = result.ok ? "ok" : "failed";
  step.detail = result.detail;
  step.nextAction = result.ok ? undefined : (result.nextAction ?? fallbackAction);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Account step: confirm an existing link rather than re-prompting blind.
 *
 * The installer used to ask "Sign in or create your ADE account?" on every run,
 * including for a machine that was already linked, because it never looked.
 */
async function runAccountStep(args: {
  step: SetupStep;
  ask: (question: string, choices: readonly string[]) => Promise<number | null>;
  interactive: boolean;
  deps: SetupDeps;
}): Promise<void> {
  const { step, ask, interactive, deps } = args;
  step.state = "active";
  const status = await deps.getAccountStatus();
  const linkedDetail = (identity: string | null) =>
    `already linked${identity ? ` - ${identity}` : ""}`;

  if (status.signedIn) {
    // A null answer means no usable terminal, which reads as "keep what works".
    const choice = interactive
      ? await ask(`  Already linked to ${status.identity ?? "an ADE account"}`, [
        "Keep this account",
        "Sign in as someone else",
        "Skip for now",
      ])
      : 0;
    if (choice === null || choice === 0) {
      step.state = "ok";
      step.detail = linkedDetail(status.identity);
    } else if (choice === 2) {
      step.state = "skipped";
      step.detail = "left as-is";
    } else {
      applyStepResult(step, await deps.runConnect(), "ade connect");
    }
    return;
  }

  const choice = interactive
    ? await ask("  Sign in or create your ADE account to link this machine?", [
      "Yes",
      "No",
    ])
    : 1;
  if (choice === 0) {
    // No live line here: `ade connect` prints its own step checklist, and an
    // animated line underneath it would be drawn over and orphaned.
    applyStepResult(step, await deps.runConnect(), "ade connect");
    return;
  }
  step.state = "skipped";
  step.detail = "not linked";
  step.nextAction = "ade connect";
}

/** Returns the bytes downloaded, so the summary total stays honest. */
async function runDesktopStep(args: {
  step: SetupStep;
  options: SetupOptions;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  reporter: SetupReporter;
  ask: (question: string, choices: readonly string[]) => Promise<number | null>;
  interactive: boolean;
  deps: SetupDeps;
}): Promise<number> {
  const { step, options, platform, env, reporter, ask, interactive, deps } = args;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (platform !== "win32" && platform !== "darwin") {
    step.state = "skipped";
    step.detail = "no desktop build for this platform";
    return 0;
  }

  const manifestName = manifestNameForPlatform(platform);
  const manifestResponse = await fetchImpl(
    assetUrl(manifestName, options.repo, options.releaseVersion),
  );
  if (!manifestResponse.ok) {
    throw new Error(`could not read ${manifestName}`);
  }
  const manifestText = await manifestResponse.text();
  const entry = parseDesktopManifest(manifestText, platform);
  if (!entry) throw new Error(`${manifestName} did not name an installer`);
  const releaseVersion = /^\s*version:\s*(\S+)\s*$/m.exec(manifestText)?.[1] ?? null;

  // Skip the gigabyte when this exact version is already on disk.
  const installed = deps.readInstalledDesktop();
  if (
    releaseVersion &&
    installed.version === releaseVersion &&
    installed.path &&
    fs.existsSync(installed.path)
  ) {
    step.state = "ok";
    step.detail = `${releaseVersion} already installed, opening`;
    step.location = installed.path;
    (deps.launchDesktop ?? launchDesktopApp)(installed.path, platform);
    return 0;
  }

  if (!interactive) {
    step.state = "skipped";
    step.detail = "not installed";
    step.nextAction = "ade setup";
    return 0;
  }

  const question = installed.version
    ? `  Update the ADE desktop app to ${releaseVersion ?? "the latest build"}? (about 1 GB download)`
    : "  Install the ADE desktop app? (about 1 GB download)";
  const choice = await ask(question, ["Yes", "No"]);
  if (choice !== 0) {
    step.state = "skipped";
    step.detail = "not installed";
    step.nextAction = "ade setup";
    return 0;
  }

  return await downloadAndInstallDesktop({
    step,
    entry,
    options,
    platform,
    env,
    reporter,
    deps,
  });
}

async function downloadAndInstallDesktop(args: {
  step: SetupStep;
  entry: DesktopManifestEntry;
  options: SetupOptions;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  reporter: SetupReporter;
  deps: SetupDeps;
}): Promise<number> {
  const { step, entry, options, platform, env, reporter, deps } = args;
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-dl-"));
  const artifact = path.join(stageDir, path.basename(entry.name));

  step.state = "active";
  reporter.beginStep(step);
  try {
    const bytes = await downloadWithResume(
      assetUrl(entry.name, options.repo, options.releaseVersion),
      artifact,
      (progress) => {
        reporter.updateStep(step, {
          fraction: progress.totalBytes
            ? progress.receivedBytes / progress.totalBytes
            : null,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          bytesPerSecond: progress.bytesPerSecond,
        });
      },
      { fetchImpl: deps.fetchImpl },
    );

    if (sha512Base64(artifact) !== entry.sha512) {
      throw new Error(`checksum mismatch for ${path.basename(entry.name)}`);
    }

    const installed = await (deps.installDesktop ?? installDesktopArtifact)(
      artifact,
      platform,
      env,
    );
    const appPath = installed.appPath ?? defaultDesktopAppPath(platform, env);
    step.state = "ok";
    step.location = appPath ?? undefined;
    if (appPath && fs.existsSync(appPath)) {
      // Detached: a GUI child would otherwise inherit this console on Windows
      // and spray Electron logs over the user's prompt.
      (deps.launchDesktop ?? launchDesktopApp)(appPath, platform);
      step.detail = "installed, opening now";
    } else {
      step.detail = "installed";
    }
    return bytes;
  } finally {
    // Windows only unlinks a name once every handle closes, and the NSIS
    // installer can still hold the .exe briefly after spawnSync returns --
    // `force` swallows ENOENT but not EBUSY/EPERM. Retry, then give up quietly:
    // a leftover temp file must never turn a successful install into a failure.
    try {
      fs.rmSync(stageDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {}
  }
}
