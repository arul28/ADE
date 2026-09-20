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
  [IPC.transcriptionTranscribe]: new Set(["pcm"]),
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
  // All three key-store channels carry the raw provider credential as `key`.
  // These entries are the ONLY thing redacting it: the generic guard below
  // does not treat a bare `key` as a secret, because it is the ordinary word
  // for a lookup key on channels that carry nothing sensitive.
  [IPC.aiStoreApiKey]: new Set(["key"]),
  [IPC.aiStoreMachineApiKey]: new Set(["key"]),
  [IPC.aiSetOpencodeProviderKey]: new Set(["key"]),
  // A project secret's whole point is that its value never leaves the store in
  // the clear. `value` is too ordinary a word for the generic guard, `content`
  // is a whole .env file, and `secrets` is a list of name/value pairs.
  [IPC.projectSecretsSet]: new Set(["value"]),
  [IPC.projectSecretsPreviewEnvImport]: new Set(["content"]),
  [IPC.projectSecretsImportEnv]: new Set(["secrets"]),
};

/**
 * Field names whose VALUE is a secret whatever channel it arrived on.
 *
 * The channel map above is the specific statement; this is the backstop for a
 * channel nobody remembered to list. Data rather than a boolean chain so the
 * two kinds of rule stay visibly different: a SUBSTRING match is a family of
 * names (`apiToken`, `refresh_token`), an EXACT match is one name that would
 * over-match as a substring.
 *
 * A bare `key` is deliberately NOT here. It reads as a credential and is one
 * on the key-store channels — which the channel map above names outright —
 * but it is also the ordinary word for a lookup key
 * (`projectSetRecentPinned { key, pinned }`), and blanking it generically
 * empties the traces that exist to explain those calls.
 *
 * Lives here rather than in `registerIpc` so the contract has a test.
 */
const SECRET_SUBSTRINGS = ["token", "secret", "password", "authorization"] as const;
const SECRET_EXACT = ["apikey", "api_key", "pairingpin", "pairing_pin"] as const;

export function shouldRedactIpcKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.toLowerCase();
  return SECRET_SUBSTRINGS.some((needle) => normalized.includes(needle))
    || SECRET_EXACT.some((name) => normalized === name);
}

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
