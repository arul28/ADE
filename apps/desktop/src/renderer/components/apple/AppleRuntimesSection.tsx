import { useState } from "react";
import type {
  AppleRuntimeEntry,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimeSimulatorDisposition,
  AppleXcodeStatus,
} from "../../../shared/types/iosSimulator";
import { Button } from "../ui/Button";
import { Banner } from "../ui/notice/Banner";
import { useBannerDismissals } from "../../lib/bannerDismiss";
import { cn } from "../ui/cn";
import { checkboxConfirmDialog } from "../ui/dialog/confirm";
import { appleRuntimeInstallActive } from "./useAppleRuntimes";
import { showToast } from "../app/toast/toastStore";

/** The Mac App Store page for Xcode. */
const XCODE_APP_STORE_URL = "macappstore://apps.apple.com/app/xcode/id497799835";
const XCODE_UPDATE_BANNER_KEY = "apple-xcode-update";

const Spinner = () => (
  <span
    aria-hidden="true"
    className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
  />
);

/**
 * Decimal gigabytes, as Xcode and `xcodebuild -downloadPlatform` print them, so
 * "7.9 GB" here is the same number the download said.
 */
function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function sizeOf(entry: { sizeBytes: number | null }): string | null {
  return entry.sizeBytes === null ? null : gigabytes(entry.sizeBytes);
}

function simulatorsLabel(entry: AppleRuntimeEntry): string {
  const count = entry.simulators.length;
  if (!count) return "no simulators";
  const yours = entry.simulators.filter((simulator) => !simulator.ade).length;
  const base = `${count} simulator${count === 1 ? "" : "s"}`;
  return yours && yours !== count ? `${base} (${yours} yours)` : base;
}

/**
 * Ask before removing: what moves, what is erased, and what it frees.
 *
 * Moving (`simctl upgrade`) keeps a simulator's apps and data on the newest
 * runtime that runs its model; it is on by default. ADE's lane devices always
 * move, so the checkbox speaks only for the person's own simulators.
 */
async function confirmRemoval(input: {
  title: string;
  entries: AppleRuntimeEntry[];
  /** Every installed runtime, to tell which simulators have somewhere to go. */
  all: AppleRuntimeEntry[];
}): Promise<AppleRuntimeSimulatorDisposition | null> {
  const simulators = input.entries.flatMap((entry) => entry.simulators);
  const removing = new Set(input.entries.map((entry) => entry.runtimeIdentifier));
  const entryOf = new Map(input.entries.flatMap((entry) => entry.simulators.map((simulator) => [simulator.udid, entry] as const)));
  // A simulator can move only to a newer runtime that stays and runs its model.
  const canMove = (udid: string, typeId: string | null) => {
    const from = entryOf.get(udid);
    return Boolean(from && typeId && input.all.some((candidate) =>
      !removing.has(candidate.runtimeIdentifier)
      && candidate.platform === from.platform
      && candidate.version.localeCompare(from.version, undefined, { numeric: true }) > 0
      && candidate.deviceTypes.some((type) => type.identifier === typeId)));
  };
  const stranded = simulators.filter((simulator) => !canMove(simulator.udid, simulator.deviceTypeIdentifier));
  // A lane's device always moves and is never erased behind its lane, so one
  // no newer runtime runs blocks the removal outright: say so instead of
  // offering a dialog whose every answer fails.
  const strandedLaneDevices = stranded.filter((simulator) => simulator.laneHeld);
  if (strandedLaneDevices.length) {
    showToast({
      id: "apple-runtime-remove-blocked",
      tone: "warning",
      title: `Can't remove ${input.entries.length === 1 ? input.entries[0]!.name : "these runtimes"} yet`,
      message: `${strandedLaneDevices.map((simulator) => simulator.name).join(", ")} belongs to a lane and no newer runtime runs its model. Delete it from that lane first.`,
    });
    return null;
  }
  // Every simulator no lane holds (the person's, and ADE leftovers) follows
  // the move-or-erase choice.
  const choosable = simulators.filter((simulator) => !simulator.laneHeld);
  const bytes = input.entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const freed = bytes ? gigabytes(bytes) : null;
  const result = await checkboxConfirmDialog({
    title: input.title,
    destructive: true,
    confirmLabel: freed ? `Remove · free ${freed}` : "Remove",
    message: simulators.length
      ? `${simulators.length} simulator${simulators.length === 1 ? "" : "s"} run on ${input.entries.length === 1 ? "it" : "them"}. Lane devices move to the newest runtime that runs their model.`
      : "No simulators use it.",
    children: simulators.length ? (
      <ul className="max-h-40 min-w-0 list-disc overflow-y-auto pl-5 font-sans text-[12px] leading-5 text-fg/80">
        {simulators.map((simulator) => (
          <li key={simulator.udid} className="break-words">
            {simulator.name}
            <span className="text-muted-fg">{simulator.ade ? " · ADE" : " · yours"}</span>
            {stranded.includes(simulator) ? (
              <span className="text-warning">{" · no newer runtime runs it"}</span>
            ) : null}
          </li>
        ))}
      </ul>
    ) : undefined,
    checkboxes: choosable.length
      ? [{
        key: "move",
        label: stranded.length
          ? "Move the simulators to a newer runtime (keeps their apps and data). Ones no newer runtime runs stop the removal; uncheck to erase them instead."
          : "Move the simulators to a newer runtime (keeps their apps and data). Unchecked erases them.",
        // Nothing stranded can move, so erasing is the only answer that works.
        defaultChecked: !choosable.every((simulator) => stranded.includes(simulator)),
      }]
      : [],
  });
  if (!result.confirmed) return null;
  return choosable.length && !result.checked.move ? "erase" : "upgrade";
}

/**
 * RUNTIMES: one row per installed runtime with its size and what runs on it,
 * a Remove on each one CoreSimulator can delete, and one line that frees every
 * runtime a newer one fully replaces.
 */
export function AppleRuntimesSection({
  inventory,
  removing,
  disabled,
  onRemove,
  onPrune,
}: {
  inventory: AppleRuntimeInventory | null;
  removing: boolean;
  disabled: boolean;
  onRemove: (id: string, simulators: AppleRuntimeSimulatorDisposition) => void;
  onPrune: (simulators: AppleRuntimeSimulatorDisposition) => void;
}) {
  if (!inventory || !inventory.runtimes.length) return null;
  const replaceable = inventory.runtimes.filter((entry) => entry.superseded && entry.deletable);
  const replaceableBytes = replaceable.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const busy = disabled || removing || appleRuntimeInstallActive(inventory.install);
  return (
    <section aria-label="Runtimes" data-apple-picker-section="Runtimes" className="flex min-w-0 flex-col gap-2 pt-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5">
        <h3 className="font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">Runtimes</h3>
        {inventory.xcode.version ? (
          <span className="font-sans text-[11px] text-muted-fg">{`Xcode ${inventory.xcode.version}`}</span>
        ) : null}
      </div>
      <div className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col p-1.5">
        {inventory.runtimes.map((entry) => (
          <div
            key={entry.runtimeIdentifier}
            data-apple-runtime={entry.name}
            className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-sans text-[12px] font-medium leading-5 text-fg">{entry.name}</span>
                {entry.newest ? (
                  <span className="shrink-0 font-sans text-[10px] uppercase tracking-[0.08em] text-muted-fg">newest</span>
                ) : null}
              </span>
              <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
                {[sizeOf(entry), simulatorsLabel(entry), entry.deviceTypes.length === 1 ? `only ${entry.deviceTypes[0]!.name}` : null]
                  .filter(Boolean).join(" · ")}
              </span>
            </div>
            {entry.deletable ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${entry.name}`}
                onClick={() => {
                  void confirmRemoval({ title: `Remove ${entry.name}?`, entries: [entry], all: inventory.runtimes }).then((choice) => {
                    if (choice && entry.id) onRemove(entry.id, choice);
                  });
                }}
                className="h-6 shrink-0 px-2 text-[11px] text-muted-fg"
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {replaceable.length ? (
          <button
            type="button"
            disabled={busy}
            data-apple-runtime-prune=""
            onClick={() => {
              void confirmRemoval({
                title: `Remove ${replaceable.map((entry) => entry.name).join(" and ")}?`,
                entries: replaceable,
                all: inventory.runtimes,
              }).then((choice) => {
                if (choice) onPrune(choice);
              });
            }}
            className={cn(
              "mt-1 flex min-w-0 items-center gap-2 rounded border-t border-border/40 px-1.5 pb-1 pt-2 text-left font-sans text-[12px] leading-5 text-accent",
              "hover:text-accent/80 disabled:opacity-50",
            )}
          >
            {removing ? <Spinner /> : null}
            <span className="min-w-0 flex-1">
              {`Free ${replaceableBytes ? gigabytes(replaceableBytes) : "space"}: remove ${replaceable.length} older runtime${replaceable.length === 1 ? "" : "s"}`}
            </span>
            <span aria-hidden="true">▸</span>
          </button>
        ) : null}
      </div>
      <p className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-muted-fg">
        A runtime is the iOS a simulator runs. Older ones are only worth keeping for testing an older iOS.
      </p>
    </section>
  );
}

/** The download as one line: phase, bar, and Cancel. */
export function AppleRuntimeInstallProgress({
  install,
  onCancel,
}: {
  install: AppleRuntimeInstallState;
  onCancel: () => void;
}) {
  const active = appleRuntimeInstallActive(install);
  const label = (() => {
    switch (install.phase) {
      case "checking": return "Checking free space…";
      case "preparing": return "Preparing download…";
      case "downloading": return `${install.percent?.toFixed(0) ?? 0}% · ${install.received ?? "…"} of ${install.total ?? "…"}`;
      case "installing": return "Installing…";
      case "done": return "Installed.";
      case "cancelled": return "Download cancelled.";
      case "failed": return install.message ?? "The download failed.";
    }
  })();
  return (
    <div data-apple-runtime-install={install.phase} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60">
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", install.phase === "failed" ? "bg-error" : "bg-accent")}
            style={{ width: `${Math.max(2, Math.min(100, install.percent ?? (active ? 2 : 100)))}%` }}
          />
        </div>
        {active ? (
          <Button variant="ghost" size="sm" onClick={onCancel} className="h-6 shrink-0 px-2 text-[11px] text-muted-fg">
            Cancel
          </Button>
        ) : null}
      </div>
      <span className={cn("min-w-0 break-words font-sans text-[11px] leading-4", install.phase === "failed" ? "text-error" : "text-muted-fg")}>
        {`iOS ${install.version} · ${label}`}
      </span>
    </div>
  );
}

/**
 * The note at the top of the picker, only when there is something to do:
 * Xcode's first-launch setup has not run, or Apple has shipped a newer Xcode.
 * The update note's dismissal is durable and holds for that version only.
 */
export function AppleXcodeNote({
  xcode,
  onRunSetup,
}: {
  xcode: AppleXcodeStatus | null | undefined;
  onRunSetup: () => Promise<void>;
}) {
  const dismissals = useBannerDismissals();
  const [running, setRunning] = useState(false);
  if (!xcode?.version) return null;
  const update = xcode.updateAvailable && xcode.latest
    && !dismissals.isDismissed(XCODE_UPDATE_BANNER_KEY, xcode.latest.version)
    ? xcode.latest
    : null;
  if (xcode.firstLaunchPending) {
    return (
      <Banner
        layout="inline"
        model={{
          id: "apple-xcode-setup",
          tone: "warning",
          title: `Xcode ${xcode.version} hasn't finished its first-launch setup, so simulators may not start.`,
          busy: running,
          actions: [{
            label: "Run setup",
            onClick: () => {
              setRunning(true);
              void onRunSetup().finally(() => setRunning(false));
            },
            disabled: running,
          }],
          dismiss: false,
        }}
      />
    );
  }
  if (!update) return null;
  return (
    <Banner
      layout="inline"
      model={{
        id: "apple-xcode-update",
        tone: "info",
        title: `Xcode ${update.version} is out (you have ${xcode.version}).`,
        detail: "Update it in the App Store.",
        actions: [{ label: "Open", href: XCODE_APP_STORE_URL }],
        dismiss: { key: XCODE_UPDATE_BANNER_KEY, fingerprint: update.version },
      }}
      onDurableDismiss={({ key, fingerprint }) => dismissals.dismiss(key, fingerprint)}
    />
  );
}
