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
import type { PluginManifest } from "../../../desktop/src/shared/plugins/manifest";
import type {
  PluginActionInvokeRecord,
  PluginContributionRecord,
  PluginDetail,
  PluginInstallRecord,
  PluginPresenceMachineRow,
  PluginUsageSummaryEntry,
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
};

export type PluginDoctorSnapshot = {
  pluginId: string;
  /** The machine install registry's entry. Read with ADE closed. */
  record: PluginInstallRecord | null;
  manifest: PluginManifest | null;
  /** Fatal manifest problems from the local parse, if any. */
  manifestErrors: string[];
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
  | "lastRun"
  | "panels"
  | "synced"
  | "skills";

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
function describeDeclaredPlaces(manifest: PluginManifest): string[] {
  const counts = new Map<string, number>();
  for (const socket of manifest.sockets) {
    const key = `${socket.socket} in ${socket.surface}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => (count === 1 ? key : `${count}× ${key}`));
}

function placesLayer(snapshot: PluginDoctorSnapshot): PluginDoctorLayer {
  const label = "Places";
  const sockets = snapshot.manifest?.sockets ?? [];
  if (sockets.length === 0) {
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
  const switchedOff = (snapshot.record?.disabledContributions ?? []).filter((id) =>
    sockets.some((socket) => socket.id === id),
  ).length;
  const offNote = switchedOff > 0 ? `; ${switchedOff} switched off here` : "";
  const published = snapshot.live
    ? `; ${plural(snapshot.live.contributions.length, "row")} published right now`
    : "; published rows unknown (ADE is not answering)";

  // Every declared socket is switched off, so nothing this plugin asks for can
  // draw anywhere. That reads as ✗ rather than ✓, because the reader is here
  // asking why they cannot see it.
  const state: PluginDoctorState = switchedOff >= sockets.length ? "no" : "ok";
  return { key: "places", label, state, detail: `${declared}${offNote}${published}` };
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
  // An older host answers `plugin.get` without the field at all, which is not
  // the same as answering "nothing has run" — saying so is the whole reason
  // this rung is worth having.
  if (!snapshot.live.detail || snapshot.live.detail.lastInvokes === undefined) {
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
  return {
    pluginId: snapshot.pluginId,
    displayName: snapshot.manifest?.displayName ?? snapshot.live?.detail?.displayName ?? snapshot.pluginId,
    version: snapshot.manifest?.version ?? snapshot.record?.version ?? null,
    layers: [
      sourceLayer(snapshot),
      installedLayer(snapshot),
      runningLayer(snapshot),
      placesLayer(snapshot),
      lastRunLayer(snapshot, actions, now),
      panelsLayer(snapshot),
      syncedLayer(snapshot),
      skillsLayer(snapshot),
    ],
    clients,
    renders: formatPluginClientRendering(clients),
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
