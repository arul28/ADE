/**
 * The setting scope vocabulary, and the one place its user-facing copy lives.
 *
 * This sits in `shared/` rather than beside the renderer's settings manifest
 * because `shared/accountSettingsScope.ts` — which decides the key a setting
 * files under in the account store — needs the type. A shared module reaching
 * up into a renderer component file is the kind of import the main process
 * eventually trips over; the type is the contract, so the contract lives here
 * and the manifest re-exports it.
 */

import { THIS_MACHINE_NAME } from "../machineIdentity";

/**
 * Where a setting is persisted, and therefore who it affects.
 *
 * Two axes, not one. **Who** owns it — your account, or this computer — and
 * **how much** it covers — everything you do, or one repository. The sidebar
 * group IS the scope, so these four values are also the four groups.
 *
 * The placement rule is mechanical, which is what makes it checkable: if a
 * value holds a path, a port, or a fact about hardware, it is machine scope,
 * because it is meaningless on another computer. Everything else is account
 * scope and follows the user.
 *
 * This replaces `team | machine | app`. "team" is gone with the committed
 * `.ade/ade.yaml` it named, and "app" — a value that lived only in one
 * install's localStorage — was never a scope anyone wanted; it was the reason
 * a second machine felt like a stranger.
 */
export type SettingScope =
  /** The account, everywhere. Preferences, theme, keybindings, providers. */
  | "account"
  /** The account, but only inside one repository. Tests, automations, links. */
  | "account-repo"
  /** This computer, everywhere on it. Paths, ports, updates, storage. */
  | "machine"
  /** This computer, and only inside one repository. Worktrees, local ports. */
  | "machine-repo";

/**
 * Where a setting lands when the renderer is the hosted web client.
 *
 * A browser has no Electron shell and reaches its machine only through the
 * actions the sync host registers, so a setting either travels to that machine,
 * syncs through the ADE account, never leaves the browser tab — or has nowhere
 * to go at all. `hidden` is that last case, and it is why Secrets, providers,
 * GitHub credentials, dictation, the CLI installer, auto-updates, storage,
 * session lifecycle, and lane templates stay off the web nav: their reads land
 * but their writes would resolve against a missing descriptor and vanish.
 *
 * `SettingScope` answers "who does this affect"; this answers "does it work at
 * all from a browser, and what do we tell the user about where it went".
 */
export type SettingWebScope = "machine" | "account" | "browser" | "hidden";

/** The chip's wording for one scope: where it is kept, and who that reaches. */
export type SettingScopeCopy = {
  /**
   * The chip's text. The machine scopes take theirs from `THIS_MACHINE_NAME`
   * rather than spelling it out — a hardcoded "This Mac" made one object claim
   * two different machines, and lied outright on Windows.
   */
  label: string;
  /** Answers "stored in". A place, not a sentence. */
  storedIn: string;
  /** Answers "affects". One sentence, ending in a full stop. */
  affects: string;
};

/**
 * The single statement of what each scope means.
 *
 * This copy used to be written out three times — in the chip, in the sidebar
 * group hint, and implicitly in the group table — and the three had already
 * drifted apart. The chip's wording won because it is the one users read while
 * deciding whether to change a setting.
 */
export const SCOPE_COPY: Record<SettingScope, SettingScopeCopy> = {
  account: {
    label: "Account",
    storedIn: "Your ADE account",
    affects: "Every computer you sign in on.",
  },
  "account-repo": {
    label: "Account · this repo",
    storedIn: "Your ADE account, filed under this repository",
    affects: "Every computer you sign in on, but only inside this repository.",
  },
  machine: {
    label: THIS_MACHINE_NAME,
    storedIn: "This computer only",
    affects:
      "Only this computer. It holds a path, a port, or a piece of hardware, so it would mean nothing anywhere else.",
  },
  "machine-repo": {
    label: `${THIS_MACHINE_NAME} · this repo`,
    storedIn: "This computer, filed under this repository",
    affects: "Only this computer, and only inside this repository.",
  },
};
