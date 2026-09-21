import { Section, SubmitRow } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

/** §8.7 — "Alert text" → Send, to the foreground app. */
export function PushSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions, foregroundApp } = ctx;
  return (
    <Section title="Push notification" testId="apple-drawer-push">
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
    </Section>
  );
}
