import { codedError } from "../../../../desktop/src/shared/codedError";
import { PLUGIN_SERVICE_UNAVAILABLE_CODE } from "../../../../desktop/src/shared/plugins/sdk";
// Type-only: the wire shape below is checked against the manifest's own socket
// type at compile time, and a `import type` adds no runtime edge from the sync
// layer to the manifest parser.
import type { PluginManifestSocket } from "../../../../desktop/src/shared/plugins/manifest";

/**
 * Late-bound handle to the plugin install service.
 *
 * The sync layer has to answer `plugins.install` from a remote machine, but the
 * service that performs an install lives in the desktop main process and is
 * constructed long after the sync host. Importing it here would invert the
 * dependency (sync → main) and drag the whole plugin host into the CLI bundle.
 * So this module owns a narrow interface and a setter; whoever constructs the
 * real service registers it, and the remote-command handlers resolve it at call
 * time.
 *
 * Unbound is a normal runtime state, not a bug: a headless brain or a build
 * without the plugin host answers `plugins_unavailable` rather than crashing or
 * — worse — reporting success for an install that never happened.
 */

/**
 * Re-exported, not restated: the renderer branches on this code and so does the
 * sync layer, and two spellings of it would mean a caller degrades honestly on
 * one route and shows an internal error on the other.
 */
export { PLUGIN_SERVICE_UNAVAILABLE_CODE } from "../../../../desktop/src/shared/plugins/sdk";

/**
 * A remote peer asked this machine to install from `git` or `path`.
 *
 * Only `registry` crosses the wire from another machine — see
 * `parsePluginInstallSource` in `syncRemoteCommandService.ts`. A remote git URL
 * or local path names an ARBITRARY source to clone or copy onto this machine,
 * which is a trust decision the person sitting at THIS keyboard makes, not one
 * a paired peer gets to make for them. The desktop's own local install action
 * still accepts all three kinds; only the peer-reachable path is narrowed.
 */
export const PLUGIN_REMOTE_SOURCE_UNSUPPORTED_CODE = "plugin_remote_source_unsupported";

export type SyncPluginInstallSource =
  | { kind: "registry"; pluginId: string; version?: string | null }
  | { kind: "git"; url: string; ref?: string | null }
  | { kind: "path"; path: string };

/**
 * Child-process health as the plugin host reports it.
 *
 * Declared here rather than imported from `renderer/lib/pluginRuntimeBridge`,
 * which is where the UI's copy lives: the sync layer must not depend on the
 * renderer. The two must stay in step — the union is closed and small enough
 * that duplicating it costs less than the dependency would.
 */
export type SyncPluginRecordRuntimeStatus =
  | "running"
  | "starting"
  | "stopped"
  | "crashed"
  | "none";

/**
 * One rail surface from a plugin's manifest — `{"kind":"tab"}` or
 * `{"kind":"webview"}`.
 *
 * Both arrive here flattened to the same shape, because no reader of this
 * record can host a webview guest: each renders the surface's `panelId` panel,
 * which is the answer that is already correct on the phone, the web client and
 * the TUI.
 */
export type SyncPluginRecordTab = {
  id: string;
  title: string;
  panelId: string;
  icon?: string | null;
};

/**
 * One socket declaration from a plugin's manifest, carried WHOLE.
 *
 * Every field of `PluginManifestSocket`, with the closed unions widened to
 * plain `string`. The widening is the only intentional difference and it is the
 * same rule {@link SyncPluginRecordTab} follows: this file is the WIRE shape,
 * and a peer that predates a socket kind must be able to RECEIVE the row and
 * drop it, not fail to parse the record that carries it. Readers validate
 * against their own lists on arrival — `parsePluginContributionPayload` answers
 * null for a kind it has never heard of, which is the intended degradation.
 *
 * Kept honest in two directions, because one is not enough:
 *
 *  - At RUNTIME the producer spreads the parsed declaration whole
 *    (`toRecordSockets`), so nothing is filtered on the way out.
 *  - At COMPILE TIME {@link UnaccountedManifestSocketField} below fails the
 *    build if `PluginManifestSocket` grows a field this type does not name.
 *
 * The second exists because the first is invisible. This type was written as a
 * hand-kept list and drifted within a single day — it carried `command` and
 * `dialog` but not `description`, `argumentHint` or `section`, so a wire-
 * resolved slash command lost its subtitle and a settings section forgot its
 * page, with nothing erroring anywhere. A list that must be maintained by
 * memory will be, eventually, wrong.
 */
export type SyncPluginRecordSocket = {
  socket: string;
  surface: string;
  id: string;
  /**
   * NOT guaranteed to be an integer — the manifest parser accepts any finite
   * number. A decoder that reads it as an integer type (Swift `Int`) will fail
   * on a manifest that declares `order: 1.5`, taking the whole record with it,
   * so read it as a floating-point number and sort on that.
   */
  order?: number;
  label?: string;
  icon?: string;
  panelId?: string;
  actionId?: string;
  /**
   * A split button's extra actions. Loose here like `dialog` above: the reader
   * re-validates through `parsePluginActionButtonMenu`, and a wire type that
   * restated the cap would be a second ceiling to keep in step.
   *
   * On the wire rather than omitted because the clients that read this record
   * are exactly the ones with no manifest on disk — the web client and the
   * phone — and a split button that arrived there without its menu would be the
   * silent half-render the taxonomy promises never happens.
   */
  menu?: { label: string; actionId: string; icon?: string; danger?: boolean }[];
  /**
   * A button's own tint, already contrast-checked by the producer.
   *
   * On the wire for the same reason `menu` is: the readers are the clients with
   * no manifest on disk, and a plugin's button arriving there in the platform's
   * default grey while the same button is tinted on the machine that installed
   * it is exactly the per-client divergence the taxonomy promises never
   * happens. Loose here — the reader re-validates through
   * `sanitizePluginActionColor`, so an old or tampered record cannot land an
   * illegible colour on a surface just because it reached it over sync.
   */
  color?: string;
  extensions?: string[];
  filterKey?: string;
  command?: string;
  dialog?: string;
  description?: string;
  argumentHint?: string;
  section?: string;
};

/**
 * Manifest socket fields deliberately kept OFF the wire.
 *
 * `never` today: every field a plugin declares is something some client renders,
 * so there has been no reason to withhold one. It exists so that withholding is
 * a decision someone writes down — adding a name here is a two-second edit that
 * leaves a record, where quietly omitting it from the type above is the drift
 * this whole block exists to prevent.
 */
type OmittedManifestSocketField = never;

/** Manifest socket fields this wire type neither carries nor declines. */
type UnaccountedManifestSocketField = Exclude<
  keyof PluginManifestSocket,
  keyof SyncPluginRecordSocket | OmittedManifestSocketField
>;

/**
 * The guard. A new `PluginManifestSocket` field fails the build here, naming
 * itself, until it is either added to {@link SyncPluginRecordSocket} or listed
 * in {@link OmittedManifestSocketField}.
 *
 * Deliberately NOT an index signature on the type above, which was the first
 * attempt and is worse than nothing: `[key: string]: unknown` makes `keyof`
 * resolve to `string`, so `Exclude` is always `never` and this check silently
 * passes forever while the type it guards falls further behind.
 */
type ManifestSocketFieldsAccountedFor = [UnaccountedManifestSocketField] extends [never]
  ? true
  : {
    error: "SyncPluginRecordSocket is missing a PluginManifestSocket field";
    add_to_the_wire_type_or_to_OmittedManifestSocketField: UnaccountedManifestSocketField;
  };
const _manifestSocketFieldsAccountedFor: ManifestSocketFieldsAccountedFor = true;
void _manifestSocketFieldsAccountedFor;

export type SyncPluginInstallRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
  source: string;
  installedAt: string;
  /**
   * Manifest- and runtime-derived detail, for peers that have neither.
   *
   * A machine reading this record over sync has no access to the plugin's
   * manifest on disk or to its child process, so without these it can only
   * report a plugin as installed — not which tabs it contributes, whether it is
   * a theme, or whether it is actually running. The web client is the case that
   * forces it: plugin tabs simply do not appear there otherwise.
   *
   * Every one is OPTIONAL, and that is the contract, not laziness. A host that
   * does not populate them must leave them absent so the reader can fall back to
   * "unknown" — `status: "none"`, no tabs, no theme. Filling them in with a
   * guess (`enabled ? "running" : "stopped"`) would put a green dot next to a
   * crashed plugin, which is worse than admitting the transport cannot see it.
   */
  status?: SyncPluginRecordRuntimeStatus;
  tabs?: SyncPluginRecordTab[];
  /** Present only for theme plugins. `tokens` stays opaque on this path. */
  theme?: { displayName: string; tokens: Record<string, unknown> } | null;
  /**
   * What this plugin adds to core surfaces — badges, menu items, toolbar
   * buttons and the rest.
   *
   * The static half of the socket taxonomy, and the half a peer cannot derive:
   * sockets live in the manifest on disk, which a browser has no access to. Its
   * absence is why the hosted web client rendered NO sockets at all — the
   * renderer's `manifestOf(source)` came back null and every static contribution
   * was dropped before it could be parsed.
   *
   * Absent means "this host cannot see the manifest", the same as `tabs`. An
   * empty array is the different, stronger claim that the manifest was read and
   * declares none.
   */
  sockets?: SyncPluginRecordSocket[];
  /**
   * Manifest socket ids the user switched OFF.
   *
   * A list of what is off rather than what is on, because contributions are on
   * by default: an absent field must read as "none are disabled", and a list of
   * enabled ids could not express that without also being a claim about which
   * sockets exist. Carried beside `sockets` because a reader that has the
   * declarations but not the toggles would draw contributions the user has
   * already dismissed.
   */
  disabledContributions?: string[];
  /**
   * Hosts the plugin's child may contact, from its manifest.
   *
   * Carried for the same reason `sockets` is: a peer reading this record — the
   * hosted web client above all — has no manifest on disk, so without it the
   * Marketplace page there can list everything a plugin adds EXCEPT the one
   * line that says where the user's data goes. Absent means "this host could
   * not read the manifest", the same as `tabs`; a plugin that declares no
   * network sends nothing, because an empty list and no list are the same
   * permission and the parser already collapses them.
   */
  network?: { hosts: string[] };
  /**
   * Provider ids whose ADE-stored API key the plugin reads.
   *
   * Same contract and same reason as `network`. Ids only — a key value is not
   * a thing that crosses this wire, or any other.
   */
  providerKeys?: string[];
  /**
   * Names of the PROJECT's own secrets the plugin reads.
   *
   * Same contract and same reason as `network`: a peer with no manifest on disk
   * would otherwise draw a Marketplace page that lists everything except the
   * most sensitive read the plugin declared. Names only — a secret VALUE is not
   * a thing that crosses this wire, or any other.
   */
  projectSecrets?: string[];
};

export type SyncPluginInstallService = {
  install(source: SyncPluginInstallSource): Promise<SyncPluginInstallRecord>;
  uninstall(pluginId: string): Promise<{ removed: boolean }>;
  setEnabled(pluginId: string, enabled: boolean): Promise<SyncPluginInstallRecord>;
  list(): Promise<SyncPluginInstallRecord[]>;
};

let current: SyncPluginInstallService | null = null;

/** Bind the real service. Pass null on dispose so a stale handle cannot be used. */
export function setPluginInstallService(service: SyncPluginInstallService | null): void {
  current = service;
}

/**
 * The service, or a typed error. Callers must not substitute a silent no-op:
 * a remote install that returns `{ ok: true }` without installing anything is
 * indistinguishable from success on the calling machine.
 */
export function requirePluginInstallService(): SyncPluginInstallService {
  if (!current) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return current;
}

/**
 * Run one of a plugin's own named handlers.
 *
 * The same late-binding seam as the install service, and separate from it on
 * purpose: installing is registry work this module can describe, while invoking
 * reaches the plugin HOST — the child processes, the SDK server and the project
 * binding — none of which the sync layer may import.
 */
export type PluginActionInvoker = (args: {
  pluginId: string;
  action: string;
  args?: Record<string, unknown>;
  /**
   * Which kind of client is driving this call — a hint, never a permission.
   *
   * Everything that reaches this seam arrived over sync from another device, so
   * the caller here is the one thing that KNOWS the answer. Without it the host
   * would present a phone with a `loopback` sign-in that opens a browser on the
   * desktop, and the person holding the phone would wait forever for a window
   * they cannot see. See `PluginDomainService.invoke` in `shared/plugins/sdk.ts`
   * for the single decision it feeds.
   */
  client?: "desktop" | "mobile";
}) => Promise<unknown>;

let invoker: PluginActionInvoker | null = null;

/** Bind the host's invoker. Pass null on dispose. */
export function setPluginActionInvoker(next: PluginActionInvoker | null): void {
  invoker = next;
}

/** The invoker, or the same typed unavailability the install service raises. */
export function requirePluginActionInvoker(): PluginActionInvoker {
  if (!invoker) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return invoker;
}

/**
 * Deliver the parameters a client captured from a sign-in redirect back to the
 * host that started it.
 *
 * A third late-binding seam rather than a member of the two above, for the same
 * reason `PluginActionInvoker` is separate from the install service: this
 * reaches the auth broker, which knows about listeners, minted `state` values
 * and live child processes — none of which the sync layer may import.
 *
 * It takes ONLY the callback parameters. It names no plugin and no session
 * because the host routes by the `state` it minted itself and never gave out,
 * so a caller can address exactly one flow: the live one whose `state` it is
 * handing back. A parameter naming the session would be a door into a flow the
 * caller did not start, and delivering one plugin's authorization code to
 * another plugin is the single thing this seam exists to make impossible.
 *
 * Synchronous, matching `PluginHostService.completeAuthSessionCallback`: the
 * broker claims the flow in one step so a link opened twice cannot deliver the
 * same authorization twice.
 */
export type PluginAuthSessionCompleter = (
  params: Record<string, string>,
) => { ok: boolean; reason?: string };

let authSessionCompleter: PluginAuthSessionCompleter | null = null;

/** Bind the host's completer. Pass null on dispose. */
export function setPluginAuthSessionCompleter(next: PluginAuthSessionCompleter | null): void {
  authSessionCompleter = next;
}

/** The completer, or the same typed unavailability the install service raises. */
export function requirePluginAuthSessionCompleter(): PluginAuthSessionCompleter {
  if (!authSessionCompleter) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return authSessionCompleter;
}
