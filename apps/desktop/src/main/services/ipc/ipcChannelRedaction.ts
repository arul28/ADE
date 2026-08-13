import { IPC } from "../../../shared/ipc";

/**
 * Channel-aware redaction: these channels carry sensitive payloads (commands,
 * env vars, typed text, terminal data, credentials) that must NOT land in
 * structured trace logs. Redact by replacing the field with `[redacted]`
 * before the generic summarizer descends into the args.
 *
 * Lives outside `registerIpc` so the contract is reachable from a test. A
 * channel dropping out of this map is a silent leak — nothing else fails.
 */
export const ipcChannelRedactionMap: Record<string, ReadonlySet<string>> = {
  [IPC.appControlLaunch]: new Set(["command", "env"]),
  [IPC.appControlLaunchInTerminal]: new Set(["command", "env"]),
  [IPC.appControlTypeText]: new Set(["text"]),
  [IPC.appControlDispatchKey]: new Set(["text", "unmodifiedText", "key", "code"]),
  [IPC.terminalWrite]: new Set(["data"]),
  [IPC.ptySendToSession]: new Set(["text"]),
  [IPC.ptyWrite]: new Set(["data"]),
  [IPC.appOpenExternal]: new Set(["url"]),
  [IPC.builtInBrowserNavigate]: new Set(["url"]),
  [IPC.builtInBrowserCreateTab]: new Set(["url"]),
  [IPC.builtInBrowserShowPanel]: new Set(["url"]),
  [IPC.audioWriteClip]: new Set(["pcm"]),
  [IPC.accountPollLogin]: new Set(["sessionId"]),
  [IPC.accountCancelLogin]: new Set(["sessionId"]),
  [IPC.accountPairMachine]: new Set(["machineKey"]),
  [IPC.accountRenameMachine]: new Set(["machineKey", "customName"]),
  [IPC.accountRemoveMachine]: new Set(["machineKey"]),
  [IPC.attentionNotchPublishSnapshot]: new Set(["items"]),
  [IPC.attentionNotchPublishToast]: new Set(["title", "subtitle"]),
  // A Pi sign-in prompt answer is the credential itself when Pi asks for an
  // API key, so it must never reach a verbose IPC trace.
  [IPC.aiPiLoginSubmit]: new Set(["value"]),
};

export function redactIpcArgsForChannel(channel: string, args: unknown[]): unknown[] {
  const redactKeys = ipcChannelRedactionMap[channel];
  if (!redactKeys || redactKeys.size === 0) return args;
  return args.map((arg) => {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
    const record = arg as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      out[key] = redactKeys.has(key) ? "[redacted]" : val;
    }
    return out;
  });
}
