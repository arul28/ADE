// ---------------------------------------------------------------------------
// `ade plugin doctor <pluginId>` — the state ladder, in one screen.
//
// The plugin platform has eight states that look like one feature to the person
// using it (docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md, "The
// central expectation mismatch"): source exists, installed here, enabled here,
// child activated, contributions materialized, an action of the plugin's has
// actually run, this client draws that kind, and the agent's next turn has
// loaded the skill. Every one of those was observable somewhere. None of them
// were observable TOGETHER, so "the plugin is installed but it does not work"
// was the only sentence a user could form.
//
// "Last run" is the newest rung and it exists because the round-2 alpha report
// (docs/reports/ade-tipsy-plugin-alpha-handoff-2026-08-25.md, finding #6) found
// the ladder could not tell "the action never fired" from "the action fired and
// published nothing" — both printed "0 rows published right now", so the only
// way to separate them was to press the real button and watch.
//
// This command is that missing screen. One line per layer, plain words, ✓ / ✗ /
// – so the eye finds the first ✗ and stops there. It answers with whatever it
// can reach: the registry half works with ADE closed, and a layer nobody could
// check says so rather than guessing.
//
// The per-client answer is DERIVED from PLUGIN_SOCKET_CLIENT_SUPPORT through
// `shared/plugins/clientRendering.ts` — never restated here. A parity pass that
// teaches iOS a new kind changes what this prints without touching this file.
// ---------------------------------------------------------------------------

import {
  PLUGIN_SKILL_NEXT_TURN_NOTE,
  describePluginClientRendering,
  formatPluginClientRendering,
  type PluginClientRenderAnswer,
} from "../../../desktop/src/shared/plugins/clientRendering";
import { KEYBINDING_DEFINITIONS } from "../../../desktop/src/shared/keybindings";
import {
  buildCoreChordIndex,
  resolvePluginKeybindings,
} from "../../../desktop/src/shared/plugins/keybindings";
import {
  PLUGIN_PROVIDER_KEY_LABELS,
  type PluginManifest,
} from "../../../desktop/src/shared/plugins/manifest";
import { PLUGIN_NETWORK_REFUSAL_LOG_CODE } from "../../../desktop/src/shared/plugins/network";
import { PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX } from "../../../desktop/src/shared/plugins/sdk";
import { PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT } from "../../../desktop/src/shared/plugins/sockets";
import type {
  PluginActionInvokeRecord,
  PluginContributionRecord,
  PluginDetail,
  PluginInstallRecord,
  PluginPresenceMachineRow,
  PluginUsageSummaryEntry,
  PluginWebhookIngressStatus,
} from "../../../desktop/src/shared/plugins/sdk";

/**
 * What the live half of the check found.
 *
 * The whole object is null when ADE could not be reached, which is a different
 * answer from "reached ADE, it has nothing" — a doctor that reported an
 * unreachable brain as an absent plugin would send the reader to reinstall
 * something that is already there.
 */
export type PluginDoctorLive = {
  /** `plugin.get`. Null when the host does not have this plugin installed. */
  detail: PluginDetail | null;
  /** `plugin.presence` rows for this plugin, across the account's machines. */
  presence: PluginPresenceMachineRow[];
  /** `plugin.listContributions` rows belonging to this plugin. */
  contributions: PluginContributionRecord[];
  /** `plugin.usageSummary`'s entry. Null when the plugin has no stored rows. */
  usage: PluginUsageSummaryEntry | null;
  /**
   * `plugin.webhookIngress`'s row for this plugin.
   *
   * Optional on the wire, and `undefined` is NOT `null`: a host that predates
   * the action answers without the field, and the rung then says nobody could
   * check rather than drawing "no webhooks arrive" over a host that never
   * looked. The same rule `lastInvokes` follows.
   */
  webhookIngress?: PluginWebhookIngressStatus | null;
};

export type PluginDoctorSnapshot = {
  pluginId: string;
  /** The machine install registry's entry. Read with ADE closed. */
  record: PluginInstallRecord | null;
  manifest: PluginManifest | null;
  /** Fatal manifest problems from the local parse, if any. */
  manifestErrors: string[];
  /**
   * Non-fatal ones: entries the parse DROPPED, so the manifest above is missing
   * something the file asks for. Optional, because a caller that predates the
   * field passes nothing and gets the old silence rather than a false green.
   */
  manifestWarnings?: string[];
  live: PluginDoctorLive | null;
  /**
   * Whether a `local` record's source folder is still on disk.
   *
   * Null when nobody looked or the source is not a folder. `reload` re-copies
   * a local source before it restarts the child, so a source that has moved
   * away means every future reload keeps running the installed copy — a state
   * worth naming on the line that already names the folder.
   */
  sourcePresent?: boolean | null;
};

export type PluginDoctorLayerKey =
  | "source"
  | "installed"
  | "running"
  | "places"
  | "customPage"
  | "lastRun"
  | "shortcuts"
  | "ingress"
  | "panels"
  | "panelReach"
  | "synced"
  | "skills"
  | "network"
  | "providerKeys"
  | "projectSecrets";

/**
 * `ok` / `no` / `na` print as ✓ / ✗ / –. `unknown` prints as – too, and says in
 * its own words that nobody could check — a fourth glyph would make the column
 * something the reader has to decode instead of scan.
 */
export type PluginDoctorState = "ok" | "no" | "na" | "unknown";

export type PluginDoctorLayer = {
  key: PluginDoctorLayerKey;
  label: string;
  state: PluginDoctorState;
  detail: string;
};

export type PluginDoctorReport = {
  pluginId: string;
  displayName: string;
  version: string | null;
  layers: PluginDoctorLayer[];
  clients: PluginClientRenderAnswer[];
  /** The one-line per-client answer, or "" for a plugin declaring no sockets. */
  renders: string;
  /**
   * Every action the manifest declares, with its last attempt when there was
   * one. The text report prints the newest line; `--json` carries all of them,
   * which is the form a script comparing two runs wants.
   */
  actions: PluginDoctorAction[];
};

export type PluginDoctorAction = {
  action: string;
  /** Where the manifest asks for it: `chat-header-action`, `cli`, `tool`, … */
  declaredBy: string[];
  /** The last attempt on this machine since ADE started, or null for none. */
  lastInvoke: PluginActionInvokeRecord | null;
};

const UNREACHABLE = "could not ask ADE — is it running on this computer?";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeSource(snapshot: PluginDoctorSnapshot, record: PluginInstallRecord): string {
  const { source } = record;
  if (source.kind === "git") return `${source.url}${source.ref ? ` at ${source.ref}` : ""}`;
  if (source.kind !== "local") return "ships inside ADE";
  // `reload` re-copies a local source before it restarts the child, so a folder
  // that has moved away means every reload from here on keeps running the
  // installed copy. Said on the line that already names the folder.
  const gone = snapshot.sourcePresent === false
    ? " — gone, so a reload keeps running the installed copy"
    : "";
  return `the folder ${source.path}${gone}`;
}

function sourceLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  if (!snapshot.record) {
    return {
      key: "source",
      label: "Source",
      state: "no",
      detail: "this computer has no record of where it would come from",
    };
  }
  return {
    key: "source",
    label: "Source",
    state: snapshot.sourcePresent === false ? "no" : "ok",
    detail: describeSource(snapshot, snapshot.record),
  };
}

function installedLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Installed here";
  const elsewhere = (snapshot.live?.presence ?? []).filter(
    (row) => !row.isThisMachine && row.enabled,
  ).length;
  const alsoOn = elsewhere > 0 ? ` · also on ${plural(elsewhere, "other computer")}` : "";

  if (!snapshot.record) {
    return {
      key: "installed",
      label,
      state: "no",
      detail: `not on this computer — run: ade plugin install <source>${alsoOn}`,
    };
  }
  if (snapshot.manifestErrors.length > 0) {
    return {
      key: "installed",
      label,
      state: "no",
      detail: `installed, but its plugin.json will not load: ${snapshot.manifestErrors[0]}`,
    };
  }
  if (!snapshot.record.enabled) {
    return {
      key: "installed",
      label,
      state: "no",
      detail: `version ${snapshot.record.version} is here but switched off`
        + ` — run: ade plugin enable ${snapshot.pluginId}${alsoOn}`,
    };
  }
  return {
    key: "installed",
    label,
    state: "ok",
    detail: `version ${snapshot.record.version}, turned on${alsoOn}`,
  };
}

function runningLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Running";
  if (snapshot.manifest && !snapshot.manifest.entry) {
    return { key: "running", label, state: "na", detail: "this plugin runs no code of its own" };
  }
  if (!snapshot.live) return { key: "running", label, state: "unknown", detail: UNREACHABLE };
  const detail = snapshot.live.detail;
  if (!detail) {
    return { key: "running", label, state: "no", detail: "ADE does not have this plugin installed" };
  }
  switch (detail.status) {
    case "running":
      return { key: "running", label, state: "ok", detail: "the plugin's own process is up" };
    case "starting":
    case "restarting":
      return { key: "running", label, state: "ok", detail: `${detail.status} — give it a moment` };
    case "crashed":
      return {
        key: "running",
        label,
        state: "no",
        detail: `it crashed — run: ade plugin logs ${snapshot.pluginId}`,
      };
    case "no-entry":
      return { key: "running", label, state: "na", detail: "this plugin runs no code of its own" };
    default:
      return {
        key: "running",
        label,
        state: "no",
        detail: `not started — run: ade plugin reload ${snapshot.pluginId}`,
      };
  }
}

/** `composer-action in work`, `2× row-badge in lanes` — kind and surface, counted. */
/**
 * The full-page surfaces: one rail entry each, at `/plugin/<id>`.
 *
 * `tab` and `webview` together, because the rail treats them as one thing and
 * only the page itself cares which it draws.
 */
function railSurfaces(manifest: PluginManifest | null): PluginManifest["surfaces"] {
  return (manifest?.surfaces ?? []).filter(
    (surface) => surface.kind === "tab" || surface.kind === "webview",
  );
}

/**
 * The rail half of "Renders on", which the socket half cannot answer.
 *
 * `formatPluginClientRendering` derives its sentence from the socket support
 * matrix, so a plugin whose whole presence is a tab produced NO line at all and
 * a plugin with one chat button produced a line that named only the button —
 * the exact reading that sent an author debugging a tab the doctor never
 * mentioned (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §6).
 *
 * A `tab` draws on every client. A `webview` draws its own page on desktop and
 * its panel everywhere else, which is the cross-surface fallback and not a
 * fault — said here in one clause so the reader meets it before they meet it as
 * a surprise on their phone.
 */
function describeRailRendering(manifest: PluginManifest | null): string {
  const rails = railSurfaces(manifest);
  if (rails.length === 0) return "";
  const webviews = rails.filter((surface) => surface.kind === "webview").length;
  const tabs = rails.length - webviews;
  const clauses: string[] = [];
  if (tabs > 0) clauses.push(`${plural(tabs, "sidebar tab")} on every client`);
  if (webviews > 0) {
    clauses.push(`${plural(webviews, "custom-UI tab")}: its page on desktop, its panel on web, iPhone and terminal`);
  }
  return clauses.join(" · ");
}

function describeDeclaredPlaces(manifest: PluginManifest): string[] {
  const counts = new Map<string, number>();
  // Rail surfaces are named FIRST, and they used to be named nowhere. A tab is
  // the largest place a plugin takes, so an author whose tab drew nothing read
  // `chat-header-action in work` — a true sentence about the wrong surface —
  // and had to find "Panels" to learn a tab was declared at all
  // (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §6).
  for (const surface of railSurfaces(manifest)) {
    const key = surface.kind === "webview" ? "webview tab in the sidebar" : "tab in the sidebar";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const socket of manifest.sockets) {
    const key = `${socket.socket} in ${socket.surface}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => (count === 1 ? key : `${count}× ${key}`));
}

function placesLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Places";
  const sockets = snapshot.manifest?.sockets ?? [];
  const rails = railSurfaces(snapshot.manifest);
  // A declaration ADE threw away while reading plugin.json. Named here, before
  // anything else, because the parse already removed it: an author who wrote a
  // `{"kind": "pane"}` surface no client draws sees the entry vanish from the
  // manifest, and every rung below would then describe a plugin that declared
  // one fewer place than the file does — ✓ or – over something the author is
  // still waiting to see. The warning carries the replacement to use.
  const dropped = snapshot.manifestWarnings ?? [];
  if (snapshot.record && dropped.length > 0) {
    return {
      key: "places",
      label,
      state: "no",
      detail: `ADE dropped ${plural(dropped.length, "part")} of plugin.json while reading it`
        + `: ${dropped[0]}`,
    };
  }
  if (sockets.length === 0 && rails.length === 0) {
    return {
      key: "places",
      label,
      state: "na",
      detail: snapshot.manifest
        ? "this plugin asks for no place in ADE's own screens"
        : "no readable plugin.json here, so nothing declares a place",
    };
  }

  const declared = describeDeclaredPlaces(snapshot.manifest!).join(", ");
  // A switched-off plugin places NOTHING. The rung used to describe the
  // manifest alone, so it read ✓ beside "Installed here ✗" and "Running ✗" —
  // a green line about placements that cannot exist, which is the same
  // "green while broken" pattern the rest of this ladder was built to end.
  // The declarations are still named, because the reader is here asking what
  // this plugin WOULD place once they turn it back on.
  if (snapshot.record && !snapshot.record.enabled) {
    return {
      key: "places",
      label,
      state: "no",
      detail: `${declared} — none of it is placed: this plugin is switched off`
        + ` (run: ade plugin enable ${snapshot.pluginId})`,
    };
  }
  const switchedOff = (snapshot.record?.disabledContributions ?? []).filter((id) =>
    sockets.some((socket) => socket.id === id),
  ).length;
  const offNote = switchedOff > 0 ? `; ${switchedOff} switched off here` : "";
  const published = snapshot.live
    ? `; ${plural(snapshot.live.contributions.length, "row")} published right now`
    : "; published rows unknown (ADE is not answering)";
  // The one cap whose effect a plugin author cannot see from their own side.
  // Every other ceiling on this platform refuses the WRITE — the payload parser
  // rejects a bad payload, the row budget throws — so the plugin learns at the
  // moment it publishes. The graph cap is different: the rows store fine and the
  // canvas withholds the surplus at draw time, on a machine the author may not
  // be sitting at. Counted from the same published rows this rung already reads,
  // so it needs nothing new on the wire.
  const overCapGraphNodes = snapshot.live
    ? Math.max(
      0,
      snapshot.live.contributions.filter((row) => row.socket === "graph-node").length
        - PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT,
    )
    : 0;
  const graphNote = overCapGraphNodes > 0
    ? `; ${plural(overCapGraphNodes, "graph node")} past the ${PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT}-node`
      + " canvas cap and not drawn"
    : "";

  // Every declared socket is switched off, so nothing this plugin asks for can
  // draw anywhere. That reads as ✗ rather than ✓, because the reader is here
  // asking why they cannot see it. A rail surface is not a socket and cannot be
  // switched off, so a plugin that still has one keeps its place.
  const state: PluginDoctorState = sockets.length > 0 && switchedOff >= sockets.length && rails.length === 0
    ? "no"
    : "ok";
  return { key: "places", label, state, detail: `${declared}${offNote}${published}${graphNote}` };
}

/**
 * Does the page a `webview` surface promises actually reach a guest host?
 *
 * The rung the ladder was missing, and it is the one that would have ended the
 * alpha run in a sentence. Every guest host in the desktop mounts a `<webview>`
 * only when the surface it reads carries `entryHtml`, and each treats its
 * absence as "render the panel". The host's own summary mapper dropped the
 * field, so a plugin with a perfectly good page drew its panel everywhere with
 * no error to find, and the author debugged their HTML
 * (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §2, §6).
 *
 * So this compares the two halves `plugin.get` already returns: the manifest
 * ADE parsed, and the summary ADE serves. They disagreeing is a HOST fault and
 * prints as ✗ — the one state where the plugin is not the thing to fix.
 */
function customPageLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Custom page";
  const declared = (snapshot.manifest?.surfaces ?? []).filter(
    (surface) => surface.kind === "webview" && surface.entryHtml,
  );
  if (declared.length === 0) {
    return { key: "customPage", label, state: "na", detail: "this plugin draws no page of its own" };
  }
  // Said on the passing line as well as the failing one: "my page shows the
  // panel on my phone" is a correct observation about a working plugin, and a
  // doctor that only mentions it when something is broken leaves the author to
  // discover the fallback by being surprised at it.
  const fallbackNote = "the phone, the web client and `ade code` draw its panel instead, by design";
  if (!snapshot.live) {
    return {
      key: "customPage",
      label,
      state: "unknown",
      detail: `${plural(declared.length, "page")} in the manifest; ${UNREACHABLE}`,
    };
  }
  const detail = snapshot.live.detail;
  if (!detail) {
    return { key: "customPage", label, state: "no", detail: "ADE does not have this plugin installed" };
  }
  const served = detail.surfaces ?? [];
  const missing = declared.filter((surface) => {
    const match = served.find((entry) => entry.id === surface.id);
    return !match?.entryHtml;
  });
  if (missing.length > 0) {
    return {
      key: "customPage",
      label,
      state: "no",
      detail: `ADE lists ${missing.map((surface) => `"${surface.id}"`).join(", ")} without its page,`
        + " so every surface draws the panel instead"
        + " — the running copy of ADE is older than this manifest; update and restart it,"
        + " and note that a reload cannot change what the running app serves",
    };
  }
  return {
    key: "customPage",
    label,
    state: "ok",
    detail: `${declared.map((surface) => `${surface.id} → ${surface.entryHtml}`).join(", ")}`
      + ` · ${fallbackNote}`,
  };
}

/**
 * Every action the manifest asks ADE to be able to call, and where from.
 *
 * Read from the manifest rather than from what has run, because the question
 * this answers is "which of the things I declared has never fired" — a list
 * built from the run history alone can never contain the action nobody
 * reached, which is the one the reader is looking for.
 */
function collectDeclaredActions(manifest: PluginManifest | null): Map<string, string[]> {
  const actions = new Map<string, string[]>();
  const add = (action: string | undefined, declaredBy: string): void => {
    if (!action) return;
    const existing = actions.get(action);
    if (existing) {
      if (!existing.includes(declaredBy)) existing.push(declaredBy);
      return;
    }
    actions.set(action, [declaredBy]);
  };
  if (!manifest) return actions;
  for (const socket of manifest.sockets) {
    add(socket.actionId, socket.socket);
    // A split button's dropdown items each name their own action, and one of
    // those failing is exactly as invisible as the primary press failing.
    for (const item of socket.menu ?? []) add(item.actionId, `${socket.socket} menu`);
  }
  for (const word of manifest.cli) add(word, "cli");
  for (const tool of manifest.tools) add(tool.action, "agent tool");
  for (const step of manifest.automationSteps) add(step.action, "automation step");
  for (const provider of manifest.searchProviders) add(provider.action, "search");
  for (const keybinding of manifest.keybindings) add(keybinding.action, "keybinding");
  return actions;
}

function buildDoctorActions(snapshot: PluginDoctorSnapshot): PluginDoctorAction[] {
  const declared = collectDeclaredActions(snapshot.manifest);
  const history = new Map<string, PluginActionInvokeRecord>();
  for (const record of snapshot.live?.detail?.lastInvokes ?? []) {
    if (record?.action) history.set(record.action, record);
  }
  const rows: PluginDoctorAction[] = [...declared].map(([action, declaredBy]) => ({
    action,
    declaredBy,
    lastInvoke: history.get(action) ?? null,
  }));
  // An action that ran but no longer appears in the manifest still belongs
  // here: "it fired, and nothing declares it any more" is a real answer, and
  // dropping the row would report the run as never having happened.
  for (const [action, record] of history) {
    if (!declared.has(action)) rows.push({ action, declaredBy: [], lastInvoke: record });
  }
  return rows.sort((left, right) => left.action.localeCompare(right.action));
}

/** `3 minutes ago`, `just now`. Coarse on purpose — this is a timeline, not a clock. */
function describeAge(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return at;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

/**
 * Did anything this plugin declares actually run?
 *
 * The rung the ladder was missing. "Places" says a contribution is drawn and
 * "In this project" says rows were stored, and BOTH read the same whether the
 * action behind the button never fired or fired and did nothing — which is why
 * "I pressed it and nothing happened" used to need a manual reproduction
 * before anyone could say which half was broken. This line separates them: an
 * action that ran and returned is a plugin-code question, and one that never
 * ran is a wiring question.
 */
function lastRunLayer(
  snapshot: PluginDoctorSnapshot,
  actions: PluginDoctorAction[],
  now: number,
): PluginDoctorLayer {
  const label = "Last run";
  if (snapshot.manifest && !snapshot.manifest.entry) {
    return { key: "lastRun", label, state: "na", detail: "this plugin runs no code of its own" };
  }
  if (!snapshot.live) return { key: "lastRun", label, state: "unknown", detail: UNREACHABLE };
  // A plugin this host does not have answers `plugin.get` with null, which is a
  // DIFFERENT degradation from the old-host one below — the same distinction
  // `runningLayer` already draws. Conflating them sent a reader who had just
  // uninstalled a plugin off to check their ADE version instead of their
  // install, while every other rung on the same output said "not installed".
  if (!snapshot.live.detail) {
    return {
      key: "lastRun",
      label,
      state: "no",
      detail: "ADE does not have this plugin installed",
    };
  }
  // An older host answers `plugin.get` without the field at all, which is not
  // the same as answering "nothing has run" — saying so is the whole reason
  // this rung is worth having.
  if (snapshot.live.detail.lastInvokes === undefined) {
    return {
      key: "lastRun",
      label,
      state: "unknown",
      detail: "this copy of ADE does not keep track of plugin action runs",
    };
  }
  const ran = actions.filter((entry) => entry.lastInvoke !== null);
  const never = actions.length - ran.length;
  if (ran.length === 0) {
    return {
      key: "lastRun",
      label,
      state: "no",
      detail: actions.length === 0
        ? "this plugin declares no action to run"
        : `no action has run since ADE started — try: ade actions run plugin.invoke --input-json`
          + ` '{"pluginId":"${snapshot.pluginId}","action":"${actions[0]!.action}"}'`,
    };
  }
  const newest = ran.reduce((latest, entry) =>
    Date.parse(entry.lastInvoke!.at) > Date.parse(latest.lastInvoke!.at) ? entry : latest);
  const record = newest.lastInvoke!;
  const outcome = record.ok
    ? `ran ${describeAge(record.at, now)}`
    : `failed ${describeAge(record.at, now)} (${record.errorCode ?? "plugin_error"})`;
  const neverNote = never > 0 ? `; ${plural(never, "action")} never run` : "";
  return {
    key: "lastRun",
    label,
    state: record.ok ? "ok" : "no",
    detail: `${newest.action} ${outcome}${neverNote}`,
  };
}

/**
 * Do the plugin's declared keyboard shortcuts actually bind?
 *
 * A manifest chord passes the parse if it is *shaped* like a chord a plugin may
 * bind — a modifier, not a reserved key. It is a separate question whether ADE
 * has already claimed it, and until this rung existed nothing answered it
 * anywhere an author could see. `Mod+K` parsed cleanly, `plugin.get` reported
 * it as a live binding, and the renderer refused it at bind time against the
 * core chord index with a message that reached a `console.warn` and nothing
 * else. The author saw a declared shortcut that silently never fired.
 *
 * This reruns the renderer's OWN resolver rather than restating its rules, so
 * the sentence here is the sentence the app produces — `resolvePluginKeybindings`
 * is shared and pure, and `KEYBINDING_DEFINITIONS` is plain data the CLI can
 * import with ADE closed.
 *
 * The honest limit, and it is stated in the detail rather than hidden: this
 * sees ADE's SHIPPED chords, not chords the user has personally rebound onto.
 * A rebind lives in the app's keybindings store, which a doctor run with ADE
 * closed cannot read. So a clean rung means "nothing collides with stock ADE",
 * which is the answer for every user who has not rebound anything.
 */
function shortcutsLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Shortcuts";
  const declared = snapshot.manifest?.keybindings ?? [];
  if (declared.length === 0) {
    return { key: "shortcuts", label, state: "na", detail: "this plugin declares no keyboard shortcut" };
  }
  const pluginName = snapshot.manifest?.displayName ?? snapshot.pluginId;
  const { bindings, refusals } = resolvePluginKeybindings(
    declared.map((entry) => ({
      pluginId: snapshot.pluginId,
      pluginName,
      // One plugin resolved alone, so the install order that breaks ties
      // between plugins never applies and any value would do.
      installedAt: snapshot.record?.installedAt ?? "",
      action: entry.action,
      binding: entry.binding,
      label: entry.label,
    })),
    buildCoreChordIndex(KEYBINDING_DEFINITIONS.map((entry) => [entry.id, entry.defaultBinding] as const)),
  );
  if (refusals.length === 0) {
    return {
      key: "shortcuts",
      label,
      state: "ok",
      detail: `${plural(bindings.length, "shortcut")} bound — ${bindings.map((entry) => entry.binding).join(", ")}`,
    };
  }
  const first = refusals[0]!;
  const others = refusals.length > 1 ? ` (+${refusals.length - 1} more)` : "";
  return { key: "shortcuts", label, state: "no", detail: `${first.message}${others}` };
}

/**
 * Is anything actually arriving from outside?
 *
 * The rung the ingress feature needs for the same reason "Last run" was added:
 * "I pasted the URL into Stripe and nothing happens" has four different causes
 * — the plugin was never registered with the relay, the third party is posting
 * somewhere else, the signature check is rejecting every delivery, or the
 * plugin's own handler never acks — and without this line all four look
 * identical from outside. Each one gets its own sentence, and the URL is
 * printed so the reader can compare it against what they pasted rather than
 * take anyone's word for it.
 */
function ingressLayer(snapshot: PluginDoctorSnapshot, now: number): PluginDoctorLayer {
  const label = "Webhooks";
  const declared = snapshot.manifest?.webhookIngress ?? [];
  if (declared.length === 0) {
    return {
      key: "ingress",
      label,
      state: "na",
      detail: snapshot.manifest
        ? "this plugin receives no webhooks"
        : "no readable plugin.json here, so nothing declares a webhook",
    };
  }
  if (!snapshot.live) return { key: "ingress", label, state: "unknown", detail: UNREACHABLE };
  if (snapshot.live.webhookIngress === undefined) {
    return {
      key: "ingress",
      label,
      state: "unknown",
      detail: "this copy of ADE does not receive webhooks for plugins",
    };
  }
  const status = snapshot.live.webhookIngress;
  const urls = declared
    .map((channel) => {
      const live = status?.channels.find((row) => row.channelId === channel.id);
      return live?.url ? `${channel.id} → ${live.url}` : channel.id;
    })
    .join("; ");

  if (!status || status.state === "undeclared" || status.state === "unconfigured") {
    return {
      key: "ingress",
      label,
      state: "no",
      detail: `not registered with the relay yet — it registers within a minute of the plugin starting; ${urls}`,
    };
  }
  if (status.state === "error") {
    return { key: "ingress", label, state: "no", detail: `${status.lastError ?? "the last poll failed"}; ${urls}` };
  }
  // A channel that verifies with a secret this machine does not hold refuses
  // every delivery. Named first: it is the one failure where events ARE
  // arriving and the reader would otherwise blame the sender.
  const missing = status.channels.filter((channel) => channel.missingSecretRef);
  if (missing.length > 0) {
    const names = missing.map((channel) => `${channel.channelId} needs ${channel.missingSecretRef!}`).join(", ");
    return {
      key: "ingress",
      label,
      state: "no",
      detail: `arriving and being refused — the signing secret is not on this computer: ${names}`,
    };
  }
  const received = status.lastReceivedAt
    ? `last arrived ${describeAge(status.lastReceivedAt, now)}`
    : "nothing has arrived yet";
  const waiting = status.pendingDeliveries > 0
    ? `; ${plural(status.pendingDeliveries, "delivery", "deliveries")} waiting to be handled`
    : "";
  // Abandoned means the plugin was handed the delivery and never acked it,
  // PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX times. That is a plugin bug, and
  // saying so is the whole point of counting them.
  const dropped = status.abandonedDeliveries > 0
    ? `; ${plural(status.abandonedDeliveries, "delivery", "deliveries")} given up on after`
      + ` ${PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX} tries`
    : "";
  return {
    key: "ingress",
    label,
    state: status.abandonedDeliveries > 0 ? "no" : "ok",
    detail: `${received}${waiting}${dropped}; ${urls}`,
  };
}

function panelsLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Panels";
  const declared = snapshot.manifest?.panels.length ?? 0;
  if (declared === 0) {
    return { key: "panels", label, state: "na", detail: "this plugin draws no panels" };
  }
  if (!snapshot.live) {
    return {
      key: "panels",
      label,
      state: "unknown",
      detail: `${plural(declared, "panel")} in the manifest; ${UNREACHABLE}`,
    };
  }
  const published = snapshot.live.usage?.panelRows ?? 0;
  if (published === 0) {
    return {
      key: "panels",
      label,
      state: "no",
      detail: `none published yet of ${plural(declared, "panel")} in the manifest`
        + " — a plugin publishes its panels when it starts",
    };
  }
  return {
    key: "panels",
    label,
    state: "ok",
    detail: `${published} published of ${plural(declared, "panel")} in the manifest`,
  };
}

/**
 * Can a button that opens a panel actually SHOW one where it was pressed?
 *
 * The rung the HN dogfood run needed. That plugin declared a chat-header button
 * whose handler returns `{navigate: {panelId}}`, one panel, and — at first —
 * nowhere for a panel to appear. Every other rung was ✓: the source parsed, the
 * plugin was installed and running, the button drew, the action fired, the panel
 * published. The press still did nothing a reader could see, because a
 * `chat-header-action` INVOKES a handler and draws no panel in place, and the
 * plugin had declared neither a tab nor a Work tools pane for the navigation to
 * land in.
 *
 * Decided from the manifest alone, because that is the whole point: the doctor
 * cannot run a handler to see whether it navigates, but it can see that this
 * plugin's only entry points are buttons and its only output is a panel with
 * nowhere to go. The two fixes are named on the line, because "unreachable" with
 * no next step is the kind of diagnosis that sends an author back to their own
 * HTML.
 *
 * `na` — not ✗ — for a plugin whose panels are reachable another way. This rung
 * answers one question and a plugin with a tab has already answered it.
 */
function panelReachLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Panel reach";
  const manifest = snapshot.manifest;
  const panels = manifest?.panels ?? [];
  if (!manifest || panels.length === 0) {
    return { key: "panelReach", label, state: "na", detail: "this plugin draws no panels" };
  }
  // Deliberately `chat-header-action` alone, and not every socket that invokes
  // without drawing. A composer button's canonical uses are about the DRAFT —
  // record this, transcribe that — so a composer button beside an unplaced panel
  // is an ordinary plugin, not a mistake. A chat header button's canonical uses
  // are "summarize this conversation, hand it off, file it", which end in
  // something to look at; that is the one shape where a panel with nowhere to go
  // is evidence rather than a guess, and a rung that guesses is worse than no
  // rung at all on a ladder whose whole job is to be scanned for the first ✗.
  const chatButtons = manifest.sockets.filter(
    (socket) => socket.socket === "chat-header-action",
  );
  if (chatButtons.length === 0) {
    return {
      key: "panelReach",
      label,
      state: "na",
      detail: "no chat header button here, so nothing depends on where a navigate lands",
    };
  }
  // Everywhere a panel of this plugin can actually be drawn.
  const tabs = railSurfaces(manifest);
  const panes = manifest.sockets.filter(
    (socket) => socket.socket === "work-rail-pane" || socket.socket === "drawer-tab",
  );
  if (tabs.length === 0 && panes.length === 0) {
    return {
      key: "panelReach",
      label,
      state: "no",
      detail: `a chat-header-action invokes an action and draws no panel in place`
        + ` (${plural(chatButtons.length, "declared")}), and this plugin declares no tab and no`
        + " Work tools pane — so a `{navigate}` from it has nowhere to land."
        + " Add a `work-rail-pane` socket for the panel to open beside the chat, or a `tab`"
        + " surface to open it as a page",
    };
  }
  const places: string[] = [];
  if (panes.length > 0) places.push(plural(panes.length, "pane"));
  if (tabs.length > 0) places.push(plural(tabs.length, "tab"));
  // Named in the order the placement rule prefers them: a press inside a chat
  // opens the pane where one exists, and falls back to the tab where none does.
  const note = panes.length > 0
    ? "a navigate from a chat button opens beside the conversation"
    : "a navigate from a chat button opens the tab, taking the reader off the chat";
  return {
    key: "panelReach",
    label,
    state: "ok",
    detail: `${places.join(", ")} — ${note}`,
  };
}

function syncedLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "In this project";
  if (!snapshot.live) return { key: "synced", label, state: "unknown", detail: UNREACHABLE };
  const usage = snapshot.live.usage;
  const total = usage
    ? usage.contributionRows + usage.panelRows + usage.collectionRows
    : 0;
  if (!usage || total === 0) {
    return {
      key: "synced",
      label,
      state: "no",
      detail: "no rows stored for this project yet, so other devices have nothing to show",
    };
  }
  return {
    key: "synced",
    label,
    state: "ok",
    detail: `${plural(usage.contributionRows, "place")}, ${plural(usage.panelRows, "panel")},`
      + ` ${plural(usage.collectionRows, "stored row")}`,
  };
}

function skillsLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Agent skills";
  const skills = snapshot.manifest?.skills.length ?? 0;
  if (skills === 0) {
    return { key: "skills", label, state: "na", detail: "this plugin ships no agent skill" };
  }
  return {
    key: "skills",
    label,
    state: "ok",
    detail: `${plural(skills, "skill")} · ${PLUGIN_SKILL_NEXT_TURN_NOTE}`,
  };
}

/**
 * Where this plugin is allowed to talk to, and whether it has been refused.
 *
 * Two facts on one line because they answer one question. The declaration comes
 * from the manifest, which is readable with ADE closed; the refusals come from
 * the plugin's own log ring, which the child writes a `warn` line to every time
 * the network guard turns a request away. "It declares api.cursor.com and has
 * been refused twice" is the shape of the answer somebody debugging a plugin
 * that will not load its list actually needs.
 */
function networkLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Network";
  const hosts = snapshot.manifest?.network?.hosts ?? [];
  if (snapshot.manifest && !snapshot.manifest.entry) {
    return { key: "network", label, state: "na", detail: "this plugin runs no code of its own" };
  }
  const refusals = (snapshot.live?.detail?.logs ?? []).filter(
    (entry) => entry.fields?.code === PLUGIN_NETWORK_REFUSAL_LOG_CODE,
  );
  if (hosts.length === 0) {
    return {
      key: "network",
      label,
      state: refusals.length > 0 ? "no" : "na",
      detail: refusals.length > 0
        ? `declares no hosts, and ${plural(refusals.length, "request")} was refused`
          + ` — run: ade plugin logs ${snapshot.pluginId}`
        : "declares no hosts, so it reaches nothing on the internet",
    };
  }
  const refusalNote = refusals.length > 0
    ? `; ${plural(refusals.length, "request")} refused — run: ade plugin logs ${snapshot.pluginId}`
    : "";
  return {
    key: "network",
    label,
    state: refusals.length > 0 ? "no" : "ok",
    detail: `may contact ${hosts.join(", ")}${refusalNote}`,
  };
}

/**
 * Which of ADE's own API keys this plugin reads, and whether they are there.
 *
 * The rung exists because a missing key looks exactly like a broken plugin from
 * the outside: the panel is empty, the action fails, and nothing on any other
 * rung says the reason is a credential the user never connected. The live half
 * is presence only — `plugin.get` carries a boolean per provider and never the
 * key.
 */
function providerKeysLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Provider keys";
  const declared = snapshot.manifest?.providerKeys ?? [];
  if (declared.length === 0) {
    return { key: "providerKeys", label, state: "na", detail: "this plugin reads none of ADE's API keys" };
  }
  const named = declared.map((provider) => PLUGIN_PROVIDER_KEY_LABELS[provider] ?? provider);
  if (!snapshot.live) {
    return {
      key: "providerKeys",
      label,
      state: "unknown",
      detail: `reads your ${named.join(", ")} key; ${UNREACHABLE}`,
    };
  }
  const presence = snapshot.live.detail?.providerKeys;
  // An older host answers `plugin.get` without the field, which is not the same
  // as answering "no keys" — same distinction `lastRun` makes.
  if (!presence) {
    return {
      key: "providerKeys",
      label,
      state: "unknown",
      detail: `reads your ${named.join(", ")} key; this copy of ADE does not report whether it is connected`,
    };
  }
  const missing = declared.filter(
    (provider) => !presence.some((entry) => entry.provider === provider && entry.present),
  );
  if (missing.length === 0) {
    return {
      key: "providerKeys",
      label,
      state: "ok",
      detail: `${named.join(", ")} — connected`,
    };
  }
  const missingNames = missing.map((provider) => PLUGIN_PROVIDER_KEY_LABELS[provider] ?? provider);
  return {
    key: "providerKeys",
    label,
    state: "no",
    detail: `no ${missingNames.join(", ")} key is connected — add one in Settings → AI`,
  };
}

/**
 * Which of THIS PROJECT's secrets the plugin may read.
 *
 * Declaration only, and deliberately so: whether the named secret exists is the
 * project's business and printing "STRIPE_API_KEY is set" would put the shape
 * of the user's `.env` in a report people paste into issues. What the rung
 * answers is the question the platform's own gate answers — "may it, and which
 * ones" — so a plugin failing with `not_permitted` has a line to look at.
 */
function projectSecretsLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Project secrets";
  const declared = snapshot.manifest?.projectSecrets ?? [];
  if (declared.length === 0) {
    return {
      key: "projectSecrets",
      label,
      state: "na",
      detail: "this plugin reads none of this project's secrets",
    };
  }
  return {
    key: "projectSecrets",
    label,
    state: "ok",
    detail: `may read ${declared.join(", ")} — and no other project secret`,
  };
}

/**
 * The ladder, in the order a plugin actually climbs it.
 *
 * Pure, and takes a snapshot rather than a transport, so every branch here is
 * reachable from a test without a socket.
 */
export function buildPluginDoctorReport(
  snapshot: PluginDoctorSnapshot,
  /** Injected by the test that pins the age wording; production reads the clock. */
  now: number = Date.now(),
): PluginDoctorReport {
  const clients = describePluginClientRendering(
    (snapshot.manifest?.sockets ?? []).map((socket) => socket.socket),
  );
  const actions = buildDoctorActions(snapshot);
  const socketClause = formatPluginClientRendering(clients);
  const railClause = describeRailRendering(snapshot.manifest);
  return {
    pluginId: snapshot.pluginId,
    displayName: snapshot.manifest?.displayName ?? snapshot.live?.detail?.displayName ?? snapshot.pluginId,
    version: snapshot.manifest?.version ?? snapshot.record?.version ?? null,
    layers: [
      sourceLayer(snapshot),
      installedLayer(snapshot),
      runningLayer(snapshot),
      placesLayer(snapshot),
      customPageLayer(snapshot),
      lastRunLayer(snapshot, actions, now),
      shortcutsLayer(snapshot),
      ingressLayer(snapshot, now),
      panelsLayer(snapshot),
      panelReachLayer(snapshot),
      syncedLayer(snapshot),
      skillsLayer(snapshot),
      // Last, because these are the rungs about what the plugin reaches beyond
      // its own box — the internet, the user's API keys, the project's secrets.
      // A reader scanning for the first ✗ has passed everything cheaper by the
      // time they get here.
      networkLayer(snapshot),
      providerKeysLayer(snapshot),
      projectSecretsLayer(snapshot),
    ],
    clients,
    // Sockets first, because that sentence is the one the module derives from
    // the support matrix. The rail clause is appended rather than folded in:
    // a rail surface is not a socket, has no per-client support row, and the
    // one thing worth saying about it varies by KIND rather than by client.
    renders: [socketClause, railClause].filter(Boolean).join(" · "),
    actions,
  };
}

const STATE_GLYPH: Record<PluginDoctorState, string> = {
  ok: "✓",
  no: "✗",
  na: "–",
  unknown: "–",
};

/** The human answer: one line per layer, then the per-client sentence. */
export function formatPluginDoctorReport(report: PluginDoctorReport): string {
  const width = Math.max(...report.layers.map((layer) => layer.label.length));
  const head = report.version
    ? `${report.displayName} (${report.pluginId}) ${report.version}`
    : `${report.displayName} (${report.pluginId})`;
  const lines = [
    head,
    "",
    ...report.layers.map((layer) =>
      `  ${STATE_GLYPH[layer.state]} ${layer.label.padEnd(width)}  ${layer.detail}`),
  ];
  if (report.renders) lines.push("", `  ${report.renders}`);
  return `${lines.join("\n")}\n`;
}
