/**
 * Plugin keybindings: the chord grammar, and the one collision matrix.
 *
 * Two clients bind keys — the desktop renderer (`renderer/lib/keybindings.ts`,
 * `"Mod+K"`) and the Ink TUI (`tuiClient/keybindings/index.ts`, `"ctrl+g"`) —
 * and they spell chords differently because each grew against a different
 * event source. A plugin declares its chord once, in the manifest, so the
 * spelling it uses has to mean the same thing on both, and more importantly the
 * *refusals* have to match: a chord the desktop hands to a plugin but the TUI
 * hands to core is a plugin that works until the user opens `ade code`.
 *
 * So the grammar and {@link resolvePluginKeybindings} live here, above both,
 * and each client contributes only the two things it alone knows: which chords
 * core has already claimed, and how to turn a real key event into a chord.
 */

import type { PluginManifestKeybinding } from "./manifest";

/**
 * One keystroke, normalized. `mod` survives as its own flag rather than being
 * resolved to ctrl/meta here because this module has no platform: resolution is
 * the event matcher's job, and collision detection deliberately does the
 * opposite of resolving (see {@link chordCollisionKeys}).
 */
export type PluginChord = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/**
 * Modifier spellings both clients accept. The desktop table writes `"Mod+K"`
 * and the TUI writes `"ctrl+g"`; a plugin may write either, in any case.
 */
const MODIFIER_TOKENS: Readonly<Record<string, keyof Omit<PluginChord, "key">>> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Key spellings that differ between the DOM and Ink, collapsed to one name. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  escape: "esc",
  return: "enter",
  del: "delete",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  " ": "space",
  spacebar: "space",
};

/**
 * Collapse one key name — from a manifest chord, a DOM `event.key`, or an Ink
 * key flag — onto the single spelling this grammar uses.
 *
 * Exported because the event matchers are the clients' job (see
 * {@link PluginChord}) and they each start by turning a live keystroke into a
 * key name. A client that grew its own alias table would be a second grammar
 * wearing a different name, and the failure would be silent: `"Mod+ArrowUp"`
 * parses here as `up` and would simply never match an event the client still
 * calls `arrowup`.
 */
export function normalizeChordKeyName(raw: string): string {
  // The DOM spells the space bar as a literal `" "`, which trimming would erase
  // entirely — and an empty key name reads as "no key", so the chord would
  // quietly stop matching rather than fail.
  if (raw === " ") return "space";
  const key = raw.trim().toLowerCase();
  if (!key) return "";
  return KEY_ALIASES[key] ?? key;
}

function normalizeKeyName(raw: string): string {
  return normalizeChordKeyName(raw);
}

/**
 * Parse one chord. Returns null for anything this grammar cannot represent,
 * including the multi-stroke sequences the TUI supports (`"ctrl+x ctrl+e"`):
 * the desktop matcher has no notion of a prefix key, and a binding that only
 * half the clients can honour is worse than one they both refuse.
 */
export function parsePluginChord(raw: string): PluginChord | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;

  const chord: PluginChord = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  for (const part of parts) {
    const modifier = MODIFIER_TOKENS[part.toLowerCase()];
    if (modifier) {
      chord[modifier] = true;
      continue;
    }
    // Any non-modifier token is the key. A second one means the chord names two
    // keys, which is a typo rather than an intent worth guessing at.
    if (chord.key) return null;
    chord.key = normalizeKeyName(part);
  }

  if (!chord.key) return null;
  // A bare uppercase letter is shift by convention on both clients.
  if (/^[A-Z]$/.test(text)) chord.shift = true;
  return chord;
}

/** Canonical text for one chord: fixed modifier order, lowercase. */
export function formatPluginChord(chord: PluginChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("mod");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.meta) parts.push("meta");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

/**
 * Chords a plugin may never claim, whatever the manifest says.
 *
 * `ctrl+c` and `ctrl+d` end a process and `ctrl+m` is Enter on a terminal — the
 * TUI reserves these for the same reason (`RESERVED_KEYS`). The rest are the
 * keys a user presses to get *out* of something, and a plugin that can swallow
 * Escape can trap a user inside a panel it drew.
 */
const RESERVED_PLUGIN_KEYS: ReadonlySet<string> = new Set(["c", "d", "m"]);
const RESERVED_BARE_KEYS: ReadonlySet<string> = new Set(["esc", "enter", "tab", "backspace", "delete"]);

/**
 * Chords the WINDOW answers before the page ever sees them.
 *
 * Distinct from the core-conflict matrix below, which is about chords ADE binds
 * in the renderer and can therefore arbitrate. These are handled a layer up —
 * by the application menu's accelerators and by the operating system — and that
 * layer does not consult anybody. So a plugin that "wins" one of them does not
 * take it; it DOUBLE-FIRES with it: ⌘N opens a new window AND runs the plugin,
 * ⌘W closes the tab out from under the action, ⌘Q quits mid-invoke. The user
 * sees a plugin that fires at random and a window that behaves strangely, with
 * nothing on screen connecting the two.
 *
 * Written with `mod` and expanded to both ctrl and meta by
 * {@link chordCollisionKeys}, so the refusal is the same on every platform —
 * the same pessimism that module documents, for the same reason: an author
 * should see the refusal on whichever machine they happen to own.
 *
 * The list is the window/OS set, not a taste judgment: new window/tab (`n`),
 * close (`w`), quit (`q`), minimize (`m`), settings (`comma`), save (`s`),
 * print (`p`), the OS-level find-in-page family (`shift+f`), and the zoom
 * triple (`0`, `minus`, `equal`/`plus`). Punctuation is listed in both
 * spellings a manifest can use, since the grammar takes the literal character
 * as the key name and a plugin may write either.
 *
 * `mod+m` is also caught by {@link RESERVED_PLUGIN_KEYS} (ctrl+M is Enter on a
 * terminal). It is named here too because the reason a user would report it —
 * "the window minimized and the plugin ran" — belongs with these.
 */
const RESERVED_PLUGIN_CHORD_BINDINGS = [
  "mod+n",
  "mod+w",
  "mod+q",
  "mod+m",
  "mod+s",
  "mod+p",
  "mod+shift+f",
  "mod+0",
  "mod+comma",
  "mod+,",
  "mod+minus",
  "mod+-",
  "mod+equal",
  "mod+=",
  "mod+plus",
] as const;

const RESERVED_PLUGIN_CHORDS: ReadonlySet<string> = new Set(
  RESERVED_PLUGIN_CHORD_BINDINGS.flatMap((binding) => chordCollisionKeys(binding)),
);

/**
 * Is this a chord a plugin is allowed to ask for?
 *
 * The load-bearing rule is the modifier requirement. Core binds bare keys —
 * `/`, `j`, `[`, `Enter` — because core knows when the user is typing and when
 * they are navigating a list. A plugin binding fires from a global listener
 * that has no such context, so a plugin allowed to claim `j` would eat the
 * letter out of every field ADE does not remember to guard. Requiring a
 * modifier is the cheap version of that guarantee, and it costs a plugin
 * nothing a user would miss.
 */
export function isBindablePluginChord(chord: PluginChord): boolean {
  if (!chord.key) return false;
  const hasModifier = chord.mod || chord.ctrl || chord.meta || chord.alt;
  if (!hasModifier) return false;
  if (RESERVED_BARE_KEYS.has(chord.key)) return false;
  if ((chord.ctrl || chord.mod) && RESERVED_PLUGIN_KEYS.has(chord.key)) return false;
  // The window and the OS answer these before the page does; see
  // RESERVED_PLUGIN_CHORDS for why "winning" one is a double-fire, not a claim.
  if (chordKeysForChord(chord).some((key) => RESERVED_PLUGIN_CHORDS.has(key))) return false;
  return true;
}

/** Parse-and-policy in one call, for the manifest parser. */
export function isValidPluginKeybinding(binding: string): boolean {
  const chord = parsePluginChord(binding);
  return chord != null && isBindablePluginChord(chord);
}

/**
 * Every canonical chord a binding could fire on *some* platform.
 *
 * Deliberately pessimistic, and this is the whole trick of cross-platform
 * collision detection: `mod` is Cmd on macOS and Ctrl everywhere else, so core's
 * `"Mod+K"` and a plugin's `"Ctrl+K"` are the same keystroke on Windows and
 * different ones on a Mac. Expanding `mod` to both means the plugin is refused
 * on every platform rather than on some of them, which is the answer that makes
 * a manifest reviewable: the author sees the refusal on the machine they have.
 */
export function chordCollisionKeys(binding: string): string[] {
  const chord = parsePluginChord(binding);
  if (!chord) return [];
  return chordKeysForChord(chord);
}

/** {@link chordCollisionKeys} for a chord already parsed. */
function chordKeysForChord(chord: PluginChord): string[] {
  if (!chord.mod) return [formatPluginChord(chord)];
  const asCtrl = formatPluginChord({ ...chord, mod: false, ctrl: true });
  const asMeta = formatPluginChord({ ...chord, mod: false, meta: true });
  return asCtrl === asMeta ? [asCtrl] : [asCtrl, asMeta];
}

/**
 * A binding, before the matrix has ruled on it.
 *
 * `installedAt` is what makes "first installed wins" decidable, and it comes
 * from the install registry rather than from load order because load order is
 * whatever the supervisor happened to do this boot — a tie-break the user
 * cannot predict is not a tie-break, it is a coin flip that changes on restart.
 */
export type PluginKeybindingRequest = {
  pluginId: string;
  /** Display name, for the refusal log line and the shortcut listing. */
  pluginName: string;
  /** ISO timestamp from the install registry. */
  installedAt: string;
  action: string;
  binding: string;
  label: string;
};

export type ResolvedPluginKeybinding = PluginKeybindingRequest & {
  /** Canonical chords this binding answers to. */
  collisionKeys: string[];
};

export type PluginKeybindingRefusalReason = "invalid" | "core-conflict" | "plugin-conflict" | "duplicate-action";

export type PluginKeybindingRefusal = {
  pluginId: string;
  pluginName: string;
  action: string;
  binding: string;
  reason: PluginKeybindingRefusalReason;
  /** Whoever already holds the chord: a core action id, or another plugin id. */
  heldBy: string | null;
  /** One sentence, ready for a log line. Never invented at the call site. */
  message: string;
};

export type PluginKeybindingResolution = {
  bindings: ResolvedPluginKeybinding[];
  refusals: PluginKeybindingRefusal[];
};

/**
 * Chords core has already claimed, as the resolver wants them: canonical chord
 * → the core action id holding it. Built by each client from its own registry,
 * because only the client knows what "core" means there.
 */
export type CoreChordIndex = ReadonlyMap<string, string>;

/** Build a {@link CoreChordIndex} from `actionId -> binding string` pairs. */
export function buildCoreChordIndex(entries: Iterable<readonly [string, string]>): CoreChordIndex {
  const index = new Map<string, string>();
  for (const [actionId, binding] of entries) {
    // A core binding may list alternatives (`"/,Mod+F"`); each one is claimed.
    for (const alternative of binding.split(",")) {
      for (const key of chordCollisionKeys(alternative)) {
        if (!index.has(key)) index.set(key, actionId);
      }
    }
  }
  return index;
}

function refusalMessage(
  request: PluginKeybindingRequest,
  reason: PluginKeybindingRefusalReason,
  heldBy: string | null,
): string {
  const who = `${request.pluginName} (${request.pluginId})`;
  switch (reason) {
    case "invalid":
      return `${who} asked for keyboard shortcut "${request.binding}", which is not a shortcut a plugin can bind — it needs a modifier and must not be a reserved key.`;
    case "core-conflict":
      return `${who} asked for keyboard shortcut "${request.binding}", which ADE already uses for ${heldBy}. The plugin's action is still available from the command palette.`;
    case "plugin-conflict":
      return `${who} asked for keyboard shortcut "${request.binding}", which the ${heldBy} plugin claimed first. The plugin's action is still available from the command palette.`;
    case "duplicate-action":
      return `${who} declares more than one keyboard shortcut for "${request.action}"; only the first is bound.`;
  }
}

/**
 * Rule the matrix on a set of requests.
 *
 * The order is the policy, and it is not negotiable in either direction:
 *
 * 1. **Core always wins.** Not "usually" — a plugin cannot take a chord ADE
 *    ships, and it cannot take one the *user* has rebound onto either, because
 *    the user's override is core's binding as far as this is concerned. The
 *    alternative is a plugin that silently changes what ⌘K does, which is
 *    indistinguishable from malware and unattributable when it goes wrong.
 * 2. **First installed wins between plugins.** Arbitrary, but stable and
 *    explicable: the plugin that was there yesterday keeps working when the
 *    user installs something new today, which is the direction surprise should
 *    run.
 *
 * Nothing is silently dropped. Every refusal comes back with a sentence, so the
 * caller can log it and the settings listing can show it — a shortcut that does
 * nothing and says nothing is the failure this whole function exists to avoid.
 */
export function resolvePluginKeybindings(
  requests: readonly PluginKeybindingRequest[],
  coreChords: CoreChordIndex,
): PluginKeybindingResolution {
  const bindings: ResolvedPluginKeybinding[] = [];
  const refusals: PluginKeybindingRefusal[] = [];
  /** Canonical chord → the plugin id already holding it. */
  const claimed = new Map<string, string>();
  const seenActions = new Set<string>();

  const refuse = (request: PluginKeybindingRequest, reason: PluginKeybindingRefusalReason, heldBy: string | null) => {
    refusals.push({
      pluginId: request.pluginId,
      pluginName: request.pluginName,
      action: request.action,
      binding: request.binding,
      reason,
      heldBy,
      message: refusalMessage(request, reason, heldBy),
    });
  };

  // Sort by install time so "first installed wins" is decided before the loop
  // rather than by however the caller happened to gather the requests. Ties
  // fall back to plugin id, which at least keeps a machine's answer stable.
  const ordered = [...requests].sort((a, b) => {
    if (a.installedAt !== b.installedAt) return a.installedAt < b.installedAt ? -1 : 1;
    if (a.pluginId !== b.pluginId) return a.pluginId < b.pluginId ? -1 : 1;
    return 0;
  });

  for (const request of ordered) {
    const actionKey = `${request.pluginId}::${request.action}`;
    if (seenActions.has(actionKey)) {
      refuse(request, "duplicate-action", null);
      continue;
    }

    const collisionKeys = chordCollisionKeys(request.binding);
    const chord = parsePluginChord(request.binding);
    if (collisionKeys.length === 0 || !chord || !isBindablePluginChord(chord)) {
      refuse(request, "invalid", null);
      continue;
    }

    const coreHolder = collisionKeys.map((key) => coreChords.get(key)).find((holder) => holder != null);
    if (coreHolder) {
      refuse(request, "core-conflict", coreHolder);
      continue;
    }

    const pluginHolder = collisionKeys.map((key) => claimed.get(key)).find((holder) => holder != null);
    if (pluginHolder) {
      refuse(request, "plugin-conflict", pluginHolder);
      continue;
    }

    for (const key of collisionKeys) claimed.set(key, request.pluginId);
    seenActions.add(actionKey);
    bindings.push({ ...request, collisionKeys });
  }

  return { bindings, refusals };
}

/**
 * Turn a plugin's manifest declarations into requests. Kept here so both
 * clients agree on what a manifest entry means before the matrix sees it.
 */
export function pluginKeybindingRequests(
  plugin: { pluginId: string; displayName: string; installedAt: string },
  declarations: readonly PluginManifestKeybinding[],
): PluginKeybindingRequest[] {
  return declarations.map((declaration) => ({
    pluginId: plugin.pluginId,
    pluginName: plugin.displayName,
    installedAt: plugin.installedAt,
    action: declaration.action,
    binding: declaration.binding,
    label: declaration.label,
  }));
}
