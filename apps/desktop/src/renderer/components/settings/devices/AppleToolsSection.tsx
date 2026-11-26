import React from "react";
import { ArrowClockwise, CheckCircle, CircleNotch, DeviceMobile, DeviceTablet, Hammer, Stack, Watch } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type {
  AppleRuntimeDeleteResult,
  AppleRuntimeEntry,
  AppleRuntimeSimulatorDisposition,
  XcodeDerivedDataEntry,
} from "../../../../shared/types/iosSimulator";
import { formatStorageBytes, pluralCount } from "../../../../shared/formatting";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { confirmRemoval, XCODE_APP_STORE_URL } from "../../apple/AppleRuntimesSection";
import { readRuntimesUntilGone, showCleanupResult, showRuntimeRemoval } from "../../apple/appleStorageNotices";
import { ModernSection } from "../primitives";
import { DevToolsSpaceBar, readyTotal, type SpaceSegment } from "./DevToolsSpaceBar";
import { DevToolRow, DevToolsListSection, LIST_PREVIEW, ListSkeleton, PartError, RowAction, ShowAll, SizeCell, useDevToolHues } from "./devToolsList";
import { captureDevToolsCleanup } from "./devToolsAnalytics";
import { devToolsSizes, type DevToolsStorage, type SimulatorRow } from "./useDevToolsStorage";

/**
 * Settings › Apple devices, the machine's half: the Xcode it has, what
 * simulators, runtimes and Xcode's build data cost on its disk, and the safe
 * way to remove each. Every call carries `pin`, the machine the page is on.
 *
 * Deleting is always the person's, confirmed by name and size; the brain
 * refuses a delete that was not confirmed, and refuses one an agent asks for.
 */

const GROUP = "Apple Development";
/** Build data untouched this long is offered as one cleanup. */
const STALE_BUILD_DATA_DAYS = 30;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** "Used today", "Used 12 days ago", "Used 3 months ago". */
function usedWhen(iso: string | null | undefined): string | null {
  const days = daysSince(iso);
  if (days == null) return null;
  if (days === 0) return "Used today";
  if (days === 1) return "Used yesterday";
  if (days < 60) return `Used ${days} days ago`;
  return `Used ${Math.round(days / 30)} months ago`;
}

/** `/Users/ada/code/x` → `~/code/x`: the home folder says nothing a person needs. */
function homeRelative(path: string | null): string | null {
  return path ? path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~") : null;
}

const formatMac = (value: number) => formatStorageBytes(value, "mac");

export function AppleToolsSection({
  storage,
  pin,
  machineName,
}: {
  storage: DevToolsStorage;
  pin: OpenProjectBinding | null;
  /** "this Mac" or the machine's name. */
  machineName: string;
}) {
  const hues = useDevToolHues();
  const sizes = devToolsSizes(storage);
  const scrollTo = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const segments: SpaceSegment[] = [
    { key: "simulators", label: "Simulators", size: sizes.simulators, hue: hues.simulators, onSelect: () => scrollTo("apple-simulators") },
    { key: "runtimes", label: "Runtimes", size: sizes.runtimes, hue: hues.runtimes, onSelect: () => scrollTo("apple-runtimes") },
    { key: "build", label: "Build data", size: sizes.buildData, hue: hues.buildData, onSelect: () => scrollTo("apple-build-data") },
  ];
  const total = readyTotal(segments);
  const measuring = segments.some((segment) => segment.size.state === "measuring");
  const freeBytes = storage.runtimes.data?.freeBytes ?? null;

  return (
    <>
      <ModernSection
        group={GROUP}
        anchor="apple-xcode"
        title="Xcode"
        hint={`The Xcode simulators and builds use on ${machineName}.`}
        actions={
          <button type="button" className="kit-icon-btn" aria-label="Check again" title="Check again" onClick={storage.refreshApple}>
            <ArrowClockwise size={13} className={storage.runtimes.loading ? "animate-spin" : undefined} />
          </button>
        }
      >
        <XcodeCard storage={storage} pin={pin} />
      </ModernSection>

      <ModernSection
        group={GROUP}
        anchor="apple-space"
        title="Space"
        hint="What simulators and Xcode builds keep on the disk, outside your projects. Build data and runtimes come back when they are needed; a deleted simulator takes its apps and data with it."
      >
        <div className="ade-dev-card">
          <DevToolsSpaceBar
            format={formatMac}
            segments={segments}
            headline={total != null
              ? <>Simulators and Xcode use <strong>{formatMac(total)}</strong> on {machineName}</>
              : measuring
                ? <>Measuring what simulators and Xcode use on {machineName}…</>
                : <>Some sizes on {machineName} couldn't be read. <button type="button" className="ade-dev-inline-link" onClick={storage.refreshApple}>Try again</button></>}
            footnote={freeBytes != null ? `${formatMac(freeBytes)} free on the disk` : undefined}
          />
        </div>
      </ModernSection>

      <SimulatorsBlock storage={storage} pin={pin} />
      <RuntimesBlock storage={storage} pin={pin} />
      <BuildDataBlock storage={storage} pin={pin} />
    </>
  );
}

/* ── Xcode ───────────────────────────────────────────────────────────── */

function XcodeCard({ storage, pin }: { storage: DevToolsStorage; pin: OpenProjectBinding | null }) {
  const { data, loading, error } = storage.runtimes;
  const [settingUp, setSettingUp] = React.useState(false);
  if (loading && !data) return <div className="ade-dev-card ade-dev-xcode" aria-busy="true"><span className="ade-dev-shimmer" /></div>;
  if (error && !data) return <PartError id="apple-xcode-read" title="Couldn't read Xcode" error={error} onRetry={storage.refreshApple} />;
  const xcode = data?.xcode ?? null;
  if (!xcode?.version) {
    return (
      <div className="ade-dev-card ade-dev-xcode" data-state="missing">
        <span className="ade-dev-xcode-glyph" aria-hidden><Hammer size={22} weight="duotone" /></span>
        <div className="ade-dev-xcode-text">
          <div className="ade-dev-xcode-title">Xcode isn't installed</div>
          <div className="ade-dev-xcode-sub">Simulators and iOS builds need it. It comes from the Mac App Store.</div>
        </div>
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => openExternalUrl(XCODE_APP_STORE_URL)}>Get Xcode</button>
      </div>
    );
  }
  const runFirstLaunch = async () => {
    setSettingUp(true);
    try {
      await window.ade.iosSimulator.xcodeRunFirstLaunch({ confirmedByUser: true }, pin);
      showToast({ id: "apple-xcode-first-launch", tone: "success", title: "Xcode is set up" });
      storage.refreshApple();
    } catch (err) {
      showToast({ id: "apple-xcode-first-launch", tone: "error", title: "Couldn't finish Xcode's setup", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSettingUp(false);
    }
  };
  const latest = xcode.updateAvailable ? xcode.latest : null;
  const status = xcode.firstLaunchPending
    ? { tone: "warn", text: "Setup not finished" }
    : latest
      ? { tone: "info", text: `${latest.version} is out` }
      : { tone: "ok", text: "Up to date" };
  return (
    <div className="ade-dev-card ade-dev-xcode">
      <span className="ade-dev-xcode-glyph" aria-hidden><Hammer size={22} weight="duotone" /></span>
      <div className="ade-dev-xcode-text">
        <div className="ade-dev-xcode-title">
          Xcode {xcode.version}
          {xcode.build ? <span className="ade-dev-xcode-build">{xcode.build}</span> : null}
          <span className="ade-dev-chip" data-tone={status.tone}>
            {status.tone === "ok" ? <CheckCircle size={11} weight="fill" aria-hidden /> : null}
            {status.text}
          </span>
        </div>
        <dl className="ade-dev-xcode-paths">
          {xcode.appPath ? (<><dt>App</dt><dd title={xcode.appPath}>{xcode.appPath}</dd></>) : null}
          {xcode.developerDir ? (<><dt>Tools</dt><dd title={xcode.developerDir}>{xcode.developerDir}</dd></>) : null}
        </dl>
      </div>
      {xcode.firstLaunchPending ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={settingUp} onClick={() => void runFirstLaunch()}>
          {settingUp ? <CircleNotch size={12} className="animate-spin" /> : null}
          Finish setup
        </button>
      ) : latest ? (
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => openExternalUrl(latest.url || XCODE_APP_STORE_URL)}>
          Get {latest.version}
        </button>
      ) : null}
    </div>
  );
}

/* ── Simulators ──────────────────────────────────────────────────────── */

function familyGlyph(row: SimulatorRow) {
  if (row.sim.family === "ipad") return <DeviceTablet size={16} />;
  if (row.sim.family === "watch") return <Watch size={16} />;
  return <DeviceMobile size={16} />;
}

function SimulatorsBlock({ storage, pin }: { storage: DevToolsStorage; pin: OpenProjectBinding | null }) {
  const { data, loading, error, measuring } = storage.simulators;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const rows = data ?? [];
  const leftovers = rows.filter((row) => row.ownership === "ade-orphan");

  const remove = async (row: SimulatorRow) => {
    const size = row.bytes != null ? formatMac(row.bytes) : null;
    const ok = await confirmDialog({
      title: `Delete ${row.sim.name}?`,
      message: `${row.sim.runtime}${size ? ` · ${size}` : ""}. Its apps and data go with it. You can make a new one any time.`,
      confirmLabel: size ? `Delete · free ${size}` : "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(row.sim.udid);
    try {
      await window.ade.iosSimulator.deviceDeleteInstalled({ udid: row.sim.udid, confirmedByUser: true }, pin);
      captureDevToolsCleanup("simulator_deleted", "completed", row.bytes);
      showToast({ id: "apple-settings-sim-delete", tone: "success", title: `Deleted ${row.sim.name}`, ...(size ? { message: `Freed ${size}.` } : {}) });
    } catch (err) {
      captureDevToolsCleanup("simulator_deleted", "failed");
      showToast({ id: "apple-settings-sim-delete", tone: "error", title: `Couldn't delete ${row.sim.name}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const cleanUp = async () => {
    setBusy("cleanup");
    try {
      showCleanupResult(await window.ade.iosSimulator.deviceCleanup({ powerOffIdle: true }, pin), "apple-settings-cleanup");
    } catch (err) {
      showToast({ id: "apple-settings-cleanup", tone: "error", title: "Couldn't clean up simulators", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const shown = open ? rows : rows.slice(0, LIST_PREVIEW);
  return (
    <DevToolsListSection
      group={GROUP}
      anchor="apple-simulators"
      title="Simulators"
      count={data ? rows.length : null}
      hint="Biggest first. A simulator a lane uses is deleted from that lane; ADE deletes the ones it made when their lane ends."
      actions={leftovers.length > 0 ? (
        <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy != null} onClick={() => void cleanUp()}>
          {busy === "cleanup" ? <CircleNotch size={12} className="animate-spin" /> : null}
          Clean up {pluralCount(leftovers.length, "leftover")}
        </button>
      ) : undefined}
    >
      {error && !data ? <PartError id="apple-settings-sims" title="Couldn't read the simulators" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {data && rows.length === 0 ? <div className="ade-dev-empty">No simulators on this Mac. Start one from a lane's Apple pane.</div> : null}
      {rows.length > 0 ? (
        <>
          <ul className="ade-dev-list" aria-label="Simulators">
            {shown.map((row) => (
              <DevToolRow
                key={row.sim.udid}
                glyph={familyGlyph(row)}
                title={row.sim.name}
                chips={row.sim.state.toLowerCase() === "booted" ? <span className="ade-dev-chip" data-tone="ok">Running</span> : null}
                sub={<>{row.sim.runtime}<span className="ade-dev-owner" data-owner={row.laneHeld ? "lane" : row.ownership ?? "yours"}>{row.owner}</span></>}
                size={<SizeCell value={row.bytes} measuring={measuring} format={formatMac} />}
                action={<RowAction label="Delete" ariaLabel={`Delete ${row.sim.name}`} busy={busy === row.sim.udid} disabled={busy != null} blockedWhy={row.deleteBlocked} onClick={() => void remove(row)} />}
              />
            ))}
          </ul>
          <ShowAll total={rows.length} open={open} onToggle={() => setOpen((value) => !value)} />
        </>
      ) : null}
    </DevToolsListSection>
  );
}

/* ── Runtimes ────────────────────────────────────────────────────────── */

function runtimeSub(entry: AppleRuntimeEntry): string {
  const simulators = entry.simulators.length ? pluralCount(entry.simulators.length, "simulator") : "No simulators";
  return [simulators, usedWhen(entry.lastUsedAt)].filter(Boolean).join(" · ");
}

function RuntimesBlock({ storage, pin }: { storage: DevToolsStorage; pin: OpenProjectBinding | null }) {
  const { data, loading, error } = storage.runtimes;
  const [busy, setBusy] = React.useState(false);
  const runtimes = data?.runtimes ?? [];
  const leftovers = data?.leftovers ?? [];
  const replaceable = runtimes.filter((entry) => entry.superseded && entry.deletable && entry.id);
  const replaceableBytes = replaceable.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const leftoverBytes = leftovers.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const them = leftovers.length === 1 ? "it" : "them";

  const run = async (
    work: (disposition: AppleRuntimeSimulatorDisposition) => Promise<AppleRuntimeDeleteResult>,
    entries: AppleRuntimeEntry[],
    title: string,
  ) => {
    const disposition = await confirmRemoval({ title, entries, all: runtimes });
    if (!disposition) return;
    setBusy(true);
    try {
      const result = await work(disposition);
      showRuntimeRemoval(result);
      captureDevToolsCleanup("runtime_removed", result.errors.length ? "failed" : "completed", result.deleted.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0));
      // CoreSimulator drops a removed runtime a moment later; read until it is gone.
      await readRuntimesUntilGone(result.deleted.map((entry) => entry.id), pin).catch(() => null);
    } catch (err) {
      captureDevToolsCleanup("runtime_removed", "failed");
      showToast({ id: "apple-runtime-remove", tone: "error", title: "The runtime was not removed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      storage.refreshApple();
    }
  };

  return (
    <DevToolsListSection
      group={GROUP}
      anchor="apple-runtimes"
      title="Runtimes"
      count={data ? runtimes.length : null}
      hint="The iOS versions simulators run. Removing one moves its simulators to a newer version, or erases them if you choose."
      actions={replaceable.length > 0 ? (
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          disabled={busy}
          onClick={() => void run((simulators) => window.ade.iosSimulator.runtimePrune({ simulators, confirmedByUser: true }, pin), replaceable, `Remove ${pluralCount(replaceable.length, "replaced runtime")}?`)}
        >
          {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
          Remove replaced{replaceableBytes ? ` · ${formatMac(replaceableBytes)}` : ""}
        </button>
      ) : undefined}
    >
      {error && !data ? <PartError id="apple-settings-runtimes" title="Couldn't read the runtimes" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <ListSkeleton rows={2} /> : null}
      {data && runtimes.length === 0 ? <div className="ade-dev-empty">No simulator runtimes yet. A lane's Apple pane installs the one Xcode needs.</div> : null}
      {runtimes.length > 0 ? (
        <ul className="ade-dev-list" aria-label="Runtimes">
          {runtimes.map((entry) => {
            const id = entry.deletable ? entry.id : null;
            return (
              <DevToolRow
                key={entry.runtimeIdentifier}
                glyph={<Stack size={16} />}
                title={entry.name}
                chips={entry.newest ? <span className="ade-dev-chip">Newest</span> : entry.superseded ? <span className="ade-dev-chip" data-tone="muted">Replaced</span> : null}
                sub={runtimeSub(entry)}
                size={<SizeCell value={entry.sizeBytes} format={formatMac} />}
                action={(
                  <RowAction
                    label="Remove"
                    ariaLabel={`Remove ${entry.name}`}
                    disabled={busy}
                    blockedWhy={id ? null : "macOS manages this runtime"}
                    onClick={() => {
                      if (id) void run((simulators) => window.ade.iosSimulator.runtimeDelete({ id, simulators, confirmedByUser: true }, pin), [entry], `Remove ${entry.name}?`);
                    }}
                  />
                )}
              />
            );
          })}
        </ul>
      ) : null}
      {leftovers.length > 0 ? (
        <div className="ade-dev-note">
          {pluralCount(leftovers.length, "old runtime download is", "old runtime downloads are")} still on the disk
          {leftoverBytes ? ` (${formatMac(leftoverBytes)})` : ""}. macOS protects {them}: restart the Mac, then remove {them} in Xcode › Settings › Components.
        </div>
      ) : null}
    </DevToolsListSection>
  );
}

/* ── Xcode build data ────────────────────────────────────────────────── */

function buildDataSub(entry: XcodeDerivedDataEntry): string {
  if (entry.kind === "module-cache") return "Shared by every project";
  return [usedWhen(entry.lastUsedAt), homeRelative(entry.workspacePath)].filter(Boolean).join(" · ");
}

function BuildDataBlock({ storage, pin }: { storage: DevToolsStorage; pin: OpenProjectBinding | null }) {
  const { data, loading, error } = storage.buildData;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  // Biggest first, like every list on this page.
  const entries = React.useMemo(() => [...(data?.entries ?? [])].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1)), [data]);
  const blocked = data?.buildRunning === true;
  const blockedWhy = blocked ? "Quit Xcode and wait for builds to finish, then try again." : null;
  const stale = entries.filter((entry) => entry.kind === "project" && ((daysSince(entry.lastUsedAt) ?? 0) >= STALE_BUILD_DATA_DAYS || entry.workspaceMissing));
  const staleBytes = stale.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);

  const remove = async (targets: XcodeDerivedDataEntry[], title: string, key: string) => {
    const freed = targets.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    const ok = await confirmDialog({
      title,
      message: "Xcode builds it again the next time you build, so the first build after this is slower.",
      children: targets.length > 1 ? (
        <ul className="ade-dev-confirm-list">
          {targets.map((entry) => <li key={entry.path}>{entry.name}{entry.sizeBytes != null ? <span>{formatMac(entry.sizeBytes)}</span> : null}</li>)}
        </ul>
      ) : undefined,
      confirmLabel: freed ? `Delete · free ${formatMac(freed)}` : "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(key);
    try {
      const result = await window.ade.iosSimulator.derivedDataDelete({ paths: targets.map((entry) => entry.path), confirmedByUser: true }, pin);
      const failed = result.errors.length > 0;
      captureDevToolsCleanup("build_data_deleted", failed && !result.deleted.length ? "failed" : "completed", result.freedBytes);
      const freedWords = `${result.freedIsLowerBound ? "at least " : ""}${formatMac(result.freedBytes)}`;
      showToast({
        id: "apple-settings-build-data",
        tone: failed ? (result.deleted.length ? "warning" : "error") : "success",
        title: failed && !result.deleted.length ? "Build data was not deleted" : `Freed ${freedWords}`,
        ...(failed ? { message: result.errors[0]!.message } : {}),
      });
    } catch (err) {
      captureDevToolsCleanup("build_data_deleted", "failed");
      showToast({ id: "apple-settings-build-data", tone: "error", title: "Build data was not deleted", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const shown = open ? entries : entries.slice(0, LIST_PREVIEW);
  return (
    <DevToolsListSection
      group={GROUP}
      anchor="apple-build-data"
      title="Xcode build data"
      count={data?.supported ? entries.length : null}
      hint="DerivedData: what Xcode keeps per project to build faster. Safe to delete; it is rebuilt."
      actions={stale.length > 0 ? (
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          disabled={busy != null || blocked}
          title={blockedWhy ?? undefined}
          onClick={() => void remove(stale, `Delete build data for ${pluralCount(stale.length, "project")}?`, "stale")}
        >
          {busy === "stale" ? <CircleNotch size={12} className="animate-spin" /> : null}
          Delete unused{staleBytes ? ` · ${formatMac(staleBytes)}` : ""}
        </button>
      ) : undefined}
    >
      {error && !data ? <PartError id="apple-settings-build-data-read" title="Couldn't read Xcode build data" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <ListSkeleton /> : null}
      {blocked ? (
        <Banner
          layout="inline"
          model={{ id: "apple-build-data-busy", tone: "warning", title: "Xcode is open or building", detail: "Build data can't be deleted while a build may be writing to it. Quit Xcode, then check again.", actions: [{ label: "Check again", onClick: storage.refreshApple }] }}
        />
      ) : null}
      {data && (!data.exists || entries.length === 0) ? <div className="ade-dev-empty">No build data. Xcode makes it the first time it builds a project.</div> : null}
      {entries.length > 0 ? (
        <>
          <ul className="ade-dev-list" aria-label="Xcode build data">
            {shown.map((entry) => (
              <DevToolRow
                key={entry.path}
                glyph={<Hammer size={16} />}
                title={entry.name}
                chips={entry.workspaceMissing ? <span className="ade-dev-chip" data-tone="muted">Project gone</span> : null}
                sub={buildDataSub(entry)}
                subTitle={entry.workspacePath ?? entry.path}
                size={<SizeCell value={entry.sizeBytes} measuring={loading} format={formatMac} />}
                action={<RowAction label="Delete" ariaLabel={`Delete build data: ${entry.name}`} busy={busy === entry.path} disabled={busy != null} blockedWhy={blockedWhy} onClick={() => void remove([entry], `Delete ${entry.name}'s build data?`, entry.path)} />}
              />
            ))}
          </ul>
          <ShowAll total={entries.length} open={open} onToggle={() => setOpen((value) => !value)} />
        </>
      ) : null}
    </DevToolsListSection>
  );
}
