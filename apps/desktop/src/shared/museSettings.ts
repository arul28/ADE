/**
 * What Settings > Providers > Muse Code reads and changes on one machine, over
 * the `ai.museSettings` action.
 *
 * Every call runs against a short-lived `muse serve` host that the Settings
 * page owns (one per page visit, keyed by `handleId`), never a chat's host.
 * The shapes are ADE's projection of Muse's own MSP results
 * (`@muse-code/sdk` `msp.d.ts`) and of `muse … --json` where MSP has no read
 * (marketplace list, available plugins, the skill catalog with activation).
 * Vocabulary Muse marks as open stays `string` here: a newer Muse may send a
 * value this ADE has never seen, and Settings shows it rather than dropping it.
 */

export type MuseSkillActivation = "on" | "userInvocableOnly" | "off";
export type MuseSkillScope = "user" | "project" | "bundled" | "plugin";
export type MusePluginInstallScope = "default" | "user" | "project";
export type MuseSkillImportSource = "claude" | "codex";
export type MuseFeedbackClassification = "bug" | "badResult" | "goodResult" | "other";
export type MuseComputerUseChoice = "ask" | "alwaysAllow";

export type MuseSettingsPlugin = {
  id: string;
  version: string;
  enabled: boolean;
  /** `curated` | `marketplaceUserAdded` | `foreignImport` | `nativeLocal` | newer. */
  source: string;
};

export type MuseSettingsMarketplace = {
  name: string;
  sourceKind: string;
  sourcePath: string;
  pluginCount: number;
  skippedCount: number;
  lastUpdatedAt: string | null;
};

export type MuseSettingsAvailablePlugin = {
  marketplace: string;
  name: string;
  version: string | null;
  status: string;
};

export type MuseSettingsSkill = {
  /** The full-catalog id `skill/setActivation` takes, e.g. `bundled:grill`, `plugin:acme:deploy`. */
  id: string;
  name: string;
  displayName: string;
  description: string;
  /** `bundled` | `user` | `project` | `plugin` | newer. */
  scope: string;
  /** `on` | `userInvocableOnly` | `off` | newer. */
  activation: string;
};

export type MuseSettingsHook = {
  key: string;
  event: string;
  /** `managed` | `user` | `project` | `plugin` | newer. */
  handlerKind: string;
  enabled: boolean;
};

/** One section's rows, or why that section could not be read. */
export type MuseSettingsSection<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export type MuseSettingsSnapshot = {
  /** The workspace the scratch session reads project-scoped state from. */
  workspaceRoot: string;
  plugins: MuseSettingsSection<MuseSettingsPlugin>;
  marketplaces: MuseSettingsSection<MuseSettingsMarketplace>;
  availablePlugins: MuseSettingsSection<MuseSettingsAvailablePlugin>;
  skills: MuseSettingsSection<MuseSettingsSkill>;
  hooks: MuseSettingsSection<MuseSettingsHook>;
};

export type MuseComputerUseSettings = {
  computerControl: string;
  screenshots: string;
  /** `locked` rows are Muse's built-in blocks; `prefix` rows block a whole bundle-id family. */
  blockedApps: Array<{ bundleId: string; locked: boolean; prefix: boolean }>;
};

export type MuseComputerUseSetup = {
  /** `dormant` | `inProgress` | `restartRequired` | `readyForTarget` | `stopped` | newer. */
  setup: string;
  accessibility: string;
  screenRecording: string;
  inputMonitoring: string;
  message: string | null;
  refused: string | null;
};

export type MuseComputerUseState =
  | {
      available: false;
      /** Muse's own words for why (e.g. the computer-use gate is off for this host). */
      reason: string;
    }
  | {
      available: true;
      settings: MuseComputerUseSettings | null;
      settingsError: string | null;
      setup: MuseComputerUseSetup | null;
      setupError: string | null;
      /** True when the host granted `computerUseHostSetup` (machine-level setup and the grant check). */
      hostSetup: boolean;
    };

export type MuseFeedbackResult = {
  /** `uploaded` | `recorded` | `noCredential` | `rateLimited` | `failed` | … (open). */
  outcome: string;
  bundlePath: string;
  cause: string | null;
  retryAfterMs: number | null;
};

export type MuseSkillImportResult = {
  dryRun: boolean;
  installed: string[];
  skipped: string[];
  quarantined: Array<{ id: string; reasons: string[] }>;
  failed: Array<{ id: string | null; reason: string }>;
};

export type MuseSettingsRequest =
  | { kind: "snapshot" }
  | { kind: "computerUse" }
  | {
      kind: "pluginInstall";
      target:
        | { marketplace: string; name: string }
        | { path: string; scope?: MusePluginInstallScope };
    }
  | { kind: "marketplaceAdd"; name: string; source: string }
  | { kind: "marketplaceUpdate"; name: string }
  | { kind: "marketplaceRemove"; name: string }
  | { kind: "skillSetActivation"; selector: string; scope: MuseSkillScope; activation: MuseSkillActivation }
  | { kind: "skillImport"; source: MuseSkillImportSource; dryRun: boolean; force?: boolean }
  | {
      kind: "computerUseUpdate";
      patch: {
        computerControl?: MuseComputerUseChoice;
        screenshots?: MuseComputerUseChoice;
        blockApps?: string[];
        unblockApps?: string[];
      };
    }
  | { kind: "computerUseSetupStart" }
  | { kind: "computerUseSetupCheck" }
  | { kind: "feedback"; classification: MuseFeedbackClassification; note: string; withFiles: boolean };

export type MuseSettingsResultMap = {
  snapshot: MuseSettingsSnapshot;
  computerUse: MuseComputerUseState;
  pluginInstall: { plugin: MuseSettingsPlugin; warning: string | null };
  marketplaceAdd: { marketplace: MuseSettingsMarketplace };
  marketplaceUpdate: { marketplace: MuseSettingsMarketplace };
  marketplaceRemove: { name: string };
  skillSetActivation: { selector: string; activation: string; previous: string };
  skillImport: MuseSkillImportResult;
  computerUseUpdate: MuseComputerUseState;
  computerUseSetupStart: MuseComputerUseState;
  computerUseSetupCheck: MuseComputerUseState;
  feedback: MuseFeedbackResult;
};

export type MuseSettingsResult<K extends MuseSettingsRequest["kind"] = MuseSettingsRequest["kind"]> = MuseSettingsResultMap[K];

export type MuseSettingsRunArgs<R extends MuseSettingsRequest = MuseSettingsRequest> = {
  /** One id per Settings page visit; the host stays open across calls with the same id. */
  handleId: string;
  request: R;
};
