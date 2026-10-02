import { useEffect, useMemo, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatEventEnvelope, AgentChatUsageAccount } from "../../../shared/types/chat";
import type { HarnessPreset } from "../../../shared/harnessPresets";
import {
  isProviderInstanceProvider,
  type ProviderInstance,
  type ProviderInstanceProvider,
} from "../../../shared/types/providerInstances";
import { providerDisplayName } from "../../../shared/pendingInputLabels";
import { ProviderLogo } from "../shared/ProviderLogos";

/**
 * Which login, key or endpoint a chat runs on, as one quiet row pinned to the
 * bottom of the chat actions drawer.
 *
 * Truth comes in order: the account the latest finished turn reported (it is
 * what actually paid), then the account the chat is bound to (its
 * `instanceId`, resolved against this machine's provider-account registry),
 * then nothing. A provider with one identity per machine and no reported
 * email renders nothing rather than a placeholder.
 */

type ChatAccountNoteModel = {
  /** ProviderLogo family. */
  family: string;
  /** Email, "API key", or the local endpoint. */
  primary: string;
  /** Full detail for the hover title. */
  detail: string;
};

type ChatAccountNoteInput = {
  provider: string;
  /** The session's bound account. Absent on claude/codex means the default. */
  sessionInstanceId?: string | null;
  sessionCredentialId?: string | null;
  /** The latest finished turn's account, when one reported it. */
  turnAccount?: AgentChatUsageAccount | null;
  /** This provider's registry rows, or null while unread / unavailable. */
  instances: readonly ProviderInstance[] | null;
  /** The session's harness preset, when it launched under one. */
  preset?: HarnessPreset | null;
  /** The stored key's label for `sessionCredentialId`, when it was read. */
  credentialLabel?: string | null;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/** The registry row a chat bound to `instanceId` actually launches on. */
function findInstance(
  instances: readonly ProviderInstance[] | null,
  provider: ProviderInstanceProvider,
  instanceId: string,
): ProviderInstance | null {
  if (!instances) return null;
  const forProvider = instances.filter((instance) => instance.provider === provider);
  // An id that no longer names an account falls back to the default at launch.
  return forProvider.find((instance) => instance.id === instanceId)
    ?? forProvider.find((instance) => instance.isDefault)
    ?? null;
}

/** The key name behind a keyed run: the preset's name, else the stored key's label. */
function keyName(input: ChatAccountNoteInput): string | null {
  const preset = input.preset ?? null;
  if (preset) return clean(preset.name) ?? (preset.source.kind === "key" ? clean(preset.source.label) : null);
  return clean(input.credentialLabel);
}

function resolveChatAccountNote(input: ChatAccountNoteInput): ChatAccountNoteModel | null {
  const provider = clean(input.provider);
  if (!provider) return null;
  const providerName = providerDisplayName(provider);
  const multi = isProviderInstanceProvider(provider) ? provider : null;
  const boundInstanceId = multi ? (clean(input.sessionInstanceId) ?? multi) : null;

  // A turn from before a provider handoff, or from before a usage-limit move
  // to another account, no longer describes where the next turn runs.
  let turn = input.turnAccount && input.turnAccount.provider === provider ? input.turnAccount : null;
  const turnInstanceId = clean(turn?.instanceId);
  if (turn && multi && turnInstanceId && turnInstanceId !== boundInstanceId) turn = null;

  const sourceLine = turn ? "Ran the latest turn." : "Bound to this chat; no turn has reported its account yet.";

  if (turn?.kind === "api_key" || (!turn && (clean(input.sessionCredentialId) || input.preset?.source.kind === "key"))) {
    const name = keyName(input);
    const upstream = clean(turn?.upstream);
    return {
      family: provider,
      primary: "API key",
      detail: [`${providerName} · API key`, name, upstream ? `Model vendor: ${upstream}` : null, sourceLine]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (turn?.kind === "local") {
    const endpoint = clean(turn.endpoint);
    const upstream = clean(turn.upstream);
    return {
      family: provider,
      primary: endpoint ?? "Local model",
      detail: [`${providerName} · local model`, endpoint, upstream ? `Server: ${upstream}` : null, sourceLine]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const instance = multi && boundInstanceId
    ? findInstance(input.instances, multi, turnInstanceId ?? boundInstanceId)
    : null;
  const email = clean(turn?.email) ?? clean(instance?.account?.email);
  const plan = clean(turn?.plan) ?? clean(instance?.account?.plan);
  const label = clean(instance?.label);
  const primary = email ?? label;
  if (!primary) return null;
  return {
    family: provider,
    primary,
    detail: [
      `${providerName} account`,
      email,
      label ? `Account: ${label}${instance?.isDefault ? " (default)" : ""}` : null,
      plan ? `Plan: ${plan}` : null,
      instance && instance.loginBroken ? "Signed out: this account needs a new sign-in." : null,
      sourceLine,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** The account the latest finished turn reported, scanning back from the end. */
function latestTurnAccount(events: readonly AgentChatEventEnvelope[]): AgentChatUsageAccount | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "done" && event.account) return event.account;
  }
  return null;
}

/**
 * Last answer per key (machine plus provider, or machine plus key id). A chat
 * switch renders the previous answer at once and reads again behind it, so
 * the note does not blink.
 */
const readCache = new Map<string, unknown>();

function pinScopeKey(pin: OpenProjectBinding | null): string {
  return pin?.key ?? "bound";
}

/**
 * One cached read for the note. It runs when `cacheKey` or `rereadToken`
 * changes; `once` skips the read when the cache already holds an answer.
 * Nothing here emits change events, so nothing is polled. A failed read
 * leaves the last answer (or nothing) on screen: the note is decoration on a
 * working chat.
 */
function useCachedRead<T>(
  cacheKey: string | null,
  read: () => Promise<T> | null,
  options: { rereadToken?: string | null; once?: boolean } = {},
): T | null {
  const [answer, setAnswer] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!cacheKey || (options.once && readCache.has(cacheKey))) return;
    const pending = read();
    if (!pending) return;
    let cancelled = false;
    pending.then((value) => {
      readCache.set(cacheKey, value);
      if (!cancelled) setAnswer({ key: cacheKey, value });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `read` is rebuilt each render; the key and token say when to call it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, options.rereadToken]);
  if (!cacheKey) return null;
  if (answer?.key === cacheKey) return answer.value;
  return (readCache.get(cacheKey) as T | undefined) ?? null;
}

export function ChatAccountNote({
  provider,
  instanceId,
  credentialId,
  preset,
  events,
  runtimePin,
}: {
  provider: string;
  instanceId?: string | null;
  credentialId?: string | null;
  preset?: HarnessPreset | null;
  events: readonly AgentChatEventEnvelope[];
  /** The chat's machine; null is the tab's own binding. */
  runtimePin: OpenProjectBinding | null;
}) {
  const turnAccount = useMemo(() => latestTurnAccount(events), [events]);
  const multi = isProviderInstanceProvider(provider) ? provider : null;
  const boundInstanceId = multi ? (clean(instanceId) ?? multi) : null;
  // The registry is read again when the bound account changes (a move).
  const instances = useCachedRead<ProviderInstance[]>(
    multi ? `accounts|${pinScopeKey(runtimePin)}|${multi}` : null,
    () => (multi ? window.ade?.providerInstances?.list({ provider: multi }, runtimePin) ?? null : null),
    { rereadToken: boundInstanceId },
  );
  const keyId = !preset ? clean(credentialId) : null;
  const credentialLabel = useCachedRead<string | null>(
    keyId ? `key|${pinScopeKey(runtimePin)}|${keyId}` : null,
    () => window.ade?.apiCredentials?.list({}, runtimePin)
      .then((rows) => clean(rows.find((row) => row.credentialId === keyId)?.label)) ?? null,
    { once: true },
  );
  const model = useMemo(
    () => resolveChatAccountNote({
      provider,
      sessionInstanceId: instanceId,
      sessionCredentialId: credentialId,
      turnAccount,
      instances,
      preset,
      credentialLabel,
    }),
    [provider, instanceId, credentialId, turnAccount, instances, preset, credentialLabel],
  );
  if (!model) return null;
  return (
    <div
      data-testid="chat-account-note"
      className="flex h-[30px] min-w-0 items-center gap-2 px-4 font-sans text-[11px] leading-4"
      title={model.detail}
    >
      <span className="flex shrink-0 items-center opacity-80" aria-hidden>
        <ProviderLogo family={model.family} size={13} />
      </span>
      {/* Only the email (or key / endpoint): the label and plan live in the
          hover title, so the row never has to cut anything off. */}
      <span className="min-w-0 truncate text-fg/60">{model.primary}</span>
    </div>
  );
}
