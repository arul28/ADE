/**
 * Machine-wide browser settings in the renderer: one shared read, kept current
 * by main's push event. The plumbing lives in `createBridgeSnapshotStore`, the
 * same one `browserAgentAccess.ts` uses.
 */
import {
  type BuiltInBrowserSettings,
  type BuiltInBrowserSettingsPatch,
} from "../../../../shared/types/builtInBrowser";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { createBridgeSnapshotStore } from "./createBridgeSnapshotStore";

type BrowserSettingsApi = {
  get: () => Promise<BuiltInBrowserSettings>;
  set: (patch: BuiltInBrowserSettingsPatch) => Promise<BuiltInBrowserSettings>;
  onChange: (cb: (settings: BuiltInBrowserSettings) => void) => () => void;
};

function api(): BrowserSettingsApi | null {
  const candidate = (typeof window === "undefined" ? null : window.ade?.builtInBrowser?.browserSettings) as
    | Partial<BrowserSettingsApi>
    | null
    | undefined;
  return isAdeAvailable(candidate) && isAdeAvailable(candidate.get) ? (candidate as BrowserSettingsApi) : null;
}

function isSettings(value: unknown): value is BuiltInBrowserSettings {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { tabLimit?: unknown }).tabLimit === "number"
    && (value as { autoGrant?: unknown }).autoGrant
    && typeof (value as { autoGrant: { camera?: unknown } }).autoGrant === "object",
  );
}

const store = createBridgeSnapshotStore<BuiltInBrowserSettings>({
  bridge: api,
  isValid: isSettings,
});

/** `null` means nothing has arrived yet; check `useBrowserSettingsStatus`. */
export const useBrowserSettings = store.useSnapshot;
export const useBrowserSettingsStatus = store.useStatus;

export const browserSettingsActions = {
  async set(patch: BuiltInBrowserSettingsPatch): Promise<void> {
    const bridge = api();
    if (!bridge) return;
    store.publish(await bridge.set(patch));
  },
  /** Try the first read again after it failed. */
  reload: store.reload,
};
