import { DRAWER_BUTTON, Row, Section, SubmitRow } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

/** §8.1 — Foreground app, Relaunch / Terminate, open a URL, launch a bundle id. */
export function AppSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions, foregroundApp, setForegroundApp } = ctx;
  const disabled = actions.disabled;
  const noApp = !foregroundApp;
  return (
    <Section title="App" testId="apple-drawer-app">
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
        onSubmit={(bundleId) => actions
          .act(() => window.ade.iosSimulator.launch({
            laneId: scope.laneId,
            deviceUdid: scope.deviceUdid,
            bundleId,
            build: false,
            mode: "live",
            openDrawer: false,
          }, pinRef.current))
          .then((accepted) => {
            if (accepted) setForegroundApp(bundleId);
            return accepted;
          })}
      />
    </Section>
  );
}
