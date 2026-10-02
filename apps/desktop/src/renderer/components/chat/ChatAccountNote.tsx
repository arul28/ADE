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
 * Last registry read per machine and provider. A chat switch renders the
 * previous answer at once and refreshes behind it, so the note does not blink.
 */
const registryCache = new Map<string, ProviderInstance[]>();
const credentialLabelCache = new Map<string, string | null>();

function pinScopeKey(pin: OpenProjectBinding | null): string {
  return pin?.key ?? "bound";
}

/**
 * This provider's accounts on the chat's machine. The registry emits no change
 * event, so it is read when the chat, its bound account or its machine
 * changes — never polled.
 */
function useProviderRegistry(
  provider: ProviderInstanceProvider | null,
  boundInstanceId: string | null,
  pin: OpenProjectBinding | null,
): ProviderInstance[] | null {
  const cacheKey = provider ? `${pinScopeKey(pin)}|${provider}` : null;
  const [read, setRead] = useState<{ key: string; instances: ProviderInstance[] } | null>(null);
  useEffect(() => {
    if (!provider || !cacheKey) return;
    const api = typeof window === "undefined" ? null : window.ade?.providerInstances ?? null;
    if (!api) return;
    let cancelled = false;
    api.list({ provider }, pin).then((instances) => {
      registryCache.set(cacheKey, instances);
      if (!cancelled) setRead({ key: cacheKey, instances });
    }).catch(() => {
      // The note is decoration on a working chat; an unreadable registry
      // leaves the turn's own report (or nothing) on screen.
    });
    return () => {
      cancelled = true;
    };
    // `pin` is covered by `cacheKey`; `boundInstanceId` re-reads after a move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, cacheKey, boundInstanceId]);
  if (!cacheKey) return null;
  if (read?.key === cacheKey) return read.instances;
  return registryCache.get(cacheKey) ?? null;
}

/** The stored key's label, read once per key and machine. */
function useCredentialLabel(credentialId: string | null, pin: OpenProjectBinding | null): string | null {
  const cacheKey = credentialId ? `${pinScopeKey(pin)}|${credentialId}` : null;
  const [read, setRead] = useState<{ key: string; label: string | null } | null>(null);
  useEffect(() => {
    if (!credentialId || !cacheKey || credentialLabelCache.has(cacheKey)) return;
    const api = typeof window === "undefined" ? null : window.ade?.apiCredentials ?? null;
    if (!api) return;
    let cancelled = false;
    api.list({}, pin).then((rows) => {
      const label = clean(rows.find((row) => row.credentialId === credentialId)?.label);
      credentialLabelCache.set(cacheKey, label);
      if (!cancelled) setRead({ key: cacheKey, label });
    }).catch(() => {
      // Without the label the row still says "API key".
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId, cacheKey]);
  if (!cacheKey) return null;
  if (read?.key === cacheKey) return read.label;
  return credentialLabelCache.get(cacheKey) ?? null;
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
  const instances = useProviderRegistry(multi, boundInstanceId, runtimePin);
  const wantsKeyLabel = !preset && clean(credentialId) != null;
  const credentialLabel = useCredentialLabel(wantsKeyLabel ? clean(credentialId) : null, runtimePin);
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
