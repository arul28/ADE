/**
 * "Will my button show up on my phone?" — the one question the socket taxonomy
 * can answer and never did, in the words the person asking it uses.
 *
 * The alpha test that produced `docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md`
 * failed here more than anywhere else: a plugin was installed, enabled, running
 * and publishing rows, and the phone still showed nothing — because the phone
 * does not draw the kind that plugin had declared. Every layer knew that. None
 * of them said it. So the user read one system where there were seven, and read
 * a correct platform answer as a broken plugin.
 *
 * This module is the sentence those layers were missing. It is DERIVED, never
 * restated: {@link PLUGIN_SOCKET_CLIENT_SUPPORT} in `sockets.ts` remains the
 * single source of which client draws which kind, and a parity pass that flips
 * one token there changes what the CLI prints and what the Marketplace page
 * says without anyone editing either. A second hand-maintained table here would
 * be a promise about four clients that nothing checks.
 *
 * Pure. No React, no Node, no Electron — the `ade plugin doctor` command and
 * the Marketplace rail both read it, and they have no other code in common.
 */

import {
  PLUGIN_CLIENT_SURFACES,
  PLUGIN_SOCKET_KINDS,
  pluginSocketSupportedOn,
  type PluginClientSurface,
  type PluginSocketKind,
} from "./sockets";

/**
 * What a person calls each client.
 *
 * `ios` is "iPhone" and not "iOS" on purpose: the reader is holding the thing,
 * not naming an operating system. `tui` is "terminal" for the same reason —
 * nobody outside this repository knows what a TUI is.
 */
export const PLUGIN_CLIENT_LABELS: Record<PluginClientSurface, string> = {
  desktop: "desktop",
  web: "web",
  ios: "iPhone",
  tui: "terminal",
};

/**
 * Why a kind is absent on one client, in that client's own words.
 *
 * Absent is never half-drawn — a client that has not grown an arm for a kind
 * drops it where it decodes — so these say "not drawn", which is the whole
 * truth, rather than "unsupported", which sounds like a fault someone should
 * report.
 */
export const PLUGIN_CLIENT_ABSENT_REASON: Record<PluginClientSurface, string> = {
  desktop: "not drawn on desktop",
  web: "not drawn on the web",
  ios: "not drawn on phones",
  tui: "not drawn in the terminal",
};

/** One client's answer about one plugin's declared kinds. */
export type PluginClientRenderAnswer = {
  client: PluginClientSurface;
  /** {@link PLUGIN_CLIENT_LABELS}, carried so callers need not re-look it up. */
  label: string;
  /** Declared kinds this client draws, in taxonomy order. */
  drawn: PluginSocketKind[];
  /** Declared kinds this client does not draw, in taxonomy order. */
  absent: PluginSocketKind[];
  /** True when at least one declared kind reaches this client. */
  renders: boolean;
};

/**
 * Answer for every client, from the kinds a plugin declares.
 *
 * Input is deliberately the KINDS rather than a manifest: the CLI reads them
 * off `manifest.sockets`, the Marketplace reads them off the same manifest, and
 * a future caller may have only a list of published rows. Duplicates collapse
 * and the result is in taxonomy order, so two plugins declaring the same set
 * produce the same answer whatever order they wrote it in.
 */
export function describePluginClientRendering(
  kinds: Iterable<PluginSocketKind>,
): PluginClientRenderAnswer[] {
  const declared = new Set(kinds);
  const ordered = PLUGIN_SOCKET_KINDS.filter((kind) => declared.has(kind));
  return PLUGIN_CLIENT_SURFACES.map((client) => {
    const drawn = ordered.filter((kind) => pluginSocketSupportedOn(kind, client));
    const absent = ordered.filter((kind) => !pluginSocketSupportedOn(kind, client));
    return {
      client,
      label: PLUGIN_CLIENT_LABELS[client],
      drawn,
      absent,
      renders: drawn.length > 0,
    };
  });
}

/** How many kinds one client's summary names before it starts counting. */
const NAMED_KIND_LIMIT = 3;

function nameKinds(kinds: readonly PluginSocketKind[]): string {
  if (kinds.length <= NAMED_KIND_LIMIT) return kinds.join(", ");
  const named = kinds.slice(0, NAMED_KIND_LIMIT).join(", ");
  return `${named} +${kinds.length - NAMED_KIND_LIMIT} more`;
}

/** One client's clause: `iPhone ✓ composer-action / ✗ slash-command (not drawn on phones)`. */
export function formatPluginClientAnswer(answer: PluginClientRenderAnswer): string {
  if (answer.drawn.length === 0) return `${answer.label} ✗`;
  if (answer.absent.length === 0) return `${answer.label} ✓ (${nameKinds(answer.drawn)})`;
  return `${answer.label} ✓ ${nameKinds(answer.drawn)} / ✗ ${nameKinds(answer.absent)}`
    + ` (${PLUGIN_CLIENT_ABSENT_REASON[answer.client]})`;
}

/**
 * The whole per-client answer on one line, for a terminal.
 *
 * Empty string when the plugin declares no sockets at all: a plugin with
 * nothing to place has no honest answer here, and "renders nowhere" would read
 * as a fault rather than as "you did not ask for a place".
 */
export function formatPluginClientRendering(answers: readonly PluginClientRenderAnswer[]): string {
  const clauses = answers.filter((answer) => answer.drawn.length > 0 || answer.absent.length > 0);
  if (clauses.length === 0) return "";
  return `Renders on: ${clauses.map(formatPluginClientAnswer).join(" · ")}`;
}

/**
 * The timing sentence, said the same way everywhere a skill arrives.
 *
 * The retrospective's sharpest confusion: the plugin was installed, the drink
 * count went up, and the agent in the visible chat stayed sober. A skill is
 * read at the START of a turn — it is not a live interceptor, it does not
 * rewrite a running turn's context, and nothing on screen said so. One
 * sentence, at every place an install completes, is the whole fix.
 */
export const PLUGIN_SKILL_NEXT_TURN_NOTE =
  "Affects agents from their next turn — running turns keep their current behavior.";
