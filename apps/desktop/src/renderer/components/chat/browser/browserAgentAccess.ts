/**
 * "Agents can use the ADE browser" in the renderer: one shared read of the
 * setting, the saved lane/chat grants and the open prompts, kept current by the
 * main process's push event. No polling: one `get` when the first subscriber
 * mounts, then events.
 *
 * `null` means this renderer cannot reach the setting (the hosted web client,
 * or a desktop build without it); every surface hides itself then.
 */
import { useSyncExternalStore } from "react";
import type {
  BuiltInBrowserAgentAccessAnswer,
  BuiltInBrowserAgentAccessMode,
  BuiltInBrowserAgentAccessRevokeArgs,
  BuiltInBrowserAgentAccessSnapshot,
} from "../../../../shared/types/builtInBrowser";

export const BROWSER_AGENT_ACCESS_TITLE = "Agents can use the ADE browser";

/** Label and one-line consequence for each value, shared by the menu and Settings. */
export const BROWSER_AGENT_ACCESS_MODE_COPY: Record<
  BuiltInBrowserAgentAccessMode,
  { label: string; hint: string }
> = {
  all: { label: "All agents, all lanes", hint: "Agents use it without asking." },
  lanes: { label: "Agents in lanes I approve", hint: "ADE asks once for each lane." },
  chats: { label: "Chats I approve", hint: "ADE asks once for each chat." },
};

export const BROWSER_AGENT_ACCESS_MODES: readonly BuiltInBrowserAgentAccessMode[] = ["all", "lanes", "chats"];

type AgentAccessApi = {
  get: () => Promise<BuiltInBrowserAgentAccessSnapshot | null>;
  setMode: (mode: BuiltInBrowserAgentAccessMode) => Promise<BuiltInBrowserAgentAccessSnapshot | null>;
  answer: (promptId: string, answer: BuiltInBrowserAgentAccessAnswer) => Promise<BuiltInBrowserAgentAccessSnapshot | null>;
  revoke: (args: BuiltInBrowserAgentAccessRevokeArgs) => Promise<BuiltInBrowserAgentAccessSnapshot | null>;
  onChange: (cb: (snapshot: BuiltInBrowserAgentAccessSnapshot) => void) => () => void;
};

function api(): AgentAccessApi | null {
  const candidate = (typeof window === "undefined" ? null : window.ade?.builtInBrowser?.agentAccess) as
    | Partial<AgentAccessApi>
    | null
    | undefined;
  return candidate && typeof candidate.get === "function" ? (candidate as AgentAccessApi) : null;
}

function isSnapshot(value: unknown): value is BuiltInBrowserAgentAccessSnapshot {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { mode?: unknown }).mode === "string"
    && Array.isArray((value as { prompts?: unknown }).prompts),
  );
}

let current: BuiltInBrowserAgentAccessSnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function publish(next: unknown): void {
  if (!isSnapshot(next)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function start(): void {
  if (started) return;
  started = true;
  const bridge = api();
  if (!bridge) return;
  try {
    bridge.onChange((snapshot) => publish(snapshot));
  } catch {
    // No event: the one read below still seeds the UI.
  }
  void bridge.get().then(publish, () => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): BuiltInBrowserAgentAccessSnapshot | null => current;

export function useBrowserAgentAccess(): BuiltInBrowserAgentAccessSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

async function run(
  call: (bridge: AgentAccessApi) => Promise<BuiltInBrowserAgentAccessSnapshot | null>,
): Promise<void> {
  const bridge = api();
  if (!bridge) return;
  publish(await call(bridge));
}

export const browserAgentAccessActions = {
  setMode: (mode: BuiltInBrowserAgentAccessMode) => run((bridge) => bridge.setMode(mode)),
  answer: (promptId: string, answer: BuiltInBrowserAgentAccessAnswer) =>
    run((bridge) => bridge.answer(promptId, answer)),
  revoke: (args: BuiltInBrowserAgentAccessRevokeArgs) => run((bridge) => bridge.revoke(args)),
};

/** The last path segment of a project root, for "lane · project" rows. */
export function projectNameFromRoot(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  const parts = projectRoot.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? null;
}

/** A short form of an id, for the rare row ADE cannot name. */
export function shortAgentId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}
