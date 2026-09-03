/**
 * What the host pointed this placement at.
 *
 * A surface is opened three ways — a rail tab with nothing selected, a socket
 * that names the thing it was pressed on, and a deeplink that names it in the
 * URL — and the bridge carries all three in the same envelope: `subject` is the
 * entity the host had in hand, `pointer` the free-form record a deeplink or a
 * socket attached to it.
 *
 * Both are UNTRUSTED SHAPE, not untrusted content: the host wrote them, but a
 * host one version older or newer may write different keys, and a page that
 * destructured them would crash on a field that arrived as a number. So every
 * read here is a string check with a null, and `pointer` is consulted BEFORE
 * `subject` — a deeplink that names an agent is more specific than the pane it
 * happened to open in.
 */

import type { PluginWebviewContext } from "../bridge";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The agent a deeplink or a chat-header press named, if any. */
export function readAgentId(context: PluginWebviewContext): string | null {
  const subject = context.subject as Record<string, unknown> | null;
  return str(context.pointer?.agentId)
    ?? str(subject?.agentId)
    // A subject whose own kind IS the agent carries it as the plain id.
    ?? (subject?.kind === "cloud-agent" ? str(subject.id) : null);
}

/** The lane the machine row's Advanced was opened on. */
export function readLaneId(context: PluginWebviewContext): string | null {
  const subject = context.subject as Record<string, unknown> | null;
  return str(context.pointer?.laneId)
    ?? str(subject?.laneId)
    ?? (subject?.kind === "lane" ? str(subject.id) : null);
}

/** The composer text the reader had already typed when they opened Advanced. */
export function readDraft(context: PluginWebviewContext): string {
  const subject = context.subject as Record<string, unknown> | null;
  return str(context.pointer?.draft) ?? str(subject?.draft) ?? "";
}
