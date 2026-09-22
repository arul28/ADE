import { useEffect, useRef, useState } from "react";
import type {
  IosSimulatorLogRow,
  IosSimulatorPrivacyAction,
  IosSimulatorPrivacyService,
} from "../../../../../shared/types/iosSimulator";
import { IOS_SIMULATOR_PRIVACY_SERVICES } from "../../../../../shared/types/iosSimulator";
import { cn } from "../../../ui/cn";
import {
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  Row,
  Subhead,
  SubmitRow,
  SwitchRow,
} from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

/**
 * §B1's **App** group: everything that acts on the app in front, in the order
 * you reach for it — what is running, restart it, send it somewhere, install
 * something else, then its permissions, a push, and its log.
 *
 * Round 3 spread these across four sections (App, Permissions, Push
 * notification, Event log) that all keyed off the same one fact — the
 * foreground bundle id — and each repeated it. One card reads it once.
 */

const SERVICE_LABELS: Record<IosSimulatorPrivacyService, string> = {
  all: "All",
  calendar: "Calendar",
  "contacts-limited": "Contacts (limited)",
  contacts: "Contacts",
  location: "Location",
  "location-always": "Location (always)",
  "photos-add": "Photos (add only)",
  photos: "Photos",
  "media-library": "Media library",
  microphone: "Microphone",
  motion: "Motion",
  reminders: "Reminders",
  siri: "Siri",
};

export const APPLE_PERMISSION_OPTIONS = IOS_SIMULATOR_PRIVACY_SERVICES.map((service) => ({
  value: service,
  label: SERVICE_LABELS[service],
}));

export const APPLE_EVENT_LOG_LIMIT = 100;
const POLL_MS = 1000;

/** `HH:MM:SS` from an ISO timestamp; the raw text when it is not one. */
export function eventLogClock(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return at.slice(11, 19) || at;
  return time.toLocaleTimeString([], { hour12: false });
}

/** Append and cap at the newest hundred. */
export function appendEventLogRows(
  current: readonly IosSimulatorLogRow[],
  incoming: readonly IosSimulatorLogRow[],
): IosSimulatorLogRow[] {
  if (!incoming.length) return [...current];
  const merged = [...current, ...incoming];
  return merged.length > APPLE_EVENT_LOG_LIMIT ? merged.slice(-APPLE_EVENT_LOG_LIMIT) : merged;
}

export function AppSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions, foregroundApp, setForegroundApp } = ctx;
  const disabled = actions.disabled;
  const noApp = !foregroundApp;
  const [appId, setAppId] = useState("");
  // `photos`, not `camera`: `simctl privacy` has no camera service.
  const [service, setService] = useState<IosSimulatorPrivacyService>("photos");
  const bundleId = appId.trim() || foregroundApp || "";
  const decide = (action: IosSimulatorPrivacyAction) => {
    void actions.act(() => window.ade.iosSimulator.setPermission({
      ...scope,
      // `reset` applies device-wide without an app; grant/revoke need one.
      bundleId: bundleId || null,
      service,
      action,
    }, pinRef.current));
  };

  return (
    <>
      <Row label="Foreground">
        <span className="truncate font-mono text-xs text-fg/85" data-testid="apple-drawer-foreground">
          {foregroundApp ?? "—"}
        </span>
      </Row>
      <div className="flex min-h-7 items-center gap-1.5">
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled || noApp}
          onClick={() => {
            if (!foregroundApp) return;
            void actions.act(() => window.ade.iosSimulator.relaunchApp({ ...scope, bundleId: foregroundApp }, pinRef.current));
          }}
        >
          Relaunch
        </button>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled || noApp}
          onClick={() => {
            if (!foregroundApp) return;
            void actions.act(() => window.ade.iosSimulator.terminateApp({ ...scope, bundleId: foregroundApp }, pinRef.current));
          }}
        >
          Terminate
        </button>
      </div>
      <SubmitRow
        placeholder="https://… or myapp://"
        action="Open"
        disabled={disabled}
        onSubmit={(url) => actions.act(() => window.ade.iosSimulator.openUrl({ ...scope, url }, pinRef.current))}
      />
      <SubmitRow
        placeholder="Bundle ID"
        action="Launch"
        disabled={disabled}
        onSubmit={(nextBundleId) => actions
          .act(() => window.ade.iosSimulator.launch({
            laneId: scope.laneId,
            deviceUdid: scope.deviceUdid,
            bundleId: nextBundleId,
            build: false,
            mode: "live",
            openDrawer: false,
          }, pinRef.current))
          .then((accepted) => {
            if (accepted) setForegroundApp(nextBundleId);
            return accepted;
          })}
      />

      <Subhead label="Permissions" />
      <div className="flex min-h-7 items-center">
        <input
          className={cn(DRAWER_INPUT, "font-mono")}
          placeholder={foregroundApp ?? "App ID"}
          aria-label="App ID"
          value={appId}
          disabled={disabled}
          onChange={(event) => setAppId(event.target.value)}
        />
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        <DrawerMenu
          ariaLabel="Permission"
          value={service}
          placeholder="Permission"
          options={APPLE_PERMISSION_OPTIONS}
          disabled={disabled}
          onChange={setService}
        />
        <button type="button" className={DRAWER_PRIMARY_BUTTON} disabled={disabled || !bundleId} onClick={() => decide("grant")}>Grant</button>
        <button type="button" className={DRAWER_BUTTON} disabled={disabled || !bundleId} onClick={() => decide("revoke")}>Revoke</button>
        <button type="button" className={DRAWER_GHOST_BUTTON} disabled={disabled} onClick={() => decide("reset")}>Reset</button>
      </div>

      <Subhead label="Push notification" />
      <SubmitRow
        placeholder="Alert text"
        action="Send"
        mono={false}
        disabled={actions.disabled || !foregroundApp}
        onSubmit={(body) => (foregroundApp
          ? actions.act(() => window.ade.iosSimulator.sendPushNotification({ ...scope, bundleId: foregroundApp, body }, pinRef.current))
          : Promise.resolve(false))}
      />
      {!foregroundApp ? <p className="text-[11px] text-muted-fg/70">Open an app first.</p> : null}

      <Subhead label="Event log" />
      <EventLog ctx={ctx} />
    </>
  );
}

/**
 * The foreground app's log, streamed only while the switch is on.
 *
 * `log stream` needs a subsystem to scope to, which is the foreground bundle
 * id, and it is the most expensive thing in the drawer — so this subscribes on
 * the switch and unsubscribes with it, exactly as round 3's collapsible did.
 * The switch replaced the collapsible because the GROUP is the collapsible
 * now, and a disclosure inside a disclosure is one caret too many.
 */
function EventLog({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, visible, actions, foregroundApp } = ctx;
  const [on, setOn] = useState(false);
  const [rows, setRows] = useState<IosSimulatorLogRow[]>([]);
  const [running, setRunning] = useState(false);
  const cursor = useRef(0);
  const reportError = actions.reportError;

  useEffect(() => {
    if (!on || !visible || !foregroundApp) {
      setRows([]);
      setRunning(false);
      return undefined;
    }
    let cancelled = false;
    let timer: number | null = null;
    cursor.current = 0;
    const api = window.ade.iosSimulator;
    // The pin this subscription was opened with; the stop goes to the same machine.
    const pin = pinRef.current;
    const absorb = (page: { rows: IosSimulatorLogRow[]; cursor: number; running: boolean }) => {
      if (cancelled) return;
      cursor.current = page.cursor;
      setRunning(page.running);
      if (page.rows.length) setRows((current) => appendEventLogRows(current, page.rows));
    };
    const poll = async () => {
      try {
        absorb(await api.getEventLog({ ...scope, sinceId: cursor.current, limit: APPLE_EVENT_LOG_LIMIT }, pin));
      } catch (cause: unknown) {
        if (!cancelled) reportError(cause);
      }
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, POLL_MS);
    };
    void api.startEventLog({ ...scope, bundleId: foregroundApp }, pin)
      .then((page) => {
        absorb(page);
        if (!cancelled) timer = window.setTimeout(() => { void poll(); }, POLL_MS);
      })
      .catch((cause: unknown) => { if (!cancelled) reportError(cause); });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      void api.stopEventLog({}, pin).catch(() => {});
    };
  }, [foregroundApp, on, pinRef, reportError, scope, visible]);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="apple-drawer-event-log">
      <SwitchRow
        label={running ? "Streaming" : "Stream log"}
        checked={on}
        disabled={!visible || !foregroundApp}
        onChange={setOn}
      />
      {!on ? null : (
        <ol className="max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed" aria-label="Event log rows">
          {rows.length === 0 ? (
            <li className="text-muted-fg">No events yet.</li>
          ) : rows.map((row) => (
            <li key={row.id} className="flex min-w-0 gap-2">
              <span className="shrink-0 text-muted-fg">{eventLogClock(row.at)}</span>
              <span className={cn("min-w-0 truncate", (row.level === "error" || row.level === "fault") && "text-[var(--color-error)]")}>
                {row.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
