import React from "react";
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  CircleNotch,
  DeviceMobile,
  DeviceTablet,
  Hammer,
  Stack,
  Watch,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AppleRuntimeEntry, AppleRuntimeSimulatorDisposition, XcodeDerivedDataEntry } from "../../../../shared/types/iosSimulator";
import { formatStorageBytes, pluralCount } from "../../../../shared/formatting";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { confirmRemoval } from "../../apple/AppleRuntimesSection";
import { CLEANUP_SKIP_REASON, cleanupNotice, showRuntimeRemoval } from "../../apple/appleStorageNotices";
import { ModernSection } from "../primitives";
import { DevToolsSpaceBar } from "./DevToolsSpaceBar";
import { devToolsTotals, type DevToolsStorage, type SimulatorRow } from "./useDevToolsStorage";
import "./devTools.css";

/**
 * Settings › Apple devices, the machine's half: the Xcode it has, what
 * simulators, runtimes and Xcode's build data cost on its disk, and the safe
 * way to remove each. Every call carries `pin`, the machine the page is on.
 *
 * Deleting is always the person's, confirmed by name and size; the brain
 * refuses a delete that was not confirmed, and refuses one an agent asks for.
 */

const XCODE_APP_STORE_URL = "https://apps.apple.com/app/xcode/id497799835";
/** Build data untouched this long is offered as one cleanup. */
const STALE_BUILD_DATA_DAYS = 30;
/** Rows shown before "Show all". */
const LIST_PREVIEW = 6;

export const DEV_TOOL_HUES = {
  simulators: "#4aa8e0",
  runtimes: "#8b7bf0",
  buildData: "#e0a44a",
  emulators: "#43b3a0",
} as const;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** "Used today", "Used 12 days ago", "Used 3 months ago". */
export function usedWhen(iso: string | null | undefined): string | null {
  const days = daysSince(iso);
  if (days == null) return null;
  if (days === 0) return "Used today";
  if (days === 1) return "Used yesterday";
  if (days < 60) return `Used ${days} days ago`;
  return `Used ${Math.round(days / 30)} months ago`;
}

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
  const bytes = (value: number) => formatStorageBytes(value, "mac");
  const totals = devToolsTotals(storage);
  const scrollTo = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const parts = [totals.simulators, totals.runtimes, totals.buildData];
  const known = parts.every((value) => value != null);
  const sum = parts.reduce<number>((total, value) => total + (value ?? 0), 0);
  const xcode = storage.runtimes.data?.xcode ?? null;
  const freeBytes = storage.runtimes.data?.freeBytes ?? null;

  return (
    <>
      <ModernSection
        group="Apple Development"
        anchor="apple-xcode"
        title="Xcode"
        hint={`The Xcode simulators and builds use on ${machineName}.`}
        actions={
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Check again"
            title="Check again"
            onClick={storage.refreshApple}
          >
            <ArrowClockwise size={13} className={storage.runtimes.loading ? "animate-spin" : undefined} />
          </button>
        }
      >
        <XcodeCard storage={storage} pin={pin} />
      </ModernSection>

      <ModernSection
        group="Apple Development"
        anchor="apple-space"
        title="Space"
        hint="What simulators and Xcode builds keep on the disk, outside your projects. Everything here is rebuilt or downloaded again when it is needed."
      >
        <div className="ade-dev-card">
          <DevToolsSpaceBar
            format={bytes}
            headline={known
              ? <>Simulators and Xcode use <strong>{bytes(sum)}</strong> on {machineName}</>
              : <>Measuring what simulators and Xcode use on {machineName}…</>}
            footnote={freeBytes != null ? `${bytes(freeBytes)} free on the disk` : undefined}
            segments={[
              { key: "simulators", label: "Simulators", bytes: totals.simulators, measuring: storage.simulators.measuring, hue: DEV_TOOL_HUES.simulators, onSelect: () => scrollTo("apple-simulators") },
              { key: "runtimes", label: "Runtimes", bytes: totals.runtimes, measuring: storage.runtimes.loading, hue: DEV_TOOL_HUES.runtimes, onSelect: () => scrollTo("apple-runtimes") },
              { key: "build", label: "Build data", bytes: totals.buildData, measuring: storage.buildData.loading, hue: DEV_TOOL_HUES.buildData, onSelect: () => scrollTo("apple-build-data") },
            ]}
          />
        </div>
      </ModernSection>

      <SimulatorsBlock storage={storage} pin={pin} bytes={bytes} />
      <RuntimesBlock storage={storage} pin={pin} bytes={bytes} />
      <BuildDataBlock storage={storage} pin={pin} bytes={bytes} buildRunningHint={xcode?.version ? "Quit Xcode" : "Wait for builds to finish"} />
    </>
  );
}

/* ── Xcode ───────────────────────────────────────────────────────────── */

function XcodeCard({ storage, pin }: { storage: DevToolsStorage; pin: OpenProjectBinding | null }) {
  const { data, loading, error } = storage.runtimes;
  const [settingUp, setSettingUp] = React.useState(false);
  if (loading && !data) return <div className="ade-dev-card ade-dev-xcode" aria-busy="true"><span className="ade-dev-shimmer" /></div>;
  if (error && !data) {
    return (
      <Banner
        layout="inline"
        model={{ id: "apple-xcode-read", tone: "warning", title: "Couldn't read Xcode", detail: error, actions: [{ label: "Try again", onClick: storage.refreshApple }] }}
      />
    );
  }
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
  const status = xcode.firstLaunchPending
    ? { tone: "warn", text: "Setup not finished" }
    : xcode.updateAvailable && xcode.latest
      ? { tone: "info", text: `${xcode.latest.version} is out` }
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
      ) : xcode.updateAvailable && xcode.latest ? (
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => openExternalUrl(xcode.latest?.url || XCODE_APP_STORE_URL)}>
          Get {xcode.latest.version}
        </button>
      ) : null}
    </div>
  );
}

/* ── Shared list pieces ──────────────────────────────────────────────── */

function ListShell({
  anchor,
  title,
  hint,
  count,
  actions,
  children,
}: {
  anchor: string;
  title: string;
  hint: string;
  count?: number | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ModernSection group="Apple Development" anchor={anchor} title={count != null ? `${title} · ${count}` : title} hint={hint} actions={actions}>
      {children}
    </ModernSection>
  );
}

function ShowAll({ total, open, onToggle }: { total: number; open: boolean; onToggle: () => void }) {
  if (total <= LIST_PREVIEW) return null;
  return (
    <button type="button" className="ade-dev-showall" aria-expanded={open} onClick={onToggle}>
      <CaretDown size={11} weight="bold" className="ade-dev-showall-caret" aria-hidden />
      {open ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

function SizeCell({ value, measuring, bytes }: { value: number | null; measuring?: boolean; bytes: (value: number) => string }) {
  if (value != null) return <span className="ade-dev-size">{bytes(value)}</span>;
  return <span className="ade-dev-size" data-pending="true">{measuring ? "Measuring…" : "—"}</span>;
}

function PartError({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return <Banner layout="inline" model={{ id: `dev-${title}`, tone: "warning", title, detail: error, actions: [{ label: "Try again", onClick: onRetry }] }} />;
}

function Skeleton() {
  return (
    <div className="ade-dev-list" aria-busy="true">
      {[0, 1, 2].map((index) => <div key={index} className="ade-dev-row"><span className="ade-dev-shimmer" /></div>)}
    </div>
  );
}

/* ── Simulators ──────────────────────────────────────────────────────── */

function familyGlyph(row: SimulatorRow) {
  if (row.sim.family === "ipad") return <DeviceTablet size={16} />;
  if (row.sim.family === "watch") return <Watch size={16} />;
  return <DeviceMobile size={16} />;
}

function SimulatorsBlock({ storage, pin, bytes }: { storage: DevToolsStorage; pin: OpenProjectBinding | null; bytes: (value: number) => string }) {
  const { data, loading, error, measuring } = storage.simulators;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const rows = data ?? [];
  const leftovers = rows.filter((row) => row.ownership === "ade-orphan");

  const remove = async (row: SimulatorRow) => {
    const size = row.bytes != null ? bytes(row.bytes) : null;
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
      showToast({ id: "apple-settings-sim-delete", tone: "success", title: `Deleted ${row.sim.name}`, ...(size ? { message: `Freed ${size}.` } : {}) });
    } catch (err) {
      showToast({ id: "apple-settings-sim-delete", tone: "error", title: `Couldn't delete ${row.sim.name}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const cleanUp = async () => {
    setBusy("cleanup");
    try {
      const result = await window.ade.iosSimulator.deviceCleanup({ powerOffIdle: true }, pin);
      const parts = [
        result.deleted.length ? `deleted ${result.deleted.length}` : null,
        result.poweredOff.length ? `powered off ${result.poweredOff.length}` : null,
      ].filter(Boolean);
      const notice = cleanupNotice({
        listUnreadable: result.errors.some((entry) => entry.udid === null),
        deviceErrors: result.errors.filter((entry) => entry.udid !== null).length,
        summary: parts.length ? `Cleaned up simulators: ${parts.join(", ")}` : null,
      });
      const skipped = result.powerOffSkipped ? CLEANUP_SKIP_REASON[result.powerOffSkipped] : null;
      const text = [notice.message, skipped].filter(Boolean).join(" ");
      showToast({ id: "apple-settings-cleanup", tone: notice.tone, title: notice.title, ...(text ? { message: text } : {}) });
    } catch (err) {
      showToast({ id: "apple-settings-cleanup", tone: "error", title: "Couldn't clean up simulators", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const shown = open ? rows : rows.slice(0, LIST_PREVIEW);
  return (
    <ListShell
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
      {error && !data ? <PartError title="Couldn't read the simulators" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <Skeleton /> : null}
      {data && rows.length === 0 ? <div className="ade-dev-empty">No simulators on this Mac. Start one from a lane's Apple pane.</div> : null}
      {rows.length > 0 ? (
        <>
          <ul className="ade-dev-list" aria-label="Simulators">
            {shown.map((row) => (
              <li key={row.sim.udid} className="ade-dev-row">
                <span className="ade-dev-row-glyph" aria-hidden>{familyGlyph(row)}</span>
                <span className="ade-dev-row-text">
                  <span className="ade-dev-row-title">
                    {row.sim.name}
                    {row.sim.state.toLowerCase() === "booted" ? <span className="ade-dev-chip" data-tone="ok">Running</span> : null}
                  </span>
                  <span className="ade-dev-row-sub">
                    {row.sim.runtime}
                    <span className="ade-dev-owner" data-owner={row.laneHeld ? "lane" : row.ownership ?? "yours"}>{row.owner}</span>
                  </span>
                </span>
                <SizeCell value={row.bytes} measuring={measuring} bytes={bytes} />
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy != null || row.deleteBlocked != null}
                  title={row.deleteBlocked ?? `Delete ${row.sim.name}`}
                  aria-label={`Delete ${row.sim.name}`}
                  onClick={() => void remove(row)}
                >
                  {busy === row.sim.udid ? <CircleNotch size={12} className="animate-spin" /> : null}
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <ShowAll total={rows.length} open={open} onToggle={() => setOpen((value) => !value)} />
        </>
      ) : null}
    </ListShell>
  );
}

/* ── Runtimes ────────────────────────────────────────────────────────── */

function runtimeSub(entry: AppleRuntimeEntry): string {
  const simulators = entry.simulators.length ? pluralCount(entry.simulators.length, "simulator") : "No simulators";
  return [simulators, usedWhen(entry.lastUsedAt)].filter(Boolean).join(" · ");
}

function RuntimesBlock({ storage, pin, bytes }: { storage: DevToolsStorage; pin: OpenProjectBinding | null; bytes: (value: number) => string }) {
  const { data, loading, error } = storage.runtimes;
  const [busy, setBusy] = React.useState(false);
  const runtimes = data?.runtimes ?? [];
  const leftovers = data?.leftovers ?? [];
  const replaceable = runtimes.filter((entry) => entry.superseded && entry.deletable && entry.id);
  const replaceableBytes = replaceable.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);

  const run = async (work: (disposition: AppleRuntimeSimulatorDisposition) => Promise<Awaited<ReturnType<typeof window.ade.iosSimulator.runtimeDelete>>>, entries: AppleRuntimeEntry[], title: string) => {
    const disposition = await confirmRemoval({ title, entries, all: runtimes });
    if (!disposition) return;
    setBusy(true);
    try {
      showRuntimeRemoval(await work(disposition));
    } catch (err) {
      showToast({ id: "apple-runtime-remove", tone: "error", title: "The runtime was not removed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      storage.refreshApple();
    }
  };

  return (
    <ListShell
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
          Remove replaced{replaceableBytes ? ` · ${bytes(replaceableBytes)}` : ""}
        </button>
      ) : undefined}
    >
      {error && !data ? <PartError title="Couldn't read the runtimes" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <Skeleton /> : null}
      {data && runtimes.length === 0 ? <div className="ade-dev-empty">No simulator runtimes yet. A lane's Apple pane installs the one Xcode needs.</div> : null}
      {runtimes.length > 0 ? (
        <ul className="ade-dev-list" aria-label="Runtimes">
          {runtimes.map((entry) => (
            <li key={entry.runtimeIdentifier} className="ade-dev-row">
              <span className="ade-dev-row-glyph" aria-hidden><Stack size={16} /></span>
              <span className="ade-dev-row-text">
                <span className="ade-dev-row-title">
                  {entry.name}
                  {entry.newest ? <span className="ade-dev-chip">Newest</span> : entry.superseded ? <span className="ade-dev-chip" data-tone="muted">Replaced</span> : null}
                </span>
                <span className="ade-dev-row-sub">{runtimeSub(entry)}</span>
              </span>
              <SizeCell value={entry.sizeBytes} bytes={bytes} />
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                data-variant="ghost"
                disabled={busy || !entry.deletable || !entry.id}
                title={entry.deletable && entry.id ? `Remove ${entry.name}` : "macOS manages this runtime"}
                aria-label={`Remove ${entry.name}`}
                onClick={() => void run((simulators) => window.ade.iosSimulator.runtimeDelete({ id: entry.id!, simulators, confirmedByUser: true }, pin), [entry], `Remove ${entry.name}?`)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {leftovers.length > 0 ? (
        <div className="ade-dev-note">
          {pluralCount(leftovers.length, "old runtime download is", "old runtime downloads are")} still on the disk
          {leftovers.some((entry) => entry.sizeBytes != null) ? ` (${bytes(leftovers.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0))})` : ""}
          . macOS protects {leftovers.length === 1 ? "it" : "them"}: restart the Mac, then remove {leftovers.length === 1 ? "it" : "them"} in Xcode › Settings › Components.
        </div>
      ) : null}
    </ListShell>
  );
}

/* ── Xcode build data ────────────────────────────────────────────────── */

/** `/Users/ada/code/x` → `~/code/x`: the home folder says nothing a person needs. */
function homeRelative(path: string | null): string | null {
  return path ? path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~") : null;
}

function buildDataSub(entry: XcodeDerivedDataEntry): string {
  if (entry.kind === "module-cache") return "Shared by every project";
  return [usedWhen(entry.lastUsedAt), homeRelative(entry.workspacePath)].filter(Boolean).join(" · ");
}

function BuildDataBlock({
  storage,
  pin,
  bytes,
  buildRunningHint,
}: {
  storage: DevToolsStorage;
  pin: OpenProjectBinding | null;
  bytes: (value: number) => string;
  buildRunningHint: string;
}) {
  const { data, loading, error } = storage.buildData;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  // Biggest first, like every list on this page.
  const entries = React.useMemo(() => [...(data?.entries ?? [])].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1)), [data]);
  const blocked = data?.buildRunning === true;
  const stale = entries.filter((entry) => entry.kind === "project" && ((daysSince(entry.lastUsedAt) ?? 0) >= STALE_BUILD_DATA_DAYS || entry.workspaceMissing));
  const staleBytes = stale.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);

  const remove = async (targets: XcodeDerivedDataEntry[], title: string, key: string) => {
    const freed = targets.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    const ok = await confirmDialog({
      title,
      message: "Xcode builds it again the next time you build, so the first build after this is slower.",
      children: targets.length > 1 ? (
        <ul className="ade-dev-confirm-list">
          {targets.map((entry) => <li key={entry.path}>{entry.name}{entry.sizeBytes != null ? <span>{bytes(entry.sizeBytes)}</span> : null}</li>)}
        </ul>
      ) : undefined,
      confirmLabel: freed ? `Delete · free ${bytes(freed)}` : "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(key);
    try {
      const result = await window.ade.iosSimulator.derivedDataDelete({ paths: targets.map((entry) => entry.path), confirmedByUser: true }, pin);
      const failed = result.errors.length > 0;
      showToast({
        id: "apple-settings-build-data",
        tone: failed ? (result.deleted.length ? "warning" : "error") : "success",
        title: failed && !result.deleted.length ? "Build data was not deleted" : `Freed ${bytes(result.freedBytes)}`,
        ...(failed ? { message: result.errors[0]!.message } : {}),
      });
    } catch (err) {
      showToast({ id: "apple-settings-build-data", tone: "error", title: "Build data was not deleted", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      storage.refreshApple();
    }
  };

  const shown = open ? entries : entries.slice(0, LIST_PREVIEW);
  return (
    <ListShell
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
          title={blocked ? `${buildRunningHint}, then try again.` : undefined}
          onClick={() => void remove(stale, `Delete build data for ${pluralCount(stale.length, "project")}?`, "stale")}
        >
          {busy === "stale" ? <CircleNotch size={12} className="animate-spin" /> : null}
          Delete unused{staleBytes ? ` · ${bytes(staleBytes)}` : ""}
        </button>
      ) : undefined}
    >
      {error && !data ? <PartError title="Couldn't read Xcode build data" error={error} onRetry={storage.refreshApple} /> : null}
      {loading && !data ? <Skeleton /> : null}
      {blocked ? (
        <div className="ade-dev-note" data-tone="warn">Xcode is open or building, so build data can't be deleted right now. {buildRunningHint}, then check again.</div>
      ) : null}
      {data && (!data.exists || entries.length === 0) ? <div className="ade-dev-empty">No build data. Xcode makes it the first time it builds a project.</div> : null}
      {entries.length > 0 ? (
        <>
          <ul className="ade-dev-list" aria-label="Xcode build data">
            {shown.map((entry) => (
              <li key={entry.path} className="ade-dev-row">
                <span className="ade-dev-row-glyph" aria-hidden><Hammer size={16} /></span>
                <span className="ade-dev-row-text">
                  <span className="ade-dev-row-title">
                    {entry.name}
                    {entry.workspaceMissing ? <span className="ade-dev-chip" data-tone="muted">Project gone</span> : null}
                  </span>
                  <span className="ade-dev-row-sub" title={entry.workspacePath ?? entry.path}>{buildDataSub(entry)}</span>
                </span>
                <SizeCell value={entry.sizeBytes} measuring={loading} bytes={bytes} />
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy != null || blocked}
                  title={blocked ? `${buildRunningHint}, then try again.` : `Delete ${entry.name}'s build data`}
                  aria-label={`Delete build data: ${entry.name}`}
                  onClick={() => void remove([entry], `Delete ${entry.name}'s build data?`, entry.path)}
                >
                  {busy === entry.path ? <CircleNotch size={12} className="animate-spin" /> : null}
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <ShowAll total={entries.length} open={open} onToggle={() => setOpen((value) => !value)} />
        </>
      ) : null}
    </ListShell>
  );
}
