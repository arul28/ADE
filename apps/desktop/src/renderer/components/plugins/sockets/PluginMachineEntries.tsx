import React from "react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import { isRecord } from "../../../../shared/plugins/parse";
import {
  pluginSocketInvokeTimeoutMs,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import { useRootAppStore } from "../../../state/appStore";
import { supportsPluginWebviews } from "../PluginWebviewHost";
import { invokePluginSocketAction } from "./contributionBridge";
import { contributionKey } from "./contributionModel";
import { openPluginActionWebview } from "./pluginActionDispatch";
import { resolvePluginDeclaredWebview } from "./pluginDeclaredWebview";
import { useSurfaceContributions } from "./useSurfaceContributions";

/**
 * Contributed rows in the composer's machine picker.
 *
 * A machine row is a MODE, not a button: selecting it does not invoke anything,
 * it changes what Enter does. The whole kind exists so "where does this run"
 * stays one question — a hosted runtime a plugin owns sits in the same list as
 * this computer and the other paired ones, because that is the question the
 * reader is answering.
 */

/**
 * The namespace a contributed row's option id lives in.
 *
 * Real machine ids are host uuids, `THIS_MACHINE_ID`, or the compiled
 * `CURSOR_CLOUD_MACHINE_ID`; none of them can begin with this prefix, and the
 * colon is not a character any of them contain. So the picker's `onChange`
 * can tell a contributed row from a machine by its id alone rather than by
 * carrying a parallel lookup table that could disagree with the list.
 */
export const PLUGIN_MACHINE_OPTION_PREFIX = "plugin-machine:";

/** The parts of a contribution key an option id round-trips. */
export type PluginMachineOptionRef = {
  pluginId: string;
  /** Always `machine-entry`; carried so the id round-trips the whole key. */
  socket: string;
  /** The manifest socket id — `contributionKey`'s third part. */
  id: string;
};

/**
 * A contribution key as an option id.
 *
 * `contributionKey` joins its three parts with NUL, which survives neither a
 * DOM attribute nor a URL, so each part is percent-encoded and joined with `/`.
 * Encoding is what makes the parse unambiguous: a plugin id containing a slash
 * would otherwise split into the wrong three parts and select a row that does
 * not exist.
 */
export function pluginMachineOptionId(ref: PluginMachineOptionRef): string {
  return `${PLUGIN_MACHINE_OPTION_PREFIX}${[ref.pluginId, ref.socket, ref.id]
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

/** True for an id this module minted. Cheap enough to call per row. */
export function isPluginMachineOptionId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PLUGIN_MACHINE_OPTION_PREFIX);
}

/**
 * The contribution an option id names, or null.
 *
 * Null for anything that is not one of ours and for a malformed tail — a real
 * machine id, a truncated id, an id with the wrong number of parts. The caller
 * treats null as "a machine", which is what it did before this kind existed.
 */
export function parsePluginMachineOptionId(value: string | null | undefined): PluginMachineOptionRef | null {
  if (!isPluginMachineOptionId(value)) return null;
  const parts = value!.slice(PLUGIN_MACHINE_OPTION_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  try {
    const [pluginId, socket, id] = parts.map((part) => decodeURIComponent(part));
    if (!pluginId || !socket || !id) return null;
    return { pluginId, socket, id };
  } catch {
    // A tail that is not valid percent-encoding. `decodeURIComponent` throws
    // on a lone `%`, and an id nobody can decode names no row.
    return null;
  }
}

/** One contributed launch target, flattened for the picker and the composer. */
export type PluginMachineEntry = {
  /** `contributionKey` — identity for state held across renders. */
  key: string;
  /** The picker's option id. See {@link pluginMachineOptionId}. */
  optionId: string;
  pluginId: string;
  label: string;
  icon?: string;
  /** Invoked on Enter with `args.send === true`. */
  actionId: string;
  /** A `webview` surface opened by the row's "Advanced…" affordance. */
  advancedSurfaceId?: string;
  /** An action answering `{ modelIds: string[] }`. */
  modelsAction?: string;
  /** Which of the plugin's `chatRuntimes` owns the sessions this row launches. */
  runtimeId?: string;
};

export function usePluginMachineEntries({
  surface = "work",
  sessionId,
  projectKey = null,
  projectRoot = null,
  laneId = null,
  active = true,
}: {
  surface?: PluginSurfaceId;
  sessionId: string | null;
  projectKey?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  active?: boolean;
}): PluginMachineEntry[] {
  const identity = React.useMemo<PluginComposerContext>(
    () => ({
      kind: "composer",
      sessionId,
      projectKey,
      projectRoot,
      laneId,
      draft: "",
      cursor: null,
    }),
    [laneId, projectKey, projectRoot, sessionId],
  );
  const contributions = useSurfaceContributions(surface, "machine-entry", {
    active,
    context: identity,
  });
  return React.useMemo(() => contributions.map((contribution) => {
    const key = contributionKey(contribution);
    return {
      key,
      optionId: pluginMachineOptionId({
        pluginId: contribution.pluginId,
        socket: contribution.socket,
        id: contribution.id,
      }),
      pluginId: contribution.pluginId,
      label: contribution.payload.label,
      actionId: contribution.payload.actionId,
      ...(contribution.payload.icon ? { icon: contribution.payload.icon } : {}),
      ...(contribution.payload.advancedSurfaceId
        ? { advancedSurfaceId: contribution.payload.advancedSurfaceId }
        : {}),
      ...(contribution.payload.modelsAction
        ? { modelsAction: contribution.payload.modelsAction }
        : {}),
      ...(contribution.payload.runtimeId ? { runtimeId: contribution.payload.runtimeId } : {}),
    } satisfies PluginMachineEntry;
  }), [contributions]);
}

/**
 * Longest model list a contributed machine may narrow the picker to.
 *
 * The picker is a scrolling menu, not a catalogue: a plugin answering with ten
 * thousand ids would build ten thousand rows on the render that follows a
 * click. Extra ids are DROPPED rather than the whole answer refused — a machine
 * that really does run a hundred models is still usable.
 */
export const PLUGIN_MACHINE_MODEL_IDS_MAX = 200;

/** Model ids are catalogue keys (`anthropic/claude-sonnet-5`), never prose. */
const MODEL_ID_MAX_LENGTH = 128;

/**
 * `{ modelIds: string[] }` off a plugin's answer, or null.
 *
 * Null means "leave ADE's own list alone", and every failure lands there: a
 * refusal (`ok: false`), a non-object answer, a missing or non-array
 * `modelIds`, and an array with no usable string in it. That is the difference
 * between narrowing the picker and EMPTYING it — an empty list would leave the
 * composer with no model to send with and no way back, which is the wedge this
 * function exists to make impossible.
 */
export function readPluginMachineModelIds(result: unknown): string[] | null {
  if (!isRecord(result)) return null;
  if (result.ok === false) return null;
  const raw = result.modelIds;
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || id.length > MODEL_ID_MAX_LENGTH) continue;
    if (ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= PLUGIN_MACHINE_MODEL_IDS_MAX) break;
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Ask a contributed machine which models it runs.
 *
 * Invoked through the raw bridge rather than `runPluginSocketAction`, because
 * that dispatcher returns `Promise<void>` — it exists to APPLY an answer's
 * verbs, and this caller needs the answer's data. It also never rejects, and a
 * refusal here has to be distinguishable from an empty one so the picker keeps
 * ADE's list rather than narrowing to nothing.
 *
 * Never rejects. A throw, a timeout and a malformed answer all resolve to null.
 */
export function usePluginMachineModelIds(): (
  entry: PluginMachineEntry,
  context: PluginComposerContext,
) => Promise<string[] | null> {
  return React.useCallback(async (entry, context) => {
    if (!entry.modelsAction) return null;
    try {
      const result = await invokePluginSocketAction(
        entry.pluginId,
        entry.modelsAction,
        { context },
        // The machine-entry budget: this runs once on selection and the reader
        // is waiting on the model picker, so it takes the ordinary socket
        // round trip rather than a composer action's minutes.
        { timeoutMs: pluginSocketInvokeTimeoutMs("machine-entry") },
      );
      return readPluginMachineModelIds(result);
    } catch {
      return null;
    }
  }, []);
}

/**
 * Open a contributed machine's "Advanced…" page.
 *
 * Returns false when there is nothing to open — no declaration, an
 * uninstalled or disabled plugin, a renamed surface, or a client with no page
 * host — so the caller can leave the affordance off the row entirely rather
 * than drawing a control that does nothing.
 *
 * Selecting the row and pressing Advanced are different gestures on purpose:
 * the page is the LAUNCH form, and someone who wants to configure a run before
 * committing to it should not have to enter the mode first.
 */
export function usePluginMachineAdvancedPress(): (
  entry: PluginMachineEntry,
  subject: PluginComposerContext | null,
) => boolean {
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const supported = supportsPluginWebviews();
  return React.useCallback((entry, subject) => {
    const page = resolvePluginDeclaredWebview({
      pluginId: entry.pluginId,
      surfaceId: entry.advancedSurfaceId,
      installed: installedPlugins,
      supported,
    });
    if (!page) return false;
    openPluginActionWebview({
      pluginId: entry.pluginId,
      surfaceId: page.surfaceId,
      // Over the composer it is about to launch from, not under the row: the
      // row unmounts with the picker the press just closed.
      placement: "picker",
      subject,
      anchor: null,
    });
    return true;
  }, [installedPlugins, supported]);
}

/**
 * Whether a contributed machine's row can offer "Advanced…" at all.
 *
 * The same four-clause resolution the press makes, asked at RENDER time so the
 * affordance is absent rather than dead. A control that is drawn and refuses is
 * worse than one that was never drawn: the reader presses it twice.
 */
export function usePluginMachineAdvancedAvailable(): (entry: PluginMachineEntry) => boolean {
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const supported = supportsPluginWebviews();
  return React.useCallback((entry) => Boolean(resolvePluginDeclaredWebview({
    pluginId: entry.pluginId,
    surfaceId: entry.advancedSurfaceId,
    installed: installedPlugins,
    supported,
  })), [installedPlugins, supported]);
}
