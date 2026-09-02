/**
 * `plugin.json` — the ADE plugin manifest contract.
 *
 * This module is the all-client shared half of the plugin platform: pure types
 * plus a pure parser, no React, no Electron, no Node built-ins — mirroring
 * `../adeCard.ts`, which is likewise imported by the desktop renderer AND by
 * `apps/ade-cli`.
 *
 * Two rules the whole plugin contract rests on:
 *
 * 1. **Strict on known keys, tolerant of unknown ones.** A manifest written
 *    against a newer ADE must still load on an older one: fields this build has
 *    never heard of are dropped, not rejected. But a key we DO know, carrying
 *    the wrong shape, is an error — silently ignoring a malformed `sockets`
 *    entry would ship a plugin that looks installed and contributes nothing,
 *    which is the worst of both worlds. {@link parsePluginManifest} therefore
 *    returns errors AND a manifest whenever the identity fields survive.
 * 2. **The plugin id is a path component.** It names a directory under
 *    `~/.ade/plugins/`, a secret namespace, and a sync-table primary key, so it
 *    is validated against one narrow character class here and nowhere else.
 *    Anything that would traverse, collide case-insensitively, or need quoting
 *    is refused at parse time rather than defended against at every use site.
 *
 * Version policy: this file IS the manifest shape. `vocabVersion` in the manifest
 * is the panel-schema vocabulary version, which moves independently (see
 * `./vocabulary.ts`).
 */

import {
  PLUGIN_SOCKET_KINDS,
  PLUGIN_SOCKET_REQUIREMENTS,
  PLUGIN_SURFACE_IDS,
  isPluginDialogKind,
  normalizePluginSlashCommand,
  parsePluginActionButtonMenu,
  sanitizePluginActionColor,
  type PluginActionButtonMenuItem,
  type PluginDialogKind,
  type PluginSocketExtraField,
  type PluginSocketKind,
  type PluginSocketRequirementField,
  type PluginSurfaceId,
} from "./sockets";
import {
  isPluginBuiltinSurfaceId,
  PLUGIN_BUILTIN_SURFACE_MOBILE,
  PLUGIN_BUILTIN_SURFACE_PRESENCE,
  type PluginBuiltinSurfaceId,
} from "./builtinSurfaceRegistry";
import { isValidPluginKeybinding } from "./keybindings";
import { isValidPluginNetworkHost, PLUGIN_NETWORK_HOSTS_MAX } from "./network";
import { isRecord, oneOf, trimmed as trimmedString } from "./parse";
import { PLUGIN_BRAND_ICON_LIMITS } from "./vocabularyBrandIcons";
import {
  compilePluginUrlMatcherPattern,
  coreSmartLinkHostOwner,
  coreSmartLinkBuiltinsOwnedBy,
  isValidPluginUrlMatcherGlyph,
  isValidPluginUrlMatcherProvider,
  parsePluginUrlMatcherLabelTemplate,
  PLUGIN_URL_MATCHER_HOSTS_MAX,
  PLUGIN_URL_MATCHERS_PER_PLUGIN,
  type PluginManifestUrlMatcher,
} from "./urlMatchers";

export type {
  PluginManifestUrlMatcher,
  PluginManifestUrlMatcherChip,
  PluginManifestUrlMatcherEntity,
} from "./urlMatchers";
import { isValidProjectSecretName } from "../types/projectSecrets";

/**
 * Plugin ids are lowercase-kebab and short: they become a directory name, a
 * `plugin:<id>:<NAME>` secret namespace, a CRR primary-key component, and a
 * `ade <id> <cmd>` CLI word. Case-insensitive filesystems make mixed case a
 * collision hazard, so uppercase is refused rather than folded.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** `major.minor.patch` with an optional prerelease/build tail. */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** CSS hex accent, 3- or 6-digit. Themes carry full token sets instead. */
const PLUGIN_ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * An accent reaches a CSS custom property, so every layer that accepts one has
 * to judge it the same way. Exported for the directory parser, which reads
 * accents from third-party index entries the manifest parser never sees.
 */
export function isValidPluginAccent(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ACCENT_PATTERN.test(value);
}

/**
 * Relative POSIX paths only. A manifest may not reach outside its own install
 * directory, and the host resolves these against the plugin root.
 */
const PLUGIN_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/;

/** Theme token allowlist — see D15. Only design-token namespaces are settable. */
export const PLUGIN_THEME_TOKEN_PREFIXES = [
  "--color-",
  "--shell-",
  "--chat-",
  "--work-",
  "--pane-",
  "--pr-",
  "--gradient-",
] as const;

/**
 * The full shape of a settable token name, not just its namespace.
 *
 * A prefix check alone accepts anything after the prefix, and the name is
 * interpolated into a stylesheet on the left of the colon — so a "name" like
 * `--color-x: red } html * { display: none } .z{a` closes ADE's own rule and
 * writes arbitrary CSS, and `--color-x: url(https://…)` reaches the network.
 * Both halves are required: the namespace prefix AND this shape.
 */
export const PLUGIN_THEME_TOKEN_NAME_PATTERN = /^--[a-z0-9-]{1,60}$/;

/**
 * `webview` is the escape hatch from the vocabulary, and it is deliberately the
 * narrowest one.
 *
 * A tab or a pane renders a panel schema, which every client interprets with its
 * own widgets — that is what lets one plugin work on desktop, iOS, web and the
 * TUI at once. A webview renders the plugin's own HTML inside a sandboxed guest
 * on the desktop and nowhere else, so it buys unlimited UI at the cost of being
 * a single-platform surface. Choose it when the vocabulary genuinely cannot say
 * what the plugin needs to draw, not to avoid learning the vocabulary.
 *
 * Every webview surface still declares a `panelId`. That panel is what iOS, the
 * web client and the TUI show in its place, so "desktop-only" degrades to the
 * plugin's own sentence and an open-on-desktop link rather than to a blank
 * space. It is required, not optional, precisely because the fallback is the
 * thing that keeps the cross-surface promise honest.
 */
export type PluginSurfaceKind = "tab" | "pane" | "webview";

/**
 * The closed list of gateable compiled surfaces, and the tables keyed by it,
 * now live in `builtinSurfaceRegistry.ts` — a module that imports nothing at
 * all.
 *
 * They moved because `urlMatchers.ts` needs the owner half of that registry and
 * cannot import this file: the arrow already runs the other way, since the
 * manifest parser validates the URL-matcher pattern language. A leaf both
 * modules can read replaced the hand-written mirror of the owner names that the
 * cycle used to force.
 *
 * Re-exported from here, rather than re-pointing every caller, because roughly
 * twenty modules across main, the renderer, the shared layer and `apps/ade-cli`
 * already import these names from `manifest`. Only the file the constants live
 * in changed; new code should import them from the registry directly.
 */
export {
  isPluginBuiltinSurfaceId,
  PLUGIN_BUILTIN_SURFACE_IDS,
  PLUGIN_BUILTIN_SURFACE_MOBILE,
  PLUGIN_BUILTIN_SURFACE_OWNER_IDS,
  PLUGIN_BUILTIN_SURFACE_PRESENCE,
  type PluginBuiltinSurfaceId,
} from "./builtinSurfaceRegistry";

const SURFACE_KINDS: readonly PluginSurfaceKind[] = ["tab", "pane", "webview"];

export type PluginManifestSurface = {
  kind: PluginSurfaceKind;
  id: string;
  title: string;
  icon?: string;
  /**
   * The vocabulary panel this surface renders — and, for a `webview` surface,
   * the panel every non-desktop client renders in its place. Required on all
   * three kinds: see {@link PluginSurfaceKind}.
   */
  panelId: string;
  order?: number;
  /**
   * Names a compiled-in tab this surface gates instead of rendering. Only ever
   * present on an official manifest — see the trust note in {@link parseSurfaces}.
   */
  builtin?: PluginBuiltinSurfaceId;
  /**
   * `webview` only: the HTML file the sandboxed guest loads, relative to the
   * plugin's install directory. Served over `ade-plugin://<pluginId>/…`, which
   * exposes that directory and nothing above it.
   */
  entryHtml?: string;
  /**
   * Whether this surface appears on the phone.
   *
   * The parser always sets it, and sets the RESOLVED answer rather than the raw
   * manifest value: what the author asked for is only ever narrowed, by the two
   * ceilings in {@link parseSurfaces}. Optional in the type because a
   * hand-written surface literal (the bundled Marketplace index, a fixture) is
   * not obliged to restate a default — absent reads as "whatever this kind does
   * today", which is what {@link pluginPanelShowsOnMobile} applies.
   */
  mobile?: boolean;
};

export type PluginManifestPanel = {
  id: string;
  /** Relative path to the vocabulary JSON this panel renders by default. */
  schemaFile?: string;
  title?: string;
  icon?: string;
  /**
   * The plugin action a client's refresh gesture dispatches.
   *
   * A panel whose rows come from the plugin's own collections is already live —
   * the host republishes and every client refetches. A panel whose rows come
   * from somewhere else (an API the plugin polls) has no such signal, and a
   * reader looking at stale rows had no way to ask for new ones. Declaring this
   * is how a plugin says "a refresh gesture means something here".
   *
   * When it is declared, the desktop and web header grow a refresh control,
   * iOS adds pull-to-refresh to the pane, and the TUI's `r` dispatches it
   * before refetching. When it is absent, nothing changes on any client.
   */
  refreshAction?: string;
};

export type PluginManifestSocket = {
  socket: PluginSocketKind;
  surface: PluginSurfaceId;
  /** Stable per-plugin id for this contribution; identity for dedupe/ordering. */
  id: string;
  order?: number;
  label?: string;
  icon?: string;
  /** `detail-section` / `file-viewer` render this panel. */
  panelId?: string;
  /** `toolbar-action` / `row-menu-item` invoke this plugin action. */
  actionId?: string;
  /**
   * The three action-BUTTON kinds only: extra actions behind a chevron.
   *
   * Not a `manifestExtra`. A split button with a malformed menu is still a
   * perfectly good button, and dropping the contribution over its dropdown
   * would be the opposite of what the requirement table is for — so a bad
   * `menu` degrades to no menu here, exactly as it does on a published row.
   */
  menu?: PluginActionButtonMenuItem[];
  /**
   * The three action-BUTTON kinds only: a hex tint for this one control.
   *
   * Not a `manifestExtra` and never a reason to drop the entry, for the same
   * reason `menu` is not: a button whose colour was refused is still a
   * perfectly good button wearing the platform's own tone. Judged by
   * {@link sanitizePluginActionColor}, so a value that cannot be read in one
   * of the two themes never reaches the field.
   */
  color?: string;
  /** `file-viewer` only: lowercase extensions including the dot. */
  extensions?: string[];
  /** `filter-chip` only. */
  filterKey?: string;
  /**
   * `slash-command` only: the command word, without the slash.
   *
   * One of the {@link PluginSocketExtraField}s — a field only one kind means
   * anything by, listed in that kind's `manifestExtra` rather than in the four
   * `manifest` fields every entry is read for.
   */
  command?: string;
  /** `dialog-section` only: which dialog the section mounts on. */
  dialog?: PluginDialogKind;
  /**
   * `slash-command` only: the one line the command menu shows.
   *
   * Not a `manifestExtra`, deliberately — the three fields below are all
   * OPTIONAL, and dropping a whole contribution over a missing menu subtitle
   * would be the opposite of what the requirement table is for.
   */
  description?: string;
  /** `slash-command` only: what the command takes — `<issue-id>`, `[branch]`. */
  argumentHint?: string;
  /** `settings-section` only: which settings page hosts the section. */
  section?: string;
};

export type PluginSettingKind = "text" | "secret" | "select" | "toggle" | "number";

export type PluginManifestSetting = {
  key: string;
  kind: PluginSettingKind;
  label: string;
  description?: string;
  /** `select` only: static options, or an action that returns them. */
  options?: { value: string; label: string }[];
  optionsAction?: string;
  default?: string | number | boolean;
};

export type PluginManifestCollection = {
  /** Whether rows in this collection ride the sync layer to other devices. */
  sync: boolean;
};

/**
 * The JSON-Schema subset a plugin may use to describe a tool's arguments.
 *
 * Deliberately a closed union rather than "any JSON Schema". The declaration
 * travels through four different runtime transports, each of which needs a
 * different projection of it — a Zod object with a readable `.shape` (Droid and
 * the HTTP MCP lease), a Zod schema Claude's SDK can validate against, and a
 * JSON Schema regenerated from that Zod (Codex). A closed union makes the
 * conversion total: every declared property has exactly one Zod spelling, so no
 * runtime ever receives a schema the others silently dropped a constraint from.
 *
 * Anything richer — `oneOf`, `$ref`, `pattern`, tuple `items` — is refused at
 * parse time rather than accepted and quietly ignored by three of the four.
 */
export type PluginManifestToolInputNode =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number" | "integer"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: PluginManifestToolInputNode }
  | { type: "object"; description?: string; properties: Record<string, PluginManifestToolInputNode>; required: string[] };

export type PluginManifestToolInput = {
  type: "object";
  properties: Record<string, PluginManifestToolInputNode>;
  required: string[];
};

/**
 * A tool the coding agent can call, served by this plugin.
 *
 * Declared in the manifest rather than registered by the running child on
 * purpose. Tool sets are built SYNCHRONOUSLY at session start — Claude bakes its
 * MCP servers into the query options once, at creation — so a list the child
 * publishes after it boots would be empty on every cold session and could never
 * appear on Claude at all without restarting the chat. The manifest is readable
 * off the install registry with no child running, which also means the tool list
 * follows install state exactly: disable a plugin and its tools are gone from
 * the next listing.
 */
export type PluginManifestTool = {
  /** Tool word. An agent sees `plugin__<pluginId>__<name>`. */
  name: string;
  description: string;
  input: PluginManifestToolInput;
  /** The plugin handler `plugin.invoke` calls. Defaults to `name`. */
  action: string;
};

export type PluginManifestTheme = {
  tokens: {
    dark?: Record<string, string>;
    light?: Record<string, string>;
  };
};

// ---------------------------------------------------------------------------
// Engine registrations: automations, search, keybindings
//
// Four declarations that are not placements. A socket says "draw me here"; each
// of these says "when X happens, ask me" — an automation trigger the rule
// builder can fire on, a step a rule can run, a provider universal search may
// query, a chord that invokes an action. They are declared in the manifest
// rather than registered by the running child for the reason `tools` gives at
// length: the rule builder, the shortcut listing and the search palette all
// have to describe a plugin that is installed but not currently running, and a
// list the child publishes at boot is empty exactly when the user is looking.
// It also makes uninstall a non-event — the declaration leaves with the
// install record, so nothing has to be swept.
// ---------------------------------------------------------------------------

/**
 * A trigger kind this plugin can fire, offered in the automations rule builder.
 *
 * The plugin does not describe *when* it fires; it fires it, through
 * `ade.automations.emitTrigger`. What the manifest supplies is the vocabulary
 * the builder needs to let a user pick it before the plugin has ever fired.
 */
export type PluginManifestAutomationTrigger = {
  /** Stable id. Rules store it, so renaming one orphans every rule using it. */
  id: string;
  label: string;
  description?: string;
};

/** A step a rule may run, invoking one of this plugin's actions. */
export type PluginManifestAutomationStep = {
  id: string;
  label: string;
  description?: string;
  /** The plugin handler `plugin.invoke` calls. Defaults to `id`. */
  action: string;
};

/**
 * A provider universal search may query live.
 *
 * Live rather than indexed, deliberately. A plugin's results are whatever its
 * own store says right now — an issue tracker's search is a network call, not a
 * copy — and an FTS row ADE wrote at install time would be stale in a way the
 * user reads as a bug. The cost of that choice is a latency budget, which is
 * why the query path drops a slow provider instead of waiting for it.
 */
export type PluginManifestSearchProvider = {
  id: string;
  /** Section heading for this provider's results. */
  label: string;
  /** The plugin handler `plugin.invoke` calls with `{ query }`. Defaults to `id`. */
  action: string;
};

/**
 * The hosts this plugin's own process may contact.
 *
 * Absent means NO outbound network, which is the default every plugin that has
 * never thought about it gets. The matching rule and the validator live in
 * `shared/plugins/network.ts`, shared with the child that enforces it.
 */
export type PluginManifestNetwork = {
  /** Lowercase hostnames, each optionally prefixed with one `*.` wildcard. */
  hosts: string[];
};

/**
 * Provider ids ADE's own API-key store holds a key for.
 *
 * The list mirrors `ENV_KEY_PROVIDERS` in `main/services/ai/apiKeyStore.ts`,
 * which is the store's own authority and cannot be imported here — it reaches
 * for `electron`, and this module is parsed by the CLI, the child runtime and
 * the renderer. `apiKeyStore.test.ts` pins the two lists together, so a
 * provider added there fails a test here rather than becoming a key no plugin
 * can ask for.
 */
export const PLUGIN_PROVIDER_KEY_IDS = [
  "anthropic",
  "cursor",
  "deepseek",
  "google",
  "groq",
  "mistral",
  "moonshotai",
  "openai",
  "openrouter",
  "together",
  "xai",
] as const;

export type PluginProviderKeyId = (typeof PLUGIN_PROVIDER_KEY_IDS)[number];

export function isPluginProviderKeyId(value: unknown): value is PluginProviderKeyId {
  return PLUGIN_PROVIDER_KEY_IDS.some((provider) => provider === value);
}

/** How a provider is written in a sentence a user reads. */
export const PLUGIN_PROVIDER_KEY_LABELS: Readonly<Record<PluginProviderKeyId, string>> = {
  anthropic: "Anthropic",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  moonshotai: "Moonshot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  together: "Together",
  xai: "xAI",
};

/**
 * One sign-in flow the HOST runs on this plugin's behalf.
 *
 * A plugin cannot do OAuth by itself and must not be able to. The child is a
 * plain Node process with no window and, on a phone, no process at all — so
 * every part of the dance that touches the user or the redirect belongs to the
 * host: it builds the authorize URL, it mints and verifies `state`, it owns the
 * loopback listener or the relay bounce, and it hands the plugin the callback
 * parameters as DATA. The plugin never sees a raw URL it forged, and the host
 * never sees the token — the exchange is the plugin's own network call against
 * a host it declared in `network`.
 *
 * Declared in the manifest, like every other engine registration, because the
 * install card has to be able to say "signs you in to Linear" before any code
 * runs, and because `authorizeUrl` is the one thing a runtime argument must
 * never be allowed to choose: a plugin that could pass its own authorize URL at
 * call time could send the user's browser anywhere and call it a sign-in.
 */
export type PluginManifestAuthSession = {
  /** Stable id. Named in `ade.auth.beginSession({ sessionId })`. */
  id: string;
  /**
   * The third party, as a person writes it: "Linear", "Jira", "GitHub".
   *
   * The install card's line is derived from this and nothing else, so it is a
   * display name and not a hostname — "Signs you in to Linear" is a sentence a
   * reader can act on where "signs you in to linear.app" is a fact they have to
   * translate first.
   */
  provider: string;
  /**
   * Where the host sends the browser. `https:` only, no query and no fragment.
   *
   * The query is the host's to build: it appends the plugin's own parameters
   * (`client_id`, `scope`, `code_challenge`), then its own `redirect_uri` and
   * `state`. A manifest carrying a query would let those two spellings fight,
   * and the loser would be whichever the provider read last.
   */
  authorizeUrl: string;
  /**
   * The PUBLIC OAuth client id of the app this plugin registered with the
   * provider.
   *
   * Optional, and it is a convenience rather than a gate: `beginSession` takes
   * `client_id` in `params` either way, and a plugin that computes it at
   * runtime — one client per region, one per self-hosted install — simply sends
   * it there instead. Declaring it puts the value in the manifest, where `ade
   * plugin doctor` can print it for a plugin that is installed and not running,
   * which is exactly when a user is setting the integration up.
   *
   * Public in the literal sense, and validated as such: it is a query parameter
   * of every authorize URL this flow will ever open. A client SECRET must never
   * appear here — a manifest ships inside the package and is world-readable, so
   * anything in it is disclosed to everyone who installs the plugin. A
   * confidential client's secret belongs in `ade.secrets`, set by the user, or
   * — better — nowhere, because PKCE exists precisely so a distributed client
   * does not need one.
   *
   * Official plugins that supersede a compiled ADE integration do not use this.
   * They borrow ADE's own registered client id at runtime through
   * `ade.auth.officialClient(provider)`, which no community plugin may call.
   */
  clientId?: string;
  /**
   * Which callback transports this flow supports, in no particular order.
   *
   * A flow with only `loopback` is desktop-only, and the phone is told so
   * rather than opening a browser it can never get back from. One with only
   * `app` works on every client, because the relay bounce is reachable from a
   * desktop browser too. Most real integrations declare both, because a desktop
   * loopback avoids a round trip through ADE's relay.
   */
  callbacks: PluginAuthCallbackKind[];
  /**
   * The loopback redirect this plugin registered with its provider.
   *
   * Required when `callbacks` includes `loopback` and dropped otherwise. The
   * port is DECLARED rather than allocated because every OAuth provider worth
   * integrating matches `redirect_uri` exactly: an ephemeral port would be a
   * redirect no provider ever accepts. Declaring it also makes the collision
   * visible on the install card instead of at the moment the user clicks
   * Connect.
   */
  loopback?: { port: number; path: string };
};

/**
 * How the redirect gets back to the host.
 *
 * `loopback` — the host binds `127.0.0.1:<port>` and catches the GET itself.
 * Desktop and any machine with a browser on it. Nothing leaves the machine.
 *
 * `app` — the redirect goes to ADE's relay, which is stateless and does one
 * thing: 302 the query string to `ade://plugin-auth`. The phone's in-app auth
 * session catches that scheme and posts the parameters back to the machine that
 * minted the flow. This is the same shape ADE's own Linear mobile sign-in uses
 * today, generalized so the relay route names no integration.
 */
export type PluginAuthCallbackKind = "loopback" | "app";

export const PLUGIN_AUTH_CALLBACK_KINDS: readonly PluginAuthCallbackKind[] = ["loopback", "app"] as const;

export function isPluginAuthCallbackKind(value: unknown): value is PluginAuthCallbackKind {
  return PLUGIN_AUTH_CALLBACK_KINDS.some((kind) => kind === value);
}

/**
 * One named webhook channel this plugin receives at ADE's relay.
 *
 * A channel is a URL, not a subscription: declaring `{ id: "status" }` makes
 * `{relay}/plugin/<pluginId>/webhook/status` accept posts for this plugin, and
 * the user pastes that URL into whatever third party sends them. The channel id
 * is what tells a plugin which of its integrations spoke, so a plugin watching
 * two products declares two channels rather than sniffing the body.
 *
 * Declared in the manifest, like every other engine registration, because the
 * URL has to be shown on the Marketplace page and printed by `ade plugin
 * doctor` for a plugin that is installed and NOT running — which is exactly
 * when the user is trying to set the integration up.
 *
 * The relay authenticates every post with the per-plugin secret ADE registered.
 * `verify` is a SECOND, independent check for a third party that signs with its
 * own secret (a Stripe signing secret, a Slack app secret): the host verifies
 * that signature itself, constant-time, before the delivery is allowed anywhere
 * near the plugin child. Absent means the relay's own check is the only one,
 * which is the Cursor Cloud arrangement — ADE generates the secret and the
 * third party signs with it.
 */
export type PluginManifestWebhookIngressChannel = {
  /** Stable id. It is IN the URL, so renaming one breaks a live integration. */
  id: string;
  label: string;
  description?: string;
  /**
   * Verify the third party's own signature over the raw body, host-side.
   *
   * `secretRef` names one of this plugin's own secrets (`ade.secrets`), never a
   * literal — a signing secret in a manifest would ship in the package.
   */
  verify?: {
    kind: "hmac-sha256";
    /** A `ade.secrets` name holding the shared signing secret. */
    secretRef: string;
    /**
     * Header carrying the signature. Defaults to `x-webhook-signature`.
     *
     * It must be one the relay keeps: `PLUGIN_WEBHOOK_STORED_HEADERS` in
     * `apps/webhook-relay/src/relay.ts` lists them, and everything else is
     * dropped before the delivery is written, so a header outside it can never
     * be verified. The list already carries the signature headers of the
     * providers a plugin is likely to receive.
     */
    header?: string;
    /** Prefix stripped before the hex compare. Defaults to `sha256=`. */
    prefix?: string;
  };
};

/**
 * What one declared chat runtime can actually do, so the host can refuse the
 * rest honestly instead of half-doing it.
 *
 * Every flag is required rather than optional-defaulting-true. A capability
 * this platform assumed and the plugin never implemented fails at the moment
 * the user reaches for it — mid-conversation, with a turn already sent — and
 * "the plugin did not declare interrupt" is a sentence the composer can show
 * BEFORE the user presses stop. Saying `false` is cheap; discovering it is not.
 */
export type PluginManifestChatRuntimeCapabilities = {
  /** The user may send a second turn into an existing conversation. */
  followUp: boolean;
  /** The user may stop a running turn, and the plugin will act on it. */
  interrupt: boolean;
  /** The plugin can backfill a conversation that started outside ADE. */
  hydrate: boolean;
  /** The plugin materializes files or branches into the lane. */
  artifacts: boolean;
};

/**
 * A conversation source this plugin serves — the seam that lets a plugin own
 * an ADE chat rather than merely put cards in one.
 *
 * Declared in the manifest, never registered at runtime, for the reason every
 * other engine registration gives: a session created last week must render
 * with its runtime's name today, on a client whose plugin child is not
 * running and may never run on that machine at all.
 *
 * A session bound to one of these carries `provider: "plugin"` and a
 * `runtimeRef` naming `{pluginId, runtimeId, externalId}`. The ID is stored on
 * every such session, so renaming one orphans its conversations exactly the
 * way renaming an automation trigger orphans rules.
 */
export type PluginManifestChatRuntime = {
  /** Stable id. Sessions store it; renaming one orphans its conversations. */
  id: string;
  /** "Cursor Cloud". The name the chat header and session row show. */
  displayName: string;
  /** Phosphor icon name, drawn beside the display name. */
  icon?: string;
  /** See {@link PluginManifestChatRuntimeCapabilities}. */
  capabilities: PluginManifestChatRuntimeCapabilities;
};

/** A keyboard shortcut invoking one of this plugin's actions. */
export type PluginManifestKeybinding = {
  /** The plugin handler `plugin.invoke` calls. */
  action: string;
  /** One chord, e.g. `"Mod+Shift+P"`. See `shared/plugins/keybindings.ts`. */
  binding: string;
  /** What the shortcut does, for the listing that shows it. */
  label: string;
};

// --------------------------- end engine registrations ----------------------

export type PluginManifest = {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon?: string;
  accent?: string;
  minAdeVersion?: string;
  vocabVersion: number;
  /**
   * Plugin-shipped mono glyphs, keyed by the suffix of a `brand:` token.
   *
   * `{ "linear": "icons/linear.svg" }` makes `icon: "brand:linear"` resolve to
   * that file, after the host sanitizes it. Closed-catalogue tokens
   * (`brand:cursor` and friends) still win when both exist. See
   * `vocabularyBrandIcons.ts`.
   */
  brandIcons?: Record<string, string>;
  /** Absent for UI-only plugins (themes, static panels) — they run no code. */
  entry?: string;
  surfaces: PluginManifestSurface[];
  panels: PluginManifestPanel[];
  sockets: PluginManifestSocket[];
  collections: Record<string, PluginManifestCollection>;
  settings: PluginManifestSetting[];
  /** Subcommand words reachable as `ade <name> <cmd>`. */
  cli: string[];
  /** Relative paths to agent-skill directories this plugin contributes. */
  skills: string[];
  /** Tools the coding agent can call, proxied to `plugin.invoke`. */
  tools: PluginManifestTool[];
  /** Trigger kinds the automations rule builder offers, fired by this plugin. */
  automationTriggers: PluginManifestAutomationTrigger[];
  /** Steps an automation rule may run against this plugin. */
  automationSteps: PluginManifestAutomationStep[];
  /** Providers universal search queries live. */
  searchProviders: PluginManifestSearchProvider[];
  /** Keyboard shortcuts invoking this plugin's actions. */
  keybindings: PluginManifestKeybinding[];
  /**
   * URL shapes that become smart-link chips. See `shared/plugins/urlMatchers.ts`.
   *
   * Always an array from the parser, optional on the type for the same reason
   * `chatRuntimes` is: a manifest literal written before the field existed still
   * satisfies the type, and every reader spells it `?? []`.
   */
  urlMatchers?: PluginManifestUrlMatcher[];
  /**
   * Conversation sources this plugin owns. See {@link PluginManifestChatRuntime}.
   *
   * Optional, and read it as `manifest.chatRuntimes ?? []`. The parser always
   * emits an array, but the type stays optional so the manifest literals
   * scattered through tests and fixtures — none of which owns a conversation —
   * do not each have to write `chatRuntimes: []`. Same reading as `network`
   * and `providerKeys`: absent means none, which is the safe answer.
   */
  chatRuntimes?: PluginManifestChatRuntime[];
  /**
   * Webhook channels this plugin receives at ADE's relay.
   *
   * `[]` — never `undefined` — for the overwhelming majority that receive
   * nothing, so every reader can ask `.length` without a guard. A plugin with
   * one or more channels gets a relay registration, a drain and a
   * `webhook.received` event; one with none costs the host nothing at all.
   */
  webhookIngress: PluginManifestWebhookIngressChannel[];
  /**
   * Hosts this plugin's child process may contact.
   *
   * Optional, and its absence is the SECURE reading rather than an unknown: a
   * manifest that says nothing about the network gets none. Normalized to
   * absent when the declared list is empty, so "no network" has one spelling.
   */
  network?: PluginManifestNetwork;
  /**
   * Providers whose ADE-stored API key this plugin asks to read.
   *
   * Optional for the same reason `theme` is: the overwhelming majority of
   * manifests declare none, and `undefined` keeps them out of every reader's
   * way. Read it as `manifest.providerKeys ?? []`.
   *
   * This is a genuine widening of what a plugin can reach — the key was given
   * to ADE, not to the plugin — so it is disclosed at install beside everything
   * else the package adds, and brokered one call at a time by the host.
   */
  providerKeys?: PluginProviderKeyId[];
  /**
   * Sign-in flows the host runs for this plugin. See {@link PluginManifestAuthSession}.
   *
   * Optional, and absence is the secure reading exactly as `network`'s is: a
   * manifest that declares no flow gets `ade.auth.beginSession` refused by
   * name, so a plugin cannot open a browser at a URL nobody disclosed.
   */
  authSessions?: PluginManifestAuthSession[];
  /**
   * Built-in surfaces whose ADE-held credential this plugin asks to inherit.
   *
   * This is the release-day field. `ade-linear` supersedes ADE's compiled
   * Linear integration, and every existing user already has a Linear token in
   * ADE's own credential store; without this the day the plugin ships is the
   * day all of them reconnect. Declaring it does not move anything — the host
   * asks the user once, names exactly what is handed over, and a refusal leaves
   * the plugin unconnected rather than broken.
   *
   * Optional, and absence means the plugin starts with nothing, which is what
   * every plugin that is not replacing a built-in should want.
   */
  credentialHandoff?: PluginBuiltinSurfaceId[];
  /**
   * Names of THIS PROJECT's ADE secrets (the ones the user imported from a
   * `.env`) that this plugin asks to read.
   *
   * Optional, and its absence is the SECURE reading, exactly as `network` is:
   * a manifest that says nothing about project secrets reads none of them, and
   * `project_secret.get` refuses the call by name.
   *
   * Names rather than a boolean because the action is called by name
   * (`project_secret.get { name }`), so the tighter shape is the one the call
   * already has — and because "reads your STRIPE_API_KEY" is a disclosure a
   * person can act on where "reads your project's secrets" is not.
   *
   * Read verb only. Writing, deleting, importing, exporting and LISTING the
   * project's secrets are refused to every plugin, declared or not: a plugin
   * has its own secret store (`ade.secrets.*`) for the things it owns.
   */
  projectSecrets?: string[];
  theme?: PluginManifestTheme;
  official: boolean;
};

export type PluginManifestParseResult = {
  /** Present whenever identity (`name` + `version`) parsed; may still have errors. */
  manifest: PluginManifest | null;
  /** Fatal problems: the field was known and malformed. */
  errors: string[];
  /** Non-fatal: a known field held an entry we dropped, or a key we ignored. */
  warnings: string[];
};

export function isValidPluginId(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ID_PATTERN.test(value);
}

export function isValidPluginVersion(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_VERSION_PATTERN.test(value);
}

/**
 * Guard for every manifest-declared path before it is joined to the plugin
 * root. Rejects absolute paths, `..` segments, backslashes, and control bytes.
 */
export function isSafePluginRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && PLUGIN_RELATIVE_PATH_PATTERN.test(value);
}

export function isAllowedPluginThemeToken(key: string): boolean {
  return typeof key === "string"
    && PLUGIN_THEME_TOKEN_NAME_PATTERN.test(key)
    && PLUGIN_THEME_TOKEN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const PLUGIN_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Mirrors `PLUGIN_RESERVED_ACTION_PREFIX` in `sdk.ts`, which cannot be imported
 * here — `sdk.ts` imports THIS module, and the cycle would be real at runtime.
 * `manifest.test.ts` pins the two together, so a change there fails a test here
 * rather than letting this parser accept a name the host's invoke door refuses.
 *
 * The whole `ade:` namespace belongs to ADE: the host's chat delivery rides the
 * same `invoke` frame a plugin's own actions do, and the action name is the
 * only thing that tells them apart.
 */
const RESERVED_ACTION_PREFIX = "ade:";

function isReservedPluginActionName(value: string): boolean {
  return value.trim().toLowerCase().startsWith(RESERVED_ACTION_PREFIX);
}

function parseIdentifier(value: unknown): string | null {
  const text = trimmedString(value);
  if (!text || text.length > 64) return null;
  // The `ade:` namespace belongs to the host — see
  // `PLUGIN_RESERVED_ACTION_PREFIX`. Checked here as well as at the invoke
  // door, and NOT left to the pattern below: `:` is outside the identifier
  // charset today, but a reservation that survives only by accident is a
  // reservation that reopens the first time somebody widens the charset.
  if (isReservedPluginActionName(text)) return null;
  return PLUGIN_IDENTIFIER_PATTERN.test(text) ? text : null;
}

/**
 * Ceilings for the two free-text identity fields every surface renders.
 *
 * These are the only strings a third party writes that reach a native
 * notification, a marketplace card, an agent tool description and the shortcut
 * list, so they are bounded here rather than at each of those call sites — the
 * desktop notification bridge already clamps its own copy to 48 characters, and
 * a value that survives the manifest untouched simply arrives at the next
 * renderer unclamped instead.
 */
export const PLUGIN_DISPLAY_NAME_MAX = 64;
export const PLUGIN_DESCRIPTION_MAX = 512;

/** The same ceilings for a single engine registration's own label and blurb. */
export const PLUGIN_DECLARATION_LABEL_MAX = 120;

/**
 * The longest public OAuth client id a manifest may declare.
 *
 * Generous next to the real ones — Linear's is 32 hex characters, Google's is
 * about 72 — and it is a bound rather than a format because every provider
 * spells these differently. It exists so an over-long value is refused where a
 * reader can see why, rather than becoming a query parameter that pushes the
 * origin off the end of a phone's address bar.
 */
export const PLUGIN_AUTH_CLIENT_ID_MAX = 256;
export const PLUGIN_DECLARATION_DESCRIPTION_MAX = 240;

/**
 * The most entries this parser will look at in any one manifest array.
 *
 * Per-field maxima live in {@link limitDeclarations}, which reports one warning
 * per over-cap entry — correct for a manifest that declares nine sockets where
 * eight are allowed, and a 25× byte amplification for one that declares a
 * hundred thousand. This ceiling is refused once, before the per-entry loop.
 */
const PLUGIN_MANIFEST_ARRAY_MAX = 512;

/**
 * Trimmed, whitespace-collapsed and cut to `max` — shortened rather than
 * refused, because a plugin whose name is one character too long should still
 * install with a clipped name rather than fall back to its bare id.
 *
 * The newline collapse is the load-bearing half. `displayName` is interpolated
 * into every agent tool description this plugin contributes ("provided by the
 * X plugin"), which is model-visible text in the system prompt of every session
 * on the machine; a multi-line value there reads to the model as structure the
 * plugin did not earn.
 */
function singleLine(value: unknown, max: number): string | null {
  const text = trimmedString(value);
  if (text === null) return null;
  const collapsed = text.replace(/\s+/gu, " ");
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max);
}

/**
 * The same rule {@link parseIdentifier} applies, for layers that need to judge
 * a panel or socket id they did not parse. Exported so there is ONE spelling:
 * a second regex at the IPC boundary disagreed with this one by a length cap,
 * so an id this parser accepted that layer refused.
 */
export function isValidPluginManifestIdentifier(value: unknown): value is string {
  return parseIdentifier(value) !== null;
}

/**
 * `official` gates `builtin`, and it is worth being precise about what that
 * gate is and is not.
 *
 * It is NOT proof of provenance: `official` is a field the manifest sets about
 * itself, and this parser is pure — it has no directory, no signature and no
 * filesystem. Provenance is established elsewhere, by the directory entry the
 * installer checks (`registryIndex.ts`: an official entry carries a per-version
 * sha256 that must match the fetched tree).
 *
 * What the gate buys is a floor: a manifest that does not even claim official
 * tier cannot claim a compiled-in tab, so a copied or mistyped manifest fails
 * loudly here instead of quietly taking over a rail item. And the ceiling on
 * getting it wrong is deliberately low — `builtin` decides whether one of the
 * user's OWN pages appears in their OWN rail, and names a route from a closed
 * list. It runs no code, reads no data and reaches nothing the app was not
 * already shipping.
 */
function parseSurfaces(raw: unknown, ctx: ParseContext, official: boolean): PluginManifestSurface[] {
  return parseArray(raw, "surfaces", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const kind = SURFACE_KINDS.find((candidate) => candidate === entry.kind) ?? null;
    if (!kind) return ctx.drop(`${label}.kind must be "tab", "pane" or "webview"`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const title = trimmedString(entry.title);
    if (!title) return ctx.drop(`${label}.title is required`);
    const panelId = parseIdentifier(entry.panelId);
    if (!panelId) return ctx.drop(`${label}.panelId is missing or not an identifier`);
    let entryHtml: string | null = null;
    const declaredEntryHtml = entry.entryHtml;
    if (kind === "webview") {
      // Dropped, not warned: a webview surface with no page is not a degraded
      // surface, it is a surface that would load nothing.
      if (!isSafePluginRelativePath(declaredEntryHtml)) {
        return ctx.drop(`${label}.entryHtml must be a relative path inside the plugin`);
      }
      if (!/\.html?$/i.test(declaredEntryHtml)) {
        return ctx.drop(`${label}.entryHtml must name an .html file`);
      }
      entryHtml = declaredEntryHtml;
    } else if (declaredEntryHtml !== undefined) {
      ctx.warnings.push(`${label}.entryHtml applies only to a "webview" surface — ignored`);
    }
    let builtin: PluginBuiltinSurfaceId | null = null;
    if (entry.builtin !== undefined) {
      const requested = trimmedString(entry.builtin);
      if (!isPluginBuiltinSurfaceId(requested)) {
        ctx.warnings.push(`${label}.builtin "${String(entry.builtin)}" is not a gateable built-in tab — ignored`);
      } else if (!official) {
        ctx.warnings.push(`${label}.builtin is honoured only for official plugins — ignored`);
      } else if (kind === "webview") {
        // A gate draws nothing; a webview draws everything. Honouring both would
        // ask the client which of the two pages it is looking at.
        ctx.warnings.push(`${label}.builtin cannot be combined with a "webview" surface — ignored`);
      } else if (PLUGIN_BUILTIN_SURFACE_PRESENCE[requested] === "supersedes") {
        // `builtin` means "ADE draws its compiled page in my place". A plugin
        // that SUPERSEDES a surface is doing the opposite — it brings its own
        // panels and the compiled page steps aside — so honouring the field
        // here would suppress the plugin's own rail item (see
        // `pluginOwnsBuiltinTab`) and leave the product with neither page.
        ctx.warnings.push(
          `${label}.builtin "${requested}" is a superseded surface — the plugin draws its own panels, so the field is ignored`,
        );
      } else {
        builtin = requested;
      }
    }
    // A `pane` draws NOTHING on its own, and never did.
    //
    // The kind is meaningful in exactly one shape: as the form of a COMPILED
    // pane an official plugin gates. Linear, the iOS simulator and Electron
    // Control all live inside Work rather than at a route, and `pane` is how
    // their manifests say so — but the drawing there is ADE's, not the
    // plugin's, and the gate is the `builtin` field.
    //
    // A `pane` with no honoured `builtin` reached no client at all. The
    // desktop rail reads `work-rail-pane` SOCKETS and never looks at
    // `surfaces[]`; the phone's plugin menu keys off panel count; and the
    // preload's rail mapper keeps only `tab` and `webview`. Meanwhile the
    // install card disclosed it ("Adds: … pane") and `doctor` stayed green.
    // A surface nothing can draw, promised to the user at install time, is the
    // "green while broken" state the rest of this taxonomy exists to prevent —
    // so it is refused here, by name, with the replacement in the message.
    if (kind === "pane" && !builtin) {
      return ctx.drop(
        `${label}.kind "pane" is not drawn by any client on its own`
        + ` — declare a "work-rail-pane" socket for panel "${panelId}" instead`,
      );
    }
    // `mobile` is a narrowing switch, not a grant. The ceiling comes from what
    // the surface IS — a webview draws a desktop-only page, a gated built-in
    // draws whatever compiled page the phone ships for it — and the manifest may
    // only turn a mobile-capable surface off. A malformed value is treated as
    // absent rather than fatal: it costs the author a default, not a plugin.
    let declaredMobile: boolean | null = null;
    if (entry.mobile !== undefined) {
      if (typeof entry.mobile === "boolean") {
        declaredMobile = entry.mobile;
      } else {
        ctx.warnings.push(`${label}.mobile must be true or false — ignored`);
      }
    }
    const mobileCeiling = kind === "webview"
      ? false
      : builtin
        ? PLUGIN_BUILTIN_SURFACE_MOBILE[builtin]
        : true;
    if (declaredMobile === true && !mobileCeiling) {
      ctx.warnings.push(
        kind === "webview"
          ? `${label}.mobile cannot be true on a "webview" surface — the phone renders its panelId panel instead`
          : `${label}.mobile cannot be true for the built-in "${String(builtin)}" surface, which the phone has no page for — ignored`,
      );
    }
    return {
      kind,
      id,
      title,
      panelId,
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
      ...(builtin ? { builtin } : {}),
      ...(entryHtml ? { entryHtml } : {}),
      mobile: mobileCeiling && (declaredMobile ?? true),
    };
  });
}

/**
 * Whether the phone should LIST the panel a surface names.
 *
 * Not the same question as `surface.mobile`, and the webview is why. A webview
 * page is desktop-only by construction, but the panel it names is exactly what
 * every non-desktop client renders in its place — filtering that panel out would
 * delete the fallback the surface exists to provide. A gated built-in has no
 * such consolation: the phone either ships the compiled page or has nothing at
 * all to show, so there the surface's answer is the panel's answer.
 *
 * Exported because two layers ask it — the panel seeder and the SDK's
 * `panels.update` — and a second spelling of this rule is a second answer.
 */
export function pluginPanelShowsOnMobile(surface: PluginManifestSurface): boolean {
  if (surface.kind === "webview") return true;
  return surface.mobile !== false;
}

function parsePanels(raw: unknown, ctx: ParseContext): PluginManifestPanel[] {
  return parseArray(raw, "panels", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const schemaFile = entry.schemaFile === undefined ? null : entry.schemaFile;
    if (schemaFile !== null && !isSafePluginRelativePath(schemaFile)) {
      return ctx.drop(`${label}.schemaFile must be a relative path inside the plugin`);
    }
    // A malformed refresh action drops to no refresh rather than dropping the
    // panel: a panel that cannot be refreshed by gesture is still a perfectly
    // good panel, and the same judgement `menu` and `color` get on a socket.
    const refreshAction = parseIdentifier(entry.refreshAction);
    return {
      id,
      ...(schemaFile !== null ? { schemaFile: schemaFile as string } : {}),
      ...(trimmedString(entry.title) ? { title: trimmedString(entry.title)! } : {}),
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(refreshAction ? { refreshAction } : {}),
    };
  });
}

function parseSockets(raw: unknown, ctx: ParseContext): PluginManifestSocket[] {
  return parseArray(raw, "sockets", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const socket = oneOf(entry.socket, PLUGIN_SOCKET_KINDS);
    if (!socket) return ctx.drop(`${label}.socket is not a known socket kind`);
    const surface = oneOf(entry.surface, PLUGIN_SURFACE_IDS);
    if (!surface) return ctx.drop(`${label}.surface is not a core surface`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const panelId = entry.panelId === undefined ? null : parseIdentifier(entry.panelId);
    if (entry.panelId !== undefined && !panelId) return ctx.drop(`${label}.panelId is not an identifier`);
    const actionId = entry.actionId === undefined ? null : parseIdentifier(entry.actionId);
    if (entry.actionId !== undefined && !actionId) return ctx.drop(`${label}.actionId is not an identifier`);
    const extensions = entry.extensions === undefined
      ? null
      : Array.isArray(entry.extensions)
        ? entry.extensions
          .map((value) => trimmedString(value)?.toLowerCase() ?? null)
          .filter((value): value is string => Boolean(value) && value!.startsWith("."))
        : null;
    if (entry.extensions !== undefined && extensions === null) {
      return ctx.drop(`${label}.extensions must be an array of ".ext" strings`);
    }
    const declaredLabel = trimmedString(entry.label);
    // Through the shared parser rather than a local read, so a manifest-declared
    // split button and a published one are capped and bounded identically. A
    // malformed menu yields `[]` and the entry stays a plain button.
    const menu = parsePluginActionButtonMenu(entry.menu);
    // Through the shared sanitizer for the same reason: one gate decides what
    // a legible button tint is, so a declared colour and a published one are
    // accepted or refused identically.
    const color = sanitizePluginActionColor(entry.color);
    // Warned rather than dropped in silence. The gate is right to refuse an
    // illegible tint and right to fall back to the platform's own tone — but
    // the manifest still parses clean, so an author who picked a colour that
    // failed the contrast check saw no log line, no doctor rung and no
    // difference they could account for. `accent` already errors on a bad hex;
    // this is the same fact one field over, at the severity that matches a
    // field the plugin can lose without losing the socket.
    if (entry.color !== undefined && !color) {
      ctx.warnings.push(
        `${label}.color "${String(entry.color)}" is not a legible button tint —`
        + " it must be a hex colour with enough contrast on both the light and dark"
        + " backdrop; the platform's own tone is used instead",
      );
    }
    // Read for every entry, meaningful to one kind each. A malformed value is
    // dropped to null here and then refused below by the same requirement loop
    // the four core fields go through, so `command: "Fix It!"` fails with the
    // kind named rather than installing as a socket with no command.
    const command = entry.command === undefined ? null : normalizePluginSlashCommand(entry.command);
    if (entry.command !== undefined && !command) {
      return ctx.drop(`${label}.command must be a lowercase word like "fix" or "run-tests"`);
    }
    const dialog = entry.dialog === undefined ? null : isPluginDialogKind(entry.dialog) ? entry.dialog : null;
    if (entry.dialog !== undefined && !dialog) return ctx.drop(`${label}.dialog is not a known dialog`);
    // A socket that renders nothing and invokes nothing is a manifest typo, not
    // a contribution. Refusing it here is what keeps empty rows off the surface.
    // The requirement table is shared with the payload validator and the
    // renderer's manifest→payload mapping, so "parses clean but contributes
    // nothing" — the old failure for a badge with no label — cannot recur.
    const present: Record<PluginSocketRequirementField, boolean> = {
      label: declaredLabel !== null,
      actionId: actionId !== null,
      panelId: panelId !== null,
      extensions: Boolean(extensions && extensions.length > 0),
    };
    // Held apart from the four above because they mean nothing to any other
    // kind — see PluginSocketExtraField. Enforced by the same rule, though: a
    // `slash-command` with no `command` is as empty as a badge with no label.
    const presentExtra: Record<PluginSocketExtraField, boolean> = {
      command: command !== null,
      dialog: dialog !== null,
    };
    for (const field of PLUGIN_SOCKET_REQUIREMENTS[socket].manifest) {
      if (!present[field]) return ctx.drop(`${label} requires ${field} for socket "${socket}"`);
    }
    for (const field of PLUGIN_SOCKET_REQUIREMENTS[socket].manifestExtra ?? []) {
      if (!presentExtra[field]) return ctx.drop(`${label} requires ${field} for socket "${socket}"`);
    }
    return {
      socket,
      surface,
      id,
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
      ...(declaredLabel ? { label: declaredLabel } : {}),
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(panelId ? { panelId } : {}),
      ...(actionId ? { actionId } : {}),
      ...(menu.length > 0 ? { menu } : {}),
      ...(color ? { color } : {}),
      ...(extensions && extensions.length ? { extensions } : {}),
      ...(trimmedString(entry.filterKey) ? { filterKey: trimmedString(entry.filterKey)! } : {}),
      ...(command ? { command } : {}),
      ...(dialog ? { dialog } : {}),
      ...(trimmedString(entry.description) ? { description: trimmedString(entry.description)! } : {}),
      ...(trimmedString(entry.argumentHint) ? { argumentHint: trimmedString(entry.argumentHint)! } : {}),
      ...(trimmedString(entry.section) ? { section: trimmedString(entry.section)! } : {}),
    };
  });
}

function parseSettings(raw: unknown, ctx: ParseContext): PluginManifestSetting[] {
  const kinds: PluginSettingKind[] = ["text", "secret", "select", "toggle", "number"];
  return parseArray(raw, "settings", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const key = parseIdentifier(entry.key);
    if (!key) return ctx.drop(`${label}.key is missing or not an identifier`);
    const kind = kinds.find((candidate) => candidate === entry.kind);
    if (!kind) return ctx.drop(`${label}.kind is not a known setting kind`);
    const settingLabel = trimmedString(entry.label);
    if (!settingLabel) return ctx.drop(`${label}.label is required`);
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
        if (!isRecord(option)) return [];
        const value = trimmedString(option.value);
        const optionLabel = trimmedString(option.label) ?? value;
        return value && optionLabel ? [{ value, label: optionLabel }] : [];
      })
      : null;
    const optionsAction = entry.optionsAction === undefined ? null : parseIdentifier(entry.optionsAction);
    const defaultValue = typeof entry.default === "string"
      || typeof entry.default === "number"
      || typeof entry.default === "boolean"
      ? entry.default
      : null;
    return {
      key,
      kind,
      label: settingLabel,
      ...(trimmedString(entry.description) ? { description: trimmedString(entry.description)! } : {}),
      ...(options && options.length ? { options } : {}),
      ...(optionsAction ? { optionsAction } : {}),
      ...(defaultValue !== null ? { default: defaultValue } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Engine registrations: parsing
//
// One shape for all four — `{ id, label, action? }` with a per-plugin ceiling
// and a duplicate sweep — because they are the same kind of promise and a user
// reading a manifest should not have to learn four spellings of it.
// ---------------------------------------------------------------------------

/** Eight distinct things worth automating is already a large plugin. */
const PLUGIN_AUTOMATION_TRIGGERS_PER_PLUGIN = 8;
const PLUGIN_AUTOMATION_STEPS_PER_PLUGIN = 12;

/**
 * Search providers are capped hard because every one of them is a live invoke
 * on a debounced keystroke: the palette's whole latency budget is shared
 * between them, so a plugin with six providers is a plugin that makes search
 * feel broken. A plugin that needs to search several things searches them
 * inside one provider, where it — not the palette — pays for the fan-out.
 */
const PLUGIN_SEARCH_PROVIDERS_PER_PLUGIN = 2;

/**
 * Chords are a scarce shared resource in a way panels are not: there is exactly
 * one keyboard, every plugin wants the memorable half of it, and the user
 * cannot see who took what until they press it.
 */
const PLUGIN_KEYBINDINGS_PER_PLUGIN = 6;

/**
 * Ingress channels are capped low because each one is a public URL the relay
 * answers forever and a row the host polls for on every drain tick. A plugin
 * that needs to tell six integrations apart puts the discriminator in the path
 * it gives them, not in six registrations.
 */
const PLUGIN_WEBHOOK_CHANNELS_PER_PLUGIN = 4;

/**
 * A channel id is a relay path segment, so it is narrower than an ADE
 * identifier: lowercase, digits and hyphens, starting with a letter. Kept in
 * step with `PLUGIN_CHANNEL_PATTERN` in `apps/webhook-relay/src/relay.ts`, which
 * is the side that returns the 404.
 */
export const PLUGIN_WEBHOOK_CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Mirrors `PLUGIN_SECRET_NAME_PATTERN` in `sdk.ts`, which cannot be imported
 * here — `sdk.ts` imports THIS module, and the cycle would be real at runtime.
 * `manifest.test.ts` pins the two together, so a change there fails a test here
 * rather than letting a `secretRef` this parser accepts be refused by the
 * secret store that has to read it.
 */
const PLUGIN_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/**
 * Mirrors `PLUGIN_WEBHOOK_SECRET_NAME` in `sdk.ts`, for the same cycle reason
 * as the pattern above. It is the name the host generates the relay
 * registration secret under, and no plugin may read, write or point `verify`
 * at it. `manifest.test.ts` pins the two spellings together.
 */
const PLUGIN_RESERVED_WEBHOOK_SECRET_NAME = "ADE_WEBHOOK_RELAY_SECRET";

/**
 * Drop entries past a per-plugin ceiling, and entries whose key repeats.
 *
 * Both refusals are warnings rather than errors: a plugin that declares one
 * trigger too many is still a working plugin, and refusing to install it would
 * turn a manifest typo into a dead marketplace listing.
 */
function limitDeclarations<T>(
  entries: T[],
  field: string,
  max: number,
  keyOf: (entry: T) => string,
  ctx: ParseContext,
): T[] {
  const unique: T[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (seen.has(key)) {
      ctx.drop(`${field} declares "${key}" more than once`);
      continue;
    }
    if (unique.length >= max) {
      ctx.drop(`${field} declares more than ${max} entries`);
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

/** `{ id, label, description?, action? }`, shared by three of the four. */
function parseLabelledDeclarations(
  raw: unknown,
  field: string,
  ctx: ParseContext,
  options: { action: boolean },
): { id: string; label: string; description?: string; action: string }[] {
  return parseArray(raw, field, ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    // Bounded, unlike the socket labels beside them: these two strings have no
    // payload parser downstream to clamp them, so they reach the automation
    // rule-builder pickers and the shortcut list exactly as written. They were
    // the last unbounded free text on the manifest.
    const entryLabel = singleLine(entry.label, PLUGIN_DECLARATION_LABEL_MAX);
    if (!entryLabel) return ctx.drop(`${label}.label is required`);
    // `action` defaults to `id` so the common case — one handler per
    // declaration, named after it — needs no second field.
    const action = options.action ? (parseIdentifier(entry.action) ?? id) : id;
    if (options.action && entry.action !== undefined && !parseIdentifier(entry.action)) {
      return ctx.drop(`${label}.action is not an identifier`);
    }
    const entryDescription = singleLine(entry.description, PLUGIN_DECLARATION_DESCRIPTION_MAX);
    return {
      id,
      label: entryLabel,
      ...(entryDescription ? { description: entryDescription } : {}),
      action,
    };
  });
}

function parseAutomationTriggers(raw: unknown, ctx: ParseContext): PluginManifestAutomationTrigger[] {
  const entries = parseLabelledDeclarations(raw, "automationTriggers", ctx, { action: false })
    .map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) }));
  return limitDeclarations(entries, "automationTriggers", PLUGIN_AUTOMATION_TRIGGERS_PER_PLUGIN, (e) => e.id, ctx);
}

function parseAutomationSteps(raw: unknown, ctx: ParseContext): PluginManifestAutomationStep[] {
  const entries = parseLabelledDeclarations(raw, "automationSteps", ctx, { action: true });
  return limitDeclarations(entries, "automationSteps", PLUGIN_AUTOMATION_STEPS_PER_PLUGIN, (e) => e.id, ctx);
}

/**
 * The most conversation sources one plugin may own.
 *
 * Two, not eight. A chat runtime is not a placement — it is a claim on the
 * user's chat surface, and a plugin declaring a shelf of them is describing a
 * platform rather than a product. Cursor Cloud, the plugin this seam was built
 * for, declares exactly one.
 */
const PLUGIN_CHAT_RUNTIMES_PER_PLUGIN = 2;

/**
 * Read `capabilities`, refusing an absent or partial one.
 *
 * A missing flag is an error rather than a default, because both defaults are
 * wrong: defaulting true promises the user something the plugin never wrote,
 * and defaulting false silently disables a capability the author believed they
 * had shipped. The manifest is the contract, so it has to say all four.
 */
function parseChatRuntimeCapabilities(
  raw: unknown,
  label: string,
  ctx: ParseContext,
): PluginManifestChatRuntimeCapabilities | null {
  if (!isRecord(raw)) {
    ctx.drop(`${label}.capabilities is missing or not an object`);
    return null;
  }
  const flags: (keyof PluginManifestChatRuntimeCapabilities)[] = ["followUp", "interrupt", "hydrate", "artifacts"];
  const parsed: Partial<PluginManifestChatRuntimeCapabilities> = {};
  for (const flag of flags) {
    const value = raw[flag];
    if (typeof value !== "boolean") {
      ctx.drop(`${label}.capabilities.${flag} must be true or false`);
      return null;
    }
    parsed[flag] = value;
  }
  return parsed as PluginManifestChatRuntimeCapabilities;
}

function parseChatRuntimes(raw: unknown, ctx: ParseContext): PluginManifestChatRuntime[] {
  const entries = parseArray(raw, "chatRuntimes", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const displayName = singleLine(entry.displayName, PLUGIN_DECLARATION_LABEL_MAX);
    if (!displayName) return ctx.drop(`${label}.displayName is required`);
    const capabilities = parseChatRuntimeCapabilities(entry.capabilities, label, ctx);
    if (!capabilities) return null;
    const icon = trimmedString(entry.icon);
    return {
      id,
      displayName,
      ...(icon ? { icon } : {}),
      capabilities,
    } satisfies PluginManifestChatRuntime;
  });
  return limitDeclarations(entries, "chatRuntimes", PLUGIN_CHAT_RUNTIMES_PER_PLUGIN, (entry) => entry.id, ctx);
}

function parseSearchProviders(raw: unknown, ctx: ParseContext): PluginManifestSearchProvider[] {
  const entries = parseLabelledDeclarations(raw, "searchProviders", ctx, { action: true })
    .map(({ id, label, action }) => ({ id, label, action }));
  return limitDeclarations(entries, "searchProviders", PLUGIN_SEARCH_PROVIDERS_PER_PLUGIN, (e) => e.id, ctx);
}

/**
 * The most providers one plugin may ask for.
 *
 * Low on purpose. A plugin that names one provider is describing what it is; a
 * plugin that names six is asking for the user's whole wallet, and the install
 * card would read as a list nobody finishes.
 */
const PLUGIN_PROVIDER_KEYS_PER_PLUGIN = 4;

/**
 * `network: { hosts: [...] }`.
 *
 * A malformed CONTAINER is an error, because a plugin that meant to declare a
 * host and mistyped the shape would otherwise install with no network and fail
 * at its first request with a refusal that names the wrong cause. A malformed
 * ENTRY is a dropped warning like every other list here: the plugin still
 * installs, and the host it got wrong is refused at runtime by name.
 */
function parseNetwork(raw: unknown, ctx: ParseContext): PluginManifestNetwork | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    ctx.errors.push("network must be an object with a hosts array");
    return null;
  }
  const hosts = parseStringList(raw.hosts, "network.hosts", ctx, isValidPluginNetworkHost);
  const limited = limitDeclarations(
    hosts,
    "network.hosts",
    PLUGIN_NETWORK_HOSTS_MAX,
    (host) => host,
    ctx,
  );
  // An empty list and an absent field are the same permission, and giving them
  // one representation means no reader has to know both.
  return limited.length > 0 ? { hosts: limited } : null;
}

/**
 * The most project secrets one plugin may ask to read.
 *
 * The same reasoning as `PLUGIN_PROVIDER_KEYS_PER_PLUGIN`, one notch higher: a
 * plugin naming two or three keys is describing an integration, and one naming
 * a dozen is asking for the project's whole `.env` a name at a time. The
 * install card has to stay a list a person finishes reading.
 */
const PLUGIN_PROJECT_SECRETS_PER_PLUGIN = 6;

/**
 * `projectSecrets: ["STRIPE_API_KEY"]`, checked against the secret store's own
 * name rule so a manifest cannot declare a name the store could never hold.
 */
function parseProjectSecrets(raw: unknown, ctx: ParseContext): string[] {
  const names = parseStringList(raw, "projectSecrets", ctx, isValidProjectSecretName);
  return limitDeclarations(
    names,
    "projectSecrets",
    PLUGIN_PROJECT_SECRETS_PER_PLUGIN,
    (name) => name,
    ctx,
  );
}

/** `providerKeys: ["cursor"]`, checked against the store's own provider ids. */
function parseProviderKeys(raw: unknown, ctx: ParseContext): PluginProviderKeyId[] {
  const providers = parseStringList(raw, "providerKeys", ctx, isPluginProviderKeyId);
  return limitDeclarations(
    providers as PluginProviderKeyId[],
    "providerKeys",
    PLUGIN_PROVIDER_KEYS_PER_PLUGIN,
    (provider) => provider,
    ctx,
  );
}

/**
 * The most sign-in flows one plugin may declare.
 *
 * Two, because a real integration has one — and the second slot exists for the
 * plugin that talks to a product's cloud AND its self-hosted twin. A plugin
 * asking for more is describing an auth broker rather than an integration, and
 * every extra flow is another authorize URL on the install card.
 */
const PLUGIN_AUTH_SESSIONS_PER_PLUGIN = 2;

/**
 * The ports a loopback redirect may claim.
 *
 * Above the privileged range, because the host binds this as the user and a
 * manifest asking for port 80 is asking for a failure. Nothing narrower is
 * enforced: which high port an OAuth provider has on file is the provider's
 * business, and a guess here would refuse a manifest that works.
 */
const PLUGIN_AUTH_LOOPBACK_PORT_MIN = 1024;
const PLUGIN_AUTH_LOOPBACK_PORT_MAX = 65535;

/** `/oauth/callback` — one leading slash, no query, no fragment, no traversal. */
const PLUGIN_AUTH_LOOPBACK_PATH_PATTERN = /^\/[A-Za-z0-9._~\-/]{0,127}$/;

/**
 * An `https:` origin plus path, with nothing a runtime argument could hide in.
 *
 * Userinfo is refused outright: `https://evil.com@linear.app/oauth` reads as
 * Linear to a person skimming the install card and resolves to `evil.com` in
 * every browser, which is the exact confusion this field exists to prevent.
 */
function parseAuthorizeUrl(raw: unknown, label: string, ctx: ParseContext): string | null {
  const text = trimmedString(raw);
  if (!text) return ctx.drop(`${label}.authorizeUrl is required`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return ctx.drop(`${label}.authorizeUrl is not a URL`);
  }
  if (url.protocol !== "https:") return ctx.drop(`${label}.authorizeUrl must be https`);
  if (url.username || url.password) return ctx.drop(`${label}.authorizeUrl must not carry a username or password`);
  if (url.search || url.hash) {
    return ctx.drop(`${label}.authorizeUrl must not carry a query or fragment — the host builds those`);
  }
  return url.toString();
}

/** `authSessions: [{ id, provider, authorizeUrl, callbacks, loopback? }]`. */
function parseAuthSessions(raw: unknown, ctx: ParseContext): PluginManifestAuthSession[] {
  const entries = parseArray(raw, "authSessions", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const provider = singleLine(entry.provider, PLUGIN_DECLARATION_LABEL_MAX);
    if (!provider) return ctx.drop(`${label}.provider is required`);
    const authorizeUrl = parseAuthorizeUrl(entry.authorizeUrl, label, ctx);
    if (!authorizeUrl) return null;

    // Optional, so an absent field is not a drop. A PRESENT one that is empty
    // or over-long IS a drop rather than a silent omission: a plugin that
    // declared a client id and got none would build an authorize URL missing
    // the one parameter the provider identifies it by, and the symptom would be
    // a provider error page the plugin cannot see.
    let clientId: string | undefined;
    if (entry.clientId !== undefined && entry.clientId !== null) {
      // NOT `singleLine`, which clips to the bound. A clipped client id is
      // worse than no client id: it is a value the plugin would send and the
      // provider would refuse, and the author would be debugging a rejected
      // authorization rather than reading a manifest warning.
      const parsed = trimmedString(entry.clientId);
      if (!parsed || parsed.length > PLUGIN_AUTH_CLIENT_ID_MAX || /\s/u.test(parsed)) {
        return ctx.drop(
          `${label}.clientId must be a non-empty string of at most`
            + ` ${PLUGIN_AUTH_CLIENT_ID_MAX} characters with no whitespace`,
        );
      }
      clientId = parsed;
    }

    const callbacks = parseArray(entry.callbacks, `${label}.callbacks`, ctx, (value, valueLabel) => (
      isPluginAuthCallbackKind(value) ? value : ctx.drop(`${valueLabel} is not a callback kind`)
    ));
    const unique = [...new Set(callbacks)];
    if (unique.length === 0) {
      return ctx.drop(`${label}.callbacks must name at least one of "loopback" or "app"`);
    }

    let loopback: PluginManifestAuthSession["loopback"];
    if (unique.includes("loopback")) {
      // Dropped as a WHOLE flow rather than silently downgraded to `app`. A
      // plugin that asked for a loopback and got a relay bounce would send its
      // users to a redirect URI the provider has never heard of, and the only
      // symptom would be a provider error page the plugin cannot see.
      if (!isRecord(entry.loopback)) {
        return ctx.drop(`${label}.loopback is required when "loopback" is a callback`);
      }
      const port = entry.loopback.port;
      if (typeof port !== "number" || !Number.isInteger(port)
        || port < PLUGIN_AUTH_LOOPBACK_PORT_MIN || port > PLUGIN_AUTH_LOOPBACK_PORT_MAX) {
        return ctx.drop(
          `${label}.loopback.port must be an integer between ${PLUGIN_AUTH_LOOPBACK_PORT_MIN}`
            + ` and ${PLUGIN_AUTH_LOOPBACK_PORT_MAX}`,
        );
      }
      const path = trimmedString(entry.loopback.path);
      if (!path || !PLUGIN_AUTH_LOOPBACK_PATH_PATTERN.test(path)) {
        return ctx.drop(`${label}.loopback.path must be an absolute path like "/oauth/callback"`);
      }
      loopback = { port, path };
    }

    return {
      id,
      provider,
      authorizeUrl,
      ...(clientId ? { clientId } : {}),
      callbacks: unique,
      ...(loopback ? { loopback } : {}),
    };
  });
  return limitDeclarations(entries, "authSessions", PLUGIN_AUTH_SESSIONS_PER_PLUGIN, (entry) => entry.id, ctx);
}

/**
 * The most built-in credentials one plugin may ask ADE to hand over.
 *
 * Two, and it should almost always be one: a plugin declares the credential of
 * the surface it supersedes. There is no plugin whose honest story needs three.
 */
const PLUGIN_CREDENTIAL_HANDOFFS_PER_PLUGIN = 2;

/**
 * `credentialHandoff: ["linear"]`.
 *
 * Official-only for the same reason `surfaces[].builtin` is: this names a
 * credential ADE already holds, and a community package that could name one
 * would be asking the user to approve a card about a connection it had nothing
 * to do with. WHICH official plugin may name a given surface is not decided
 * here — the owner table lives in `builtinSurfaces.ts`, which imports this
 * module, so the host does that check and refuses a non-owner.
 */
function parseCredentialHandoff(raw: unknown, ctx: ParseContext, official: boolean): PluginBuiltinSurfaceId[] {
  const ids = parseArray(raw, "credentialHandoff", ctx, (entry, label) => {
    const text = trimmedString(entry);
    if (!text || !isPluginBuiltinSurfaceId(text)) {
      return ctx.drop(`${label} is not a built-in surface id`);
    }
    if (!official) {
      return ctx.drop(`${label} is honoured only for official plugins`);
    }
    return text;
  });
  return limitDeclarations(ids, "credentialHandoff", PLUGIN_CREDENTIAL_HANDOFFS_PER_PLUGIN, (id) => id, ctx);
}

/**
 * `webhookIngress: [{ id, label, verify? }]`.
 *
 * The `verify` frame is dropped rather than fatal when it is malformed, and the
 * CHANNEL goes with it — not the channel kept unverified. A plugin that asked
 * for a signature check and got none would be told nothing and would trust
 * bodies nobody authenticated, which is the one failure mode this field exists
 * to prevent. Losing the channel is loud (its URL stops working); silently
 * dropping the check is not.
 */
function parseWebhookIngress(raw: unknown, ctx: ParseContext): PluginManifestWebhookIngressChannel[] {
  const entries = parseArray(raw, "webhookIngress", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    // The id is a path segment at the relay, which accepts a narrower alphabet
    // than an ADE identifier does. Checked here rather than at registration so
    // the manifest is refused on the machine that wrote it, not by an HTTP 404
    // months later on a URL the user already pasted into a third party.
    if (!PLUGIN_WEBHOOK_CHANNEL_PATTERN.test(id)) {
      return ctx.drop(`${label}.id "${id}" must be lowercase letters, digits and hyphens`);
    }
    const entryLabel = singleLine(entry.label, PLUGIN_DECLARATION_LABEL_MAX);
    if (!entryLabel) return ctx.drop(`${label}.label is required`);
    const entryDescription = singleLine(entry.description, PLUGIN_DECLARATION_DESCRIPTION_MAX);

    let verify: PluginManifestWebhookIngressChannel["verify"];
    if (entry.verify !== undefined && entry.verify !== null) {
      if (!isRecord(entry.verify)) return ctx.drop(`${label}.verify is not an object`);
      if (entry.verify.kind !== "hmac-sha256") {
        return ctx.drop(`${label}.verify.kind must be "hmac-sha256"`);
      }
      const secretRef = trimmedString(entry.verify.secretRef);
      if (!secretRef || !PLUGIN_SECRET_NAME_PATTERN.test(secretRef)) {
        return ctx.drop(`${label}.verify.secretRef must name one of this plugin's secrets`);
      }
      // The relay registration secret is ADE's, not the plugin's. A manifest
      // that pointed `verify` at it would make the host check a third party's
      // signature against a credential the plugin never chose and cannot read,
      // which is a confusing failure at best and a way to exercise a reserved
      // secret at worst.
      if (secretRef === PLUGIN_RESERVED_WEBHOOK_SECRET_NAME) {
        return ctx.drop(`${label}.verify.secretRef must not be the reserved "${PLUGIN_RESERVED_WEBHOOK_SECRET_NAME}"`);
      }
      const header = singleLine(entry.verify.header, 64);
      const prefix = typeof entry.verify.prefix === "string" ? entry.verify.prefix.trim() : "";
      verify = {
        kind: "hmac-sha256",
        secretRef,
        ...(header ? { header: header.toLowerCase() } : {}),
        ...(prefix ? { prefix } : {}),
      };
    }

    return {
      id,
      label: entryLabel,
      ...(entryDescription ? { description: entryDescription } : {}),
      ...(verify ? { verify } : {}),
    };
  });
  return limitDeclarations(entries, "webhookIngress", PLUGIN_WEBHOOK_CHANNELS_PER_PLUGIN, (e) => e.id, ctx);
}

function parseKeybindings(raw: unknown, ctx: ParseContext): PluginManifestKeybinding[] {
  const entries = parseArray(raw, "keybindings", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const action = parseIdentifier(entry.action);
    if (!action) return ctx.drop(`${label}.action is missing or not an identifier`);
    const binding = trimmedString(entry.binding);
    if (!binding) return ctx.drop(`${label}.binding is required`);
    // Policy lives in one place for both clients; the manifest only asks.
    if (!isValidPluginKeybinding(binding)) {
      return ctx.drop(`${label}.binding "${binding}" is not a shortcut a plugin can bind`);
    }
    const entryLabel = singleLine(entry.label, PLUGIN_DECLARATION_LABEL_MAX);
    if (!entryLabel) return ctx.drop(`${label}.label is required`);
    return { action, binding, label: entryLabel };
  });
  // Keyed by action, not by chord: two chords for one action is the mistake
  // worth naming, while two actions colliding on a chord is the *matrix's*
  // call and depends on what else is installed.
  return limitDeclarations(entries, "keybindings", PLUGIN_KEYBINDINGS_PER_PLUGIN, (e) => e.action, ctx);
}

/**
 * URL matchers, in the grammar `shared/plugins/urlMatchers.ts` defines.
 *
 * Policy lives there for the reason `network` and `keybindings` put theirs in a
 * sibling: the parser validates a declaration, the renderer compiles the same
 * declaration into a regex, and a second spelling of either would mean a matcher
 * the parser accepted never fires.
 *
 * Two refusals are worth reading as product decisions rather than validation:
 *
 * - A host core already parses is refused BY NAME. A plugin claiming
 *   `linear.app` would draw its chip over ADE's own Linear links on every
 *   machine that installed it, so the author is told who owns it instead of
 *   shipping a matcher that silently never wins. The one exception is the
 *   plugin that OWNS the built-in surface behind that host — it is the package
 *   the tracker moves into, so refusing it its own domain would mean the
 *   extraction could never finish. `claimedBuiltins` carries the surfaces this
 *   manifest may speak for — the honoured `surfaces[].builtin` ids, plus the
 *   surfaces an official package is the registered OWNER of, because a plugin
 *   that supersedes a surface may not name it with `builtin` at all.
 *   `CORE_SMART_LINK_HOST_BUILTINS` says which host each one unlocks.
 * - A label template naming a capture the pattern does not declare is refused
 *   rather than rendered. A chip that reads `{key}` because nothing filled it is
 *   a bug the user sees and the author does not.
 */
function parseUrlMatchers(
  raw: unknown,
  ctx: ParseContext,
  claimedBuiltins: ReadonlySet<string>,
): PluginManifestUrlMatcher[] {
  const entries = parseArray(raw, "urlMatchers", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);

    const declaredHosts = parseStringList(entry.hosts, `${label}.hosts`, ctx, isValidPluginNetworkHost);
    const hosts: string[] = [];
    for (const host of declaredHosts) {
      const owner = coreSmartLinkHostOwner(host, claimedBuiltins);
      if (owner) {
        ctx.warnings.push(
          `${label}.hosts declares "${host}", which ADE already parses as ${owner}.`
            + ` A plugin cannot claim it — remove the host.`,
        );
        continue;
      }
      hosts.push(host);
    }
    if (hosts.length === 0) return ctx.drop(`${label}.hosts declares no host a plugin may claim`);
    const limitedHosts = limitDeclarations(
      hosts,
      `${label}.hosts`,
      PLUGIN_URL_MATCHER_HOSTS_MAX,
      (host) => host,
      ctx,
    );

    const pattern = compilePluginUrlMatcherPattern(entry.pathPattern);
    if (!pattern.ok) return ctx.drop(`${label}.pathPattern ${pattern.reason}`);
    const { captureNames } = pattern.compiled;

    if (!isRecord(entry.chip)) return ctx.drop(`${label}.chip is missing or not an object`);
    const template = parsePluginUrlMatcherLabelTemplate(entry.chip.label, captureNames);
    if (!template.ok) return ctx.drop(`${label}.chip.label ${template.reason}`);
    const icon = entry.chip.icon === undefined ? null : trimmedString(entry.chip.icon);
    if (icon !== null && !isValidPluginUrlMatcherGlyph(icon)) {
      // Dropped rather than refusing the matcher: the chip has a monogram to
      // fall back to, and losing the whole link over its badge is the worse
      // trade. Named so the author can see which glyph was refused.
      ctx.warnings.push(`${label}.chip.icon "${String(entry.chip.icon)}" is not one or two plain characters`);
    }
    const chip: PluginManifestUrlMatcher["chip"] = {
      label: trimmedString(entry.chip.label) ?? "",
      ...(icon && isValidPluginUrlMatcherGlyph(icon) ? { icon } : {}),
    };

    const panelId = entry.panelId === undefined ? null : parseIdentifier(entry.panelId);
    if (entry.panelId !== undefined && !panelId) {
      return ctx.drop(`${label}.panelId is not an identifier`);
    }

    let entity: PluginManifestUrlMatcher["entity"];
    if (entry.entity !== undefined) {
      if (!isRecord(entry.entity)) return ctx.drop(`${label}.entity is not an object`);
      if (entry.entity.kind !== "issue") {
        return ctx.drop(`${label}.entity.kind must be "issue"`);
      }
      // Not lowercased on the way in: a provider has one spelling, and folding
      // `Jira` to `jira` here would accept a manifest the CLI's own validator
      // refuses.
      const provider = trimmedString(entry.entity.provider) ?? "";
      if (!isValidPluginUrlMatcherProvider(provider)) {
        return ctx.drop(
          `${label}.entity.provider "${provider}" is missing, malformed, or a provider ADE speaks for`,
        );
      }
      const keyFrom = trimmedString(entry.entity.keyFrom) ?? "";
      if (!captureNames.includes(keyFrom)) {
        return ctx.drop(`${label}.entity.keyFrom "${keyFrom}" is not a capture the pathPattern declares`);
      }
      entity = { kind: "issue", provider, keyFrom };
    }

    return {
      id,
      hosts: limitedHosts,
      pathPattern: trimmedString(entry.pathPattern) ?? "",
      chip,
      ...(panelId ? { panelId } : {}),
      ...(entity ? { entity } : {}),
    };
  });
  return limitDeclarations(entries, "urlMatchers", PLUGIN_URL_MATCHERS_PER_PLUGIN, (e) => e.id, ctx);
}

// ------------------------ end engine registrations -------------------------

/**
 * `brandIcons` — token suffix to a plugin-relative SVG path.
 *
 * A known-key object: a malformed value is an error on that entry, an unknown
 * shape for the field itself is an error, and extra keys past the ceiling are
 * dropped with a warning. Paths must be safe and end in `.svg`; the host
 * sanitizes the file at load and refuses anything that is not a path-only
 * mono mark.
 */
function parseBrandIcons(raw: unknown, ctx: ParseContext): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Array.isArray(raw)) {
    ctx.errors.push("brandIcons must be an object of token → relative .svg path");
    return undefined;
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const token = key.trim().toLowerCase();
    if (!PLUGIN_BRAND_ICON_LIMITS.tokenPattern.test(token)) {
      ctx.drop(`brandIcons.${key} is not a brand token suffix (lowercase kebab, 1–32 characters)`);
      continue;
    }
    const file = trimmedString(value);
    if (!file || !isSafePluginRelativePath(file) || !file.toLowerCase().endsWith(".svg")) {
      ctx.drop(`brandIcons.${key} must be a relative path ending in .svg`);
      continue;
    }
    if (Object.keys(parsed).length >= PLUGIN_BRAND_ICON_LIMITS.maxIcons) {
      ctx.drop(`brandIcons.${key} exceeds the ${PLUGIN_BRAND_ICON_LIMITS.maxIcons}-icon ceiling`);
      continue;
    }
    if (Object.hasOwn(parsed, token)) {
      ctx.drop(`brandIcons.${key} repeats ${token}`);
      continue;
    }
    parsed[token] = file;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Ceilings on a tool declaration. A tool schema is prompt text: every property
 * name, description and enum value is rendered into the system prompt of every
 * session the plugin is enabled in, on every runtime. Unlike a panel (which the
 * user opens) an agent tool is always loaded, so the budget is tighter than the
 * 64 KiB panels get.
 */
const PLUGIN_TOOLS_PER_PLUGIN = 24;
const PLUGIN_TOOL_PROPERTIES_PER_OBJECT = 32;
const PLUGIN_TOOL_INPUT_MAX_DEPTH = 4;
const PLUGIN_TOOL_ENUM_MAX = 32;
const PLUGIN_TOOL_TEXT_MAX = 512;

function parseToolText(value: unknown): string | null {
  const text = trimmedString(value);
  if (!text || text.length > PLUGIN_TOOL_TEXT_MAX) return null;
  return text;
}

/**
 * A tool's WORD is stricter than the manifest's general identifier rule, and
 * both halves of the difference are load-bearing.
 *
 * The identifier pattern admits `.`, which every provider that receives these
 * names rejects: Anthropic and OpenAI both constrain a tool name to
 * `[A-Za-z0-9_-]`. A dotted name parses clean here, installs clean, and then
 * makes EVERY turn in EVERY Claude and Codex chat on the machine fail with an
 * opaque provider 400 — because the tool is baked into the session's MCP server
 * at query creation, not at call time, so nothing points back at the plugin.
 *
 * The length ceiling is the same failure by a different route. The name an
 * agent sees is `mcp__ade-plugins__plugin__<pluginId>__<toolName>`: 18 + 8 + 2
 * characters of fixed scaffolding around a plugin id of up to 64, which leaves
 * 36 before Anthropic's 128-character ceiling. 32 keeps the worst case inside
 * it with room for the separator conventions to change.
 */
const PLUGIN_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PLUGIN_TOOL_NAME_MAX = 32;

function parseToolName(value: unknown): string | null {
  const text = trimmedString(value);
  if (!text || text.length > PLUGIN_TOOL_NAME_MAX) return null;
  // A tool name defaults to its action name, so the reservation applies here
  // for the same reason it applies to an identifier.
  if (isReservedPluginActionName(text)) return null;
  return PLUGIN_TOOL_NAME_PATTERN.test(text) ? text : null;
}

/**
 * One node of the input schema. Returns null on anything outside the supported
 * subset, and the caller drops the whole tool rather than the one property: a
 * tool whose arguments are half-described is worse than a tool that is absent,
 * because the agent will call it and the plugin will receive nonsense.
 */
function parseToolInputNode(
  raw: unknown,
  label: string,
  depth: number,
  ctx: ParseContext,
): PluginManifestToolInputNode | null {
  if (depth > PLUGIN_TOOL_INPUT_MAX_DEPTH) {
    return ctx.drop(`${label} nests deeper than ${PLUGIN_TOOL_INPUT_MAX_DEPTH} levels`);
  }
  if (!isRecord(raw)) return ctx.drop(`${label} is not a JSON Schema object`);
  const description = raw.description === undefined ? null : parseToolText(raw.description);
  if (raw.description !== undefined && !description) {
    return ctx.drop(`${label}.description must be a string of ${PLUGIN_TOOL_TEXT_MAX} characters or fewer`);
  }
  const described = description ? { description } : {};
  switch (raw.type) {
    case "string": {
      if (raw.enum === undefined) return { type: "string", ...described };
      if (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > PLUGIN_TOOL_ENUM_MAX) {
        return ctx.drop(`${label}.enum must be 1 to ${PLUGIN_TOOL_ENUM_MAX} strings`);
      }
      const values: string[] = [];
      for (const candidate of raw.enum) {
        const value = parseToolText(candidate);
        if (!value) return ctx.drop(`${label}.enum holds a value that is not a short string`);
        values.push(value);
      }
      return { type: "string", ...described, enum: values };
    }
    case "number":
    case "integer":
      return { type: raw.type, ...described };
    case "boolean":
      return { type: "boolean", ...described };
    case "array": {
      const items = parseToolInputNode(raw.items, `${label}.items`, depth + 1, ctx);
      if (!items) return null;
      return { type: "array", ...described, items };
    }
    case "object": {
      const parsed = parseToolInputObject(raw, label, depth, ctx);
      if (!parsed) return null;
      return { type: "object", ...described, properties: parsed.properties, required: parsed.required };
    }
    default:
      return ctx.drop(`${label}.type must be string, number, integer, boolean, array or object`);
  }
}

function parseToolInputObject(
  raw: Record<string, unknown>,
  label: string,
  depth: number,
  ctx: ParseContext,
): { properties: Record<string, PluginManifestToolInputNode>; required: string[] } | null {
  const rawProperties = raw.properties === undefined ? {} : raw.properties;
  if (!isRecord(rawProperties)) return ctx.drop(`${label}.properties must be an object`);
  const names = Object.keys(rawProperties);
  if (names.length > PLUGIN_TOOL_PROPERTIES_PER_OBJECT) {
    return ctx.drop(`${label}.properties declares more than ${PLUGIN_TOOL_PROPERTIES_PER_OBJECT} properties`);
  }
  const properties: Record<string, PluginManifestToolInputNode> = {};
  for (const name of names) {
    // Property names reach a Zod object key and a JSON Schema key, and the
    // agent has to type them back verbatim. Same identifier rule the rest of
    // the manifest uses, so there is one answer to "what may this be called".
    if (!parseIdentifier(name)) return ctx.drop(`${label}.properties has a key that is not an identifier: ${name}`);
    const node = parseToolInputNode(rawProperties[name], `${label}.properties.${name}`, depth + 1, ctx);
    if (!node) return null;
    properties[name] = node;
  }
  const rawRequired = raw.required === undefined ? [] : raw.required;
  if (!Array.isArray(rawRequired)) return ctx.drop(`${label}.required must be an array`);
  const required: string[] = [];
  for (const candidate of rawRequired) {
    const name = trimmedString(candidate);
    // A required name with no property is a typo that would make the tool
    // uncallable — every invocation would fail validation on a key the agent
    // was never told about.
    //
    // `hasOwnProperty`, not `in`: `properties` is a plain object literal, so
    // `in` also answers true for every `Object.prototype` member and lets
    // `required: ["toString"]` past the guard this line exists to be.
    if (!name || !Object.prototype.hasOwnProperty.call(properties, name)) {
      return ctx.drop(`${label}.required names an undeclared property`);
    }
    if (!required.includes(name)) required.push(name);
  }
  return { properties, required };
}

function parseTools(raw: unknown, ctx: ParseContext): PluginManifestTool[] {
  const parsed = parseArray(raw, "tools", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const name = parseToolName(entry.name);
    if (!name) {
      return ctx.drop(
        `${label}.name must be ${PLUGIN_TOOL_NAME_MAX} characters or fewer of letters, digits, "_" or "-"`,
      );
    }
    // Not optional and not defaulted: the description IS the tool's interface.
    // A nameless verb with no sentence is a tool the agent calls at random.
    const description = parseToolText(entry.description);
    if (!description) {
      return ctx.drop(`${label}.description is required and must be ${PLUGIN_TOOL_TEXT_MAX} characters or fewer`);
    }
    if (!isRecord(entry.input) || entry.input.type !== "object") {
      return ctx.drop(`${label}.input must be a JSON Schema object node`);
    }
    const input = parseToolInputObject(entry.input, `${label}.input`, 1, ctx);
    if (!input) return null;
    const action = entry.action === undefined ? name : parseIdentifier(entry.action);
    if (!action) return ctx.drop(`${label}.action is not an identifier`);
    return {
      name,
      description,
      input: { type: "object" as const, properties: input.properties, required: input.required },
      action,
    };
  });
  const unique: PluginManifestTool[] = [];
  for (const tool of parsed) {
    // Two tools with one name would collide on the qualified MCP name, and
    // whichever the map built last would silently win.
    if (unique.some((existing) => existing.name === tool.name)) {
      ctx.drop(`tools declares "${tool.name}" more than once`);
      continue;
    }
    if (unique.length >= PLUGIN_TOOLS_PER_PLUGIN) {
      ctx.drop(`tools declares more than ${PLUGIN_TOOLS_PER_PLUGIN} tools`);
      continue;
    }
    unique.push(tool);
  }
  return unique;
}

function parseCollections(raw: unknown, ctx: ParseContext): Record<string, PluginManifestCollection> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    ctx.errors.push("collections must be an object keyed by collection name");
    return {};
  }
  const collections: Record<string, PluginManifestCollection> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = parseIdentifier(key);
    if (!name) {
      ctx.warnings.push(`collections["${key}"] dropped: name is not an identifier`);
      continue;
    }
    collections[name] = { sync: isRecord(value) && value.sync === true };
  }
  return collections;
}

function parseTheme(raw: unknown, ctx: ParseContext): PluginManifestTheme | null {
  if (raw === undefined) return null;
  if (!isRecord(raw) || !isRecord(raw.tokens)) {
    ctx.errors.push("theme must be an object with a tokens map");
    return null;
  }
  const readMode = (mode: "dark" | "light"): Record<string, string> | null => {
    const source = raw.tokens as Record<string, unknown>;
    const modeTokens = source[mode];
    if (modeTokens === undefined) return null;
    if (!isRecord(modeTokens)) {
      ctx.errors.push(`theme.tokens.${mode} must be an object`);
      return null;
    }
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(modeTokens)) {
      if (!isAllowedPluginThemeToken(key)) {
        ctx.warnings.push(`theme.tokens.${mode}["${key}"] dropped: token is outside the plugin theme allowlist`);
        continue;
      }
      const text = trimmedString(value);
      if (!text) {
        ctx.warnings.push(`theme.tokens.${mode}["${key}"] dropped: value is not a non-empty string`);
        continue;
      }
      tokens[key] = text;
    }
    return tokens;
  };
  const dark = readMode("dark");
  const light = readMode("light");
  if (!dark && !light) return null;
  return {
    tokens: {
      ...(dark ? { dark } : {}),
      ...(light ? { light } : {}),
    },
  };
}

function parseStringList(
  raw: unknown,
  field: string,
  ctx: ParseContext,
  accept: (value: string) => boolean,
): string[] {
  return parseArray(raw, field, ctx, (entry, label) => {
    const text = trimmedString(entry);
    if (!text || !accept(text)) return ctx.drop(`${label} is not a valid ${field} entry`);
    return text;
  });
}

type ParseContext = {
  errors: string[];
  warnings: string[];
  /** Record a dropped array entry and yield `null` so the caller filters it. */
  drop: (message: string) => null;
};

function parseArray<T>(
  raw: unknown,
  field: string,
  ctx: ParseContext,
  parseEntry: (entry: unknown, label: string) => T | null,
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(`${field} must be an array`);
    return [];
  }
  if (raw.length > PLUGIN_MANIFEST_ARRAY_MAX) {
    ctx.errors.push(`${field} has more than ${PLUGIN_MANIFEST_ARRAY_MAX} entries`);
    return [];
  }
  const parsed: T[] = [];
  raw.forEach((entry, index) => {
    const value = parseEntry(entry, `${field}[${index}]`);
    if (value !== null) parsed.push(value);
  });
  return parsed;
}

/**
 * Parse a manifest object (already JSON-decoded).
 *
 * Returns a manifest whenever identity survives, so a plugin with one bad
 * socket still installs and the operator sees exactly which entry was refused.
 * Callers decide policy: the installer refuses on `errors.length`, the host
 * loads on warnings alone.
 */
export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ctx: ParseContext = {
    errors,
    warnings,
    drop: (message) => {
      warnings.push(`${message} — entry dropped`);
      return null;
    },
  };

  if (!isRecord(raw)) {
    return { manifest: null, errors: ["manifest must be a JSON object"], warnings };
  }

  const name = trimmedString(raw.name);
  if (!name) {
    errors.push("name is required");
  } else if (!isValidPluginId(name)) {
    errors.push(`name "${name}" must be lowercase kebab-case, start with a letter, and be 64 characters or fewer`);
  }
  const version = trimmedString(raw.version);
  if (!version) {
    errors.push("version is required");
  } else if (!isValidPluginVersion(version)) {
    errors.push(`version "${version}" must be major.minor.patch`);
  }

  const entry = raw.entry === undefined ? null : raw.entry;
  if (entry !== null && !isSafePluginRelativePath(entry)) {
    errors.push("entry must be a relative path inside the plugin directory");
  }

  const accent = raw.accent === undefined ? null : trimmedString(raw.accent);
  if (raw.accent !== undefined && (!accent || !PLUGIN_ACCENT_PATTERN.test(accent))) {
    errors.push("accent must be a hex color such as #7C6FF0");
  }

  const vocabVersionRaw = raw.vocabVersion;
  const vocabVersion = typeof vocabVersionRaw === "number" && Number.isInteger(vocabVersionRaw) && vocabVersionRaw > 0
    ? vocabVersionRaw
    : null;
  if (vocabVersionRaw !== undefined && vocabVersion === null) {
    errors.push("vocabVersion must be a positive integer");
  }

  const minAdeVersion = raw.minAdeVersion === undefined ? null : trimmedString(raw.minAdeVersion);
  if (raw.minAdeVersion !== undefined && (!minAdeVersion || !isValidPluginVersion(minAdeVersion))) {
    errors.push("minAdeVersion must be major.minor.patch");
  }

  const official = raw.official === true;
  const surfaces = parseSurfaces(raw.surfaces, ctx, official);
  const panels = parsePanels(raw.panels, ctx);
  const sockets = parseSockets(raw.sockets, ctx);
  const settings = parseSettings(raw.settings, ctx);
  const collections = parseCollections(raw.collections, ctx);
  const theme = parseTheme(raw.theme, ctx);
  const cli = parseStringList(
    raw.cli,
    "cli",
    ctx,
    // A CLI word becomes an action the host invokes, so it obeys the same
    // reservation as every other action name.
    (value) => !isReservedPluginActionName(value) && /^[a-z][a-z0-9-]{0,31}$/.test(value),
  );
  const skills = parseStringList(raw.skills, "skills", ctx, isSafePluginRelativePath);
  const tools = parseTools(raw.tools, ctx);
  const automationTriggers = parseAutomationTriggers(raw.automationTriggers, ctx);
  const automationSteps = parseAutomationSteps(raw.automationSteps, ctx);
  const searchProviders = parseSearchProviders(raw.searchProviders, ctx);
  const keybindings = parseKeybindings(raw.keybindings, ctx);
  // Which built-in surfaces this manifest may speak for, for the one relaxation
  // that reads it: a plugin claiming the core smart-link host behind its own
  // surface (see `parseUrlMatchers`).
  //
  // Two sources, because the two polarities say it in different ways. An
  // `"enables"` plugin says it with `surfaces[].builtin`, and only the ids the
  // surface parser actually HONOURED count — so a community package cannot
  // unlock a core host by writing `builtin` into its manifest. A `"supersedes"`
  // plugin may not use that field at all, so it says it by BEING the registered
  // owner, which is `official`-only for the same reason.
  const claimedBuiltins = new Set<string>([
    ...surfaces
      .map((surface) => surface.builtin)
      .filter((builtin): builtin is PluginBuiltinSurfaceId => Boolean(builtin)),
    ...(official ? coreSmartLinkBuiltinsOwnedBy(name) : []),
  ]);
  const urlMatchers = parseUrlMatchers(raw.urlMatchers, ctx, claimedBuiltins);
  const chatRuntimes = parseChatRuntimes(raw.chatRuntimes, ctx);
  const webhookIngress = parseWebhookIngress(raw.webhookIngress, ctx);
  const network = parseNetwork(raw.network, ctx);
  const providerKeys = parseProviderKeys(raw.providerKeys, ctx);
  const projectSecrets = parseProjectSecrets(raw.projectSecrets, ctx);
  const authSessions = parseAuthSessions(raw.authSessions, ctx);
  const credentialHandoff = parseCredentialHandoff(raw.credentialHandoff, ctx, official);
  const brandIcons = parseBrandIcons(raw.brandIcons, ctx);

  // Identity must be VALID here, not merely present: `manifest.name` is joined
  // into a filesystem path and a secret namespace, so a caller that ignores
  // `errors` must never be handed one that failed validation.
  if (!isValidPluginId(name) || !isValidPluginVersion(version)) {
    return { manifest: null, errors, warnings };
  }

  const displayName = singleLine(raw.displayName, PLUGIN_DISPLAY_NAME_MAX) ?? name;
  const description = singleLine(raw.description, PLUGIN_DESCRIPTION_MAX) ?? "";

  return {
    manifest: {
      name,
      version,
      displayName,
      description,
      ...(trimmedString(raw.icon) ? { icon: trimmedString(raw.icon)! } : {}),
      ...(accent ? { accent } : {}),
      ...(minAdeVersion ? { minAdeVersion } : {}),
      vocabVersion: vocabVersion ?? 1,
      ...(typeof entry === "string" ? { entry } : {}),
      surfaces,
      panels,
      sockets,
      collections,
      settings,
      cli,
      skills,
      tools,
      automationTriggers,
      automationSteps,
      searchProviders,
      keybindings,
      urlMatchers,
      chatRuntimes,
      webhookIngress,
      ...(network ? { network } : {}),
      ...(providerKeys.length > 0 ? { providerKeys } : {}),
      ...(authSessions.length > 0 ? { authSessions } : {}),
      ...(credentialHandoff.length > 0 ? { credentialHandoff } : {}),
      ...(projectSecrets.length > 0 ? { projectSecrets } : {}),
      ...(theme ? { theme } : {}),
      ...(brandIcons ? { brandIcons } : {}),
      official,
    },
    errors,
    warnings,
  };
}

/** Parse manifest JSON text. A syntax error is fatal and reported as an error. */
export function parsePluginManifestJson(text: string): PluginManifestParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    return {
      manifest: null,
      errors: [`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return parsePluginManifest(decoded);
}

/** True when the plugin ships code the host must run in a child process. */
export function pluginHasRuntimeEntry(manifest: PluginManifest): boolean {
  return typeof manifest.entry === "string" && manifest.entry.length > 0;
}

/**
 * One declared chat runtime by id, or null.
 *
 * The single reader for "does this plugin still serve the runtime this session
 * was bound to". A session outlives an install: the plugin can be updated with
 * that runtime removed, or uninstalled entirely, and both answer null here so
 * the caller shows a dead-conversation state rather than dispatching a turn
 * into nothing.
 */
export function findPluginChatRuntime(
  manifest: PluginManifest | null | undefined,
  runtimeId: string,
): PluginManifestChatRuntime | null {
  return (manifest?.chatRuntimes ?? []).find((runtime) => runtime.id === runtimeId) ?? null;
}

/**
 * Compare two `major.minor.patch` strings. Prerelease tails are ignored — the
 * only consumer is the `minAdeVersion` gate, which is a floor, not an ordering.
 */
export function comparePluginVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value.split(/[-+]/, 1)[0]!.split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `false` when the host is older than the manifest's declared floor. */
export function isPluginSupportedByAdeVersion(
  manifest: PluginManifest,
  adeVersion: string | null | undefined,
): boolean {
  if (!manifest.minAdeVersion) return true;
  const host = trimmedString(adeVersion);
  // An unknown host version must not lock the user out of their own plugins.
  if (!host || !isValidPluginVersion(host)) return true;
  return comparePluginVersions(host, manifest.minAdeVersion) >= 0;
}
