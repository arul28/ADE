import { useState } from "react";
import type { IosSimulatorPrivacyAction, IosSimulatorPrivacyService } from "../../../../../shared/types/iosSimulator";
import { IOS_SIMULATOR_PRIVACY_SERVICES } from "../../../../../shared/types/iosSimulator";
import { cn } from "../../../ui/cn";
import { DRAWER_BUTTON, DRAWER_GHOST_BUTTON, DRAWER_INPUT, DrawerMenu, Section } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

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

/** §8.6 — app id, permission, Grant / Revoke / Reset. */
export function PermissionsSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, actions, foregroundApp } = ctx;
  const disabled = actions.disabled;
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
    <Section title="Permissions" testId="apple-drawer-permissions">
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
        <button type="button" className={DRAWER_BUTTON} disabled={disabled || !bundleId} onClick={() => decide("grant")}>Grant</button>
        <button type="button" className={DRAWER_BUTTON} disabled={disabled || !bundleId} onClick={() => decide("revoke")}>Revoke</button>
        <button type="button" className={DRAWER_GHOST_BUTTON} disabled={disabled} onClick={() => decide("reset")}>Reset</button>
      </div>
    </Section>
  );
}
