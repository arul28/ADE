import {
  desktopUpdateRequirement,
  isGateExemptVersion,
  type DesktopUpdateRequirement,
} from "../../../../desktop/src/shared/clientUpdateGate";
import { createClientMinimumReader, fetchClientMinimumBody } from "../../../../desktop/src/shared/clientMinimumReader";
import { createLatestByTrackReader } from "../../../../desktop/src/shared/latestByTrack";
import { setSentryUpdateGateResolver } from "../../../../desktop/src/shared/sentry/eventFilter";
import { forwardLogToSentry } from "../../../../desktop/src/shared/sentry/logBridge";
import { updateTrackOfVersion } from "../../../../desktop/src/shared/updateTrack";
import { compareUpdateVersions } from "../../../../desktop/src/shared/updateVersions";
import { isAdeCloudComputer } from "../../../../desktop/src/main/services/adeCloud/cloudComputerRules";
import { fetchReleaseManifestJson } from "../../lib/releaseAssets";
import { getSharedAccountDirectoryBaseUrl } from "../account/sharedAccountAuthService";

const READ_INTERVAL_MS = 3 * 60 * 60_000;

/**
 * The brain (`ade serve`: on a desktop, an npm install or an ADE Cloud
 * computer) against the owner's minimum. It never blocks anything: a brain
 * hosts running agents, and an ADE Cloud computer is updated by the account.
 * Below the minimum it says so once on stderr (and as
 * `client_update.required`), and drops its own Sentry errors, logs and
 * traces, which come from a build that is already fixed.
 *
 * Read at start, then every 3 hours (an unref'd timer: it never keeps the
 * process alive). The newest builds are read only for a build already below
 * a minimum, so a normal brain makes one small request per read.
 */
export function startBrainClientUpdateCheck(args: {
  version: string | null;
  env?: NodeJS.ProcessEnv;
  writeStderr?: (line: string) => void;
}): () => void {
  const version = args.version?.trim() || null;
  if (!version || isGateExemptVersion(version)) return () => undefined;
  const env = args.env ?? process.env;
  const writeStderr = args.writeStderr ?? ((line: string) => process.stderr.write(line));
  const minimum = createClientMinimumReader({
    fetchBody: () => fetchClientMinimumBody(getSharedAccountDirectoryBaseUrl({ env })),
  });
  const latest = createLatestByTrackReader({ fetchJson: fetchReleaseManifestJson });
  let announced: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let requirement: DesktopUpdateRequirement = { required: false };
  setSentryUpdateGateResolver(() => ({ requirement, version }));

  const check = async (): Promise<void> => {
    const answer = await minimum.refresh();
    const floor = answer?.desktop[updateTrackOfVersion(version)] ?? null;
    let next: DesktopUpdateRequirement = { required: false };
    if (floor && compareUpdateVersions(version, floor) < 0) {
      next = desktopUpdateRequirement({ currentVersion: version, minimum: answer, latest: await latest.refresh() });
    }
    requirement = next;
    if (!requirement.required) {
      announced = null;
      return;
    }
    if (announced === requirement.targetVersion) return;
    announced = requirement.targetVersion;
    const how = isAdeCloudComputer(env)
      ? "ADE Cloud updates this computer on its own"
      : env.ELECTRON_RUN_AS_NODE === "1"
        ? "update the ADE app, and it updates this brain too"
        : `download it from ${answer?.links.download ?? "https://ade-app.dev/download"}`;
    writeStderr(`ADE ${version} is no longer supported. Update to ${requirement.targetVersion}: ${how}.\n`);
    forwardLogToSentry("warn", "client_update.required", {
      surface: "brain",
      currentVersion: version,
      minimumVersion: requirement.minimumVersion,
      targetVersion: requirement.targetVersion,
      cloudComputer: isAdeCloudComputer(env),
    });
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void check().catch(() => undefined).finally(schedule);
    }, READ_INTERVAL_MS);
    timer.unref?.();
  };
  void check().catch(() => undefined).finally(schedule);
  return () => {
    stopped = true;
    setSentryUpdateGateResolver(null);
    if (timer) clearTimeout(timer);
  };
}
