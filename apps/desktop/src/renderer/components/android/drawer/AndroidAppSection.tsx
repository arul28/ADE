import { useEffect, useState } from "react";
import {
  ANDROID_PERMISSIONS,
  type AndroidAppInfo,
  type AndroidInstallResult,
  type AndroidPermissionName,
} from "../../../../shared/types/androidEmulator";
import { cn } from "../../ui/cn";
import {
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  Row,
  Subhead,
  SubmitRow,
} from "../../ui/drawerPrimitives";
import type { AndroidDrawerContext } from "./androidDrawerState";
import { AndroidInstrumentationTestsRow } from "./AndroidInstrumentationTestsRow";

/*
 * The **App** group: the app in front and what you do to it, in the order you
 * reach for it — build and run the lane's app, restart or stop it, start
 * another, send it a link, install an APK, then its permissions.
 */

/** How often the open App group asks the device which app is in front. */
export const ANDROID_FOREGROUND_POLL_MS = 2_000;

/** "Installed com.example in 42 s". */
export function describeInstall(result: AndroidInstallResult): string {
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  return `Installed ${result.packageName ?? "the app"} in ${seconds} s`;
}

export function AndroidAppSection({ ctx }: { ctx: AndroidDrawerContext }) {
  const { laneId, pinRef, visible, actions } = ctx;
  const disabled = actions.disabled;
  const reportError = actions.reportError;
  const [foreground, setForeground] = useState<string | null>(null);
  const [apps, setApps] = useState<AndroidAppInfo[] | null>(null);
  const [appsNonce, setAppsNonce] = useState(0);
  const [lastInstall, setLastInstall] = useState<string | null>(null);
  const [packageInput, setPackageInput] = useState("");
  const [permission, setPermission] = useState<AndroidPermissionName>("android.permission.CAMERA");
  const api = window.ade.androidEmulator;
  const target = packageInput.trim() || foreground || "";

  // The app in front, asked of the device while this group is open (it unmounts when closed).
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const answer = await window.ade.androidEmulator.getDeviceSettings({ laneId, fields: "foreground" }, pinRef.current);
        if (!cancelled) setForeground(answer.foregroundPackage);
      } catch {
        // A failed poll keeps the last answer; the next one tries again.
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, ANDROID_FOREGROUND_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [laneId, pinRef, visible]);

  // The launchable apps, read when the group opens and after an install or uninstall.
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    window.ade.androidEmulator.listApps({ laneId }, pinRef.current)
      .then((list) => { if (!cancelled) setApps(list.apps.filter((app) => app.launchActivity)); })
      .catch((cause: unknown) => { if (!cancelled) reportError(cause); });
    return () => { cancelled = true; };
  }, [appsNonce, laneId, pinRef, reportError, visible]);

  const install = (work: () => Promise<{ install: AndroidInstallResult | null } | AndroidInstallResult>) =>
    actions.act(async () => {
      const answer = await work();
      const result = "install" in answer ? answer.install : answer;
      setLastInstall(result ? describeInstall(result) : null);
      setAppsNonce((nonce) => nonce + 1);
    });

  const launchOptions = (apps ?? []).map((app) => ({
    value: app.packageName,
    label: app.packageName,
    group: app.adeInstalled ? "Installed by ADE" : "Other apps",
  })).sort((left, right) => (left.group === right.group ? 0 : left.group === "Installed by ADE" ? -1 : 1));

  return (
    <>
      <Row label="In front">
        <span className="truncate font-mono text-xs text-fg/85" data-testid="android-drawer-foreground">
          {foreground ?? "Home screen"}
        </span>
      </Row>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={DRAWER_PRIMARY_BUTTON}
          disabled={disabled}
          title="Build the lane's app with Gradle, install it and start it"
          onClick={() => { void install(() => api.launchApp({ laneId, gradle: {} }, pinRef.current)); }}
        >
          Build &amp; run
        </button>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled || !foreground}
          onClick={() => {
            if (!foreground) return;
            void actions.act(async () => {
              await api.terminateApp({ laneId, packageName: foreground }, pinRef.current);
              await api.launchApp({ laneId, packageName: foreground }, pinRef.current);
            });
          }}
        >
          Relaunch
        </button>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled || !foreground}
          onClick={() => {
            if (!foreground) return;
            void actions.act(() => api.terminateApp({ laneId, packageName: foreground }, pinRef.current));
          }}
        >
          Stop
        </button>
        <button
          type="button"
          className={DRAWER_GHOST_BUTTON}
          disabled={disabled || !foreground}
          onClick={() => {
            if (!foreground) return;
            void actions.act(async () => {
              await api.uninstallApp({ laneId, packageName: foreground }, pinRef.current);
              setAppsNonce((nonce) => nonce + 1);
            });
          }}
        >
          Uninstall
        </button>
      </div>
      {lastInstall ? <p className="text-[11px] text-muted-fg" data-testid="android-drawer-last-install">{lastInstall}</p> : null}
      <Row label="Start an app">
        <DrawerMenu
          ariaLabel="Start an app"
          value={null}
          placeholder={apps === null ? "Reading…" : apps.length ? "Choose…" : "No apps"}
          options={launchOptions}
          disabled={disabled || !apps?.length}
          onChange={(packageName) => {
            void actions.act(() => api.launchApp({ laneId, packageName }, pinRef.current));
          }}
        />
      </Row>
      <SubmitRow
        placeholder="https://… or myapp://"
        ariaLabel="Link to open"
        action="Open"
        disabled={disabled}
        onSubmit={(url) => actions.act(() => api.openUrl({ laneId, url }, pinRef.current))}
      />
      <SubmitRow
        placeholder="APK path in the lane"
        ariaLabel="APK path"
        action="Install"
        disabled={disabled}
        onSubmit={(apkPath) => install(() => api.installApp({ laneId, apkPath }, pinRef.current))}
      />
      <AndroidInstrumentationTestsRow ctx={ctx} />

      <Subhead label="Permissions" />
      <div className="flex min-h-7 items-center">
        <input
          className={cn(DRAWER_INPUT, "font-mono")}
          placeholder={foreground ?? "Package name"}
          aria-label="Package name"
          value={packageInput}
          disabled={disabled}
          onChange={(event) => setPackageInput(event.target.value)}
        />
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        <DrawerMenu<AndroidPermissionName>
          ariaLabel="Permission"
          value={permission}
          placeholder="Permission"
          options={ANDROID_PERMISSIONS}
          disabled={disabled}
          onChange={setPermission}
        />
        <button
          type="button"
          className={DRAWER_PRIMARY_BUTTON}
          disabled={disabled || !target}
          onClick={() => { void actions.act(() => api.setPermission({ laneId, action: "grant", packageName: target, permission }, pinRef.current)); }}
        >
          Grant
        </button>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={disabled || !target}
          onClick={() => { void actions.act(() => api.setPermission({ laneId, action: "revoke", packageName: target, permission }, pinRef.current)); }}
        >
          Revoke
        </button>
      </div>
    </>
  );
}
