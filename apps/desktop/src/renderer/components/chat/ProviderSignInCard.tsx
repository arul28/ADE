/**
 * The sign-in card: a chat whose provider is signed out on the chat's machine.
 *
 * It takes the composer's place, the way the connect card does, wearing the
 * provider's banner and logo from its Settings page. One tap runs that
 * provider's own sign-in ON THE CHAT'S MACHINE, through the same host flows
 * Settings uses (`providerInstances.login*` for Claude and Codex,
 * `ai.cliLogin*` for the CLIs ADE signs in headlessly, Cursor's and
 * Antigravity's own actions), all routed by the chat's `pin`. The card shows
 * what that machine's sign-in printed (a link, a device code, a field for a
 * pasted code) and closes only once the machine reads the login back.
 *
 * A browser that has to come back to the machine's localhost only works when
 * the chat runs on the computer in front of the person; elsewhere the card
 * asks for the device-code form (Codex). Antigravity's Google sign-in always
 * ends on Google's page that shows a code, which is pasted here.
 * ADE relays what the person pastes into the CLI's own login and keeps
 * nothing.
 *
 * The body uses the parts of the Settings sign-in sheet (`signInSheetParts`):
 * the account note, the three steps, the code with "Open sign-in page", the
 * paste box, and the end states. There is no popup in a chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import type { KimiLoginRegion, OpenProjectBinding } from "../../../shared/types";
import { isAntigravitySignInRunning } from "../../../shared/types/config";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { settingsEntryById } from "../../../shared/settingsManifest";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { checkProviderSignIn } from "../../lib/providerSignInCheck";
import { openExternalUrl } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { ProviderLogo } from "../shared/ProviderLogos";
import { providerBrand } from "../settings/providers/providerBrand";
import { pinnedProviderInstances } from "../settings/providers/accounts/useProviderInstances";
import { formatSignInFailureReport } from "../settings/providers/providerDiagnosticsReport";
import { providerActionMessage } from "../settings/providers/providerErrorMessage";
import {
  SignInAccountNote,
  SignInCodePanel,
  SignInFailure,
  SignInMismatch,
  SignInPasteBox,
  SignInSteps,
  SignInSuccess,
  linkHost,
  signInAccountMismatch,
  signInMachineWords,
  useEnterOpensSignInPage,
  type SignInStage,
} from "../settings/providers/signInSheetParts";
import { CHAT_AUTH_RECOVERED_EVENT } from "./AgentCliAuthCard";
import { CardBannerButtons, CardError, CardReceipt, cardEscapeHandler } from "./composerCardParts";
import { ProviderCardFrame } from "./providerCardFrame";
import "./providerSignInCard.css";

const POLL_MS = 1_000;
/** How long "Signed in" stays on the card before the composer comes back. */
const SUCCESS_HOLD_MS = 1_200;
const SIGN_IN_ANALYTICS_INTERVAL_MS = 10 * 60_000;
const ANALYTICS_PROVIDERS = new Set(["claude", "codex", "cursor", "droid", "opencode", "pi", "muse"]);

/**
 * How one sign-in from the card ended (`docs/logging.md`, `chat` /
 * `provider_sign_in`). Emitted here because the card is the only place that
 * knows a chat asked for it; the host runners also serve Settings. One event
 * per attempt, the provider's coarse family only.
 */
function captureSignInOutcome(provider: string, outcome: "completed" | "cancelled" | "failed"): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: {
        feature: "chat",
        action: "provider_sign_in",
        outcome,
        provider: ANALYTICS_PROVIDERS.has(provider) ? provider : "other",
        source: "renderer_route",
      },
      // Repeated tries in a row count once per outcome.
      dedupeKey: `chat_provider_sign_in_${outcome}`,
      minimumIntervalMs: SIGN_IN_ANALYTICS_INTERVAL_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics never blocks a sign-in.
  }
}

type SignInKind = "account" | "cli" | "cursor" | "antigravity" | "settings";

type ProviderSignInSpec = {
  label: string;
  /**
   * Who the person signs in with: "Continue with Claude". Left out when the
   * sign-in belongs to the agent itself: "Sign in to Codex" runs `codex login`,
   * and "Continue with ChatGPT" is the label of OpenAI's separate app program.
   */
  via?: string;
  kind: SignInKind;
  /** The `providerBrand` id, when it is not the provider id. */
  brandId?: string;
};

const SPECS: Record<string, ProviderSignInSpec> = {
  claude: { label: "Claude Code", via: "Claude", kind: "account" },
  codex: { label: "Codex", kind: "account" },
  cursor: { label: "Cursor", via: "Cursor", kind: "cursor" },
  copilot: { label: "GitHub Copilot", via: "GitHub", kind: "cli" },
  grok: { label: "Grok", via: "xAI", kind: "cli" },
  kimi: { label: "Kimi Code", via: "Kimi", kind: "cli" },
  droid: { label: "Droid", via: "Factory", kind: "cli" },
  muse: { label: "Muse Code", via: "Meta", kind: "cli" },
  devin: { label: "Devin", via: "Devin", kind: "cli" },
  antigravity: { label: "Antigravity", via: "Google", kind: "antigravity" },
  // Signed in by a key or a sub-provider of their own: Settings has the form.
  qwen: { label: "Qwen Code", via: "Qwen", kind: "settings" },
  opencode: { label: "OpenCode", via: "OpenCode", kind: "settings" },
  pi: { label: "Pi", via: "Pi", kind: "settings" },
};

/** The card for a provider, or null when ADE has none for it. */
export function providerSignInSpec(provider: string | null | undefined): ProviderSignInSpec | null {
  return provider ? SPECS[provider] ?? null : null;
}

/**
 * Providers whose "not signed in" status is a login ADE can read on the
 * machine, so the card can show before a send. The rest (keys and
 * sub-providers) show it only after a turn fails on sign-in.
 */
export function providerSignInKnownBeforeSend(provider: string | null | undefined): boolean {
  const spec = providerSignInSpec(provider);
  return Boolean(spec && spec.kind !== "settings");
}

/** Picker families that name a provider by its maker. */
const FAMILY_PROVIDER: Record<string, string> = {
  anthropic: "claude",
  openai: "codex",
  factory: "droid",
  moonshot: "kimi",
  xai: "grok",
  "github-copilot": "copilot",
};

/**
 * The Settings page that signs a provider in, for a provider id or a picker
 * family; the providers list for one with no page of its own.
 */
export function providerSettingsEntryId(providerOrFamily: string | null | undefined): string {
  const provider = providerOrFamily ? FAMILY_PROVIDER[providerOrFamily] ?? providerOrFamily : null;
  const entryId = provider ? `agents.provider.${provider}` : null;
  return entryId && settingsEntryById(entryId) ? entryId : "agents.providers";
}

const KIMI_REGIONS: ReadonlyArray<{ id: KimiLoginRegion; label: string }> = [
  { id: "global", label: "kimi.ai" },
  { id: "mainland-cn", label: "kimi.com (China)" },
];

type Flow = {
  phase: "idle" | "starting" | "waiting" | "verifying" | "done" | "failed";
  url: string | null;
  deviceCode: string | null;
  /** The machine's sign-in waits for a code (or address) pasted from the browser. */
  awaitingCode: boolean;
  email: string | null;
  message: string | null;
};

/**
 * A sign-in that comes back to the machine's localhost finishes only in a
 * browser on that machine; from another screen Codex asks for its device code.
 */
function browserOnHost(runsHere: boolean): boolean {
  return runsHere && !isWebClientMode();
}

/** A sign-in page link the card may open: http(s) only, whatever a CLI printed. */
function signInPageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const IDLE: Flow = { phase: "idle", url: null, deviceCode: null, awaitingCode: false, email: null, message: null };

function startFailure(err: unknown, machineName: string): string {
  if (isUnsupportedAdeActionError(err)) {
    return `ADE on ${machineName} is too old to sign in from a chat. Update ADE there, or sign in from its Settings.`;
  }
  return providerActionMessage(err, "That sign-in could not start.");
}

type HostStatus = {
  loginId: string;
  state: "running" | "verifying" | "succeeded" | "failed" | "cancelled" | string;
  url: string | null;
  deviceCode?: string;
  awaitingCode: boolean;
  email?: string;
  message?: string;
  opensBrowser?: boolean;
};

/**
 * One sign-in on the chat's machine, for whichever host flow the provider
 * uses. Polls only while it runs, and stops the machine's login when the card
 * goes away mid-flow.
 */
function useProviderSignInFlow(args: {
  provider: string;
  kind: SignInKind;
  pin: OpenProjectBinding | null;
  runsHere: boolean;
  machineName: string;
  instanceId: string | null;
}) {
  const { provider, kind, pin, runsHere, machineName, instanceId } = args;
  const [flow, setFlow] = useState<Flow>(IDLE);
  /** A pasted code the machine refused; kept apart so the next poll keeps it up. */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  /** The running login on the machine, to read, answer and stop. */
  const loginRef = useRef<{ id: string; live: boolean } | null>(null);
  const openedRef = useRef<string | null>(null);
  /** An attempt started and not yet counted as ended (analytics). */
  const attemptOpenRef = useRef(false);
  const endAttempt = useCallback((outcome: "completed" | "cancelled" | "failed") => {
    if (!attemptOpenRef.current) return;
    attemptOpenRef.current = false;
    captureSignInOutcome(provider, outcome);
  }, [provider]);

  // The link opens in the browser in front of the person, once per sign-in,
  // unless the machine's own sign-in already opened it on this computer.
  const openOnce = useCallback((loginId: string, rawUrl: string | null, hostOpensIt: boolean) => {
    const url = signInPageUrl(rawUrl);
    if (!url || openedRef.current === loginId) return;
    openedRef.current = loginId;
    if (hostOpensIt && runsHere) return;
    openExternalUrl(url);
  }, [runsHere]);

  const applyHost = useCallback((seq: number, next: HostStatus, hostOpensIt: boolean) => {
    if (seq !== seqRef.current || !aliveRef.current) return;
    const live = next.state === "running" || next.state === "verifying";
    loginRef.current = { id: next.loginId, live };
    if (next.state === "running") openOnce(next.loginId, next.url, next.opensBrowser ?? hostOpensIt);
    setFlow({
      phase: next.state === "succeeded" ? "done"
        : next.state === "verifying" ? "verifying"
        : live ? "waiting"
        : "failed",
      url: signInPageUrl(next.url),
      deviceCode: next.deviceCode ?? null,
      awaitingCode: next.awaitingCode,
      email: next.email ?? null,
      message: next.state === "cancelled" ? null : next.message ?? (live ? null : "The sign-in did not finish. Try again."),
    });
  }, [openOnce]);

  const stopOnHost = useCallback(() => {
    const open = loginRef.current;
    loginRef.current = null;
    if (!open?.live) return;
    const p = pinRef.current;
    if (kind === "account") void pinnedProviderInstances(p)?.loginCancel?.({ loginId: open.id }).catch(() => undefined);
    else if (kind === "cli") void window.ade?.ai?.cliLoginCancel?.({ loginId: open.id }, p).catch(() => undefined);
    else if (kind === "antigravity") void window.ade?.ai?.antigravitySignInCancel?.({ flowId: open.id }, p).catch(() => undefined);
    else if (kind === "cursor") void window.ade?.ai?.cursorAuthCancel?.(p).catch(() => undefined);
  }, [kind]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Gone mid-flow (Not now, another chat): that attempt was cancelled.
      endAttempt("cancelled");
      stopOnHost();
    };
  }, [endAttempt, stopOnHost]);

  useEffect(() => {
    if (flow.phase === "done") endAttempt("completed");
    else if (flow.phase === "failed") endAttempt("failed");
  }, [endAttempt, flow.phase]);

  const applyAntigravity = useCallback((seq: number, next: Awaited<ReturnType<NonNullable<typeof window.ade.ai.antigravitySignInStatus>>> | null) => {
    if (!next || seq !== seqRef.current || !aliveRef.current) return;
    const live = isAntigravitySignInRunning(next);
    if (next.flowId) loginRef.current = { id: next.flowId, live };
    if (next.phase === "waiting" && next.flowId) openOnce(next.flowId, next.authorizationUrl, false);
    setFlow({
      phase: next.phase === "succeeded" ? "done"
        : next.phase === "verifying" ? "verifying"
        : live ? "waiting"
        : next.phase === "idle" ? "idle"
        : "failed",
      url: signInPageUrl(next.authorizationUrl),
      deviceCode: null,
      // A Google-account sign-in ends on Google's page that shows a code, on
      // every machine, and the code is pasted back.
      awaitingCode: next.acceptsCallbackUrl,
      email: null,
      message: next.phase === "failed" ? next.message ?? "The sign-in did not finish. Try again." : null,
    });
  }, [openOnce, runsHere]);

  const start = useCallback((options?: { kimiRegion?: KimiLoginRegion }) => {
    stopOnHost();
    const seq = ++seqRef.current;
    openedRef.current = null;
    attemptOpenRef.current = true;
    setSubmitError(null);
    setFlow({ ...IDLE, phase: "starting" });
    const p = pinRef.current;
    const fail = (err: unknown) => {
      if (seq !== seqRef.current || !aliveRef.current) return;
      loginRef.current = null;
      setFlow({ ...IDLE, phase: "failed", message: startFailure(err, machineName) });
    };
    void (async () => {
      if (kind === "account") {
        const api = pinnedProviderInstances(p);
        if (!api?.loginStart) throw new Error(`ADE on ${machineName} cannot sign in from a chat. Update ADE there.`);
        const accounts = await api.list({ provider: provider as "claude" | "codex" });
        let account = accounts.find((entry) => entry.id === instanceId) ?? accounts.find((entry) => entry.isDefault) ?? null;
        if (!account) {
          const created = await api.create({ provider: provider as "claude" | "codex" }).catch((err: unknown) => {
            if (!providerActionMessage(err, "").includes("needs a label")) throw err;
            return api.create({ provider: provider as "claude" | "codex", label: SPECS[provider]?.label ?? provider });
          });
          account = created.instance;
        }
        const next = await api.loginStart({ id: account.id, ...(browserOnHost(runsHere) ? {} : { deviceAuth: true }) });
        applyHost(seq, next, true);
        return;
      }
      if (kind === "cli") {
        const begin = window.ade?.ai?.cliLoginStart;
        if (!begin) throw new Error(`This window cannot sign in to ${SPECS[provider]?.label ?? provider}. Sign in from Settings.`);
        const next = await begin({
          provider: provider as Parameters<typeof begin>[0]["provider"],
          ...(provider === "kimi" ? { kimiRegion: options?.kimiRegion ?? "global" } : {}),
        }, p);
        applyHost(seq, next, false);
        return;
      }
      if (kind === "antigravity") {
        const begin = window.ade?.ai?.antigravitySignInStart;
        if (!begin) throw new Error(`ADE on ${machineName} cannot sign in to Antigravity yet. Update ADE there.`);
        const next = await begin({ method: "oauth-personal" }, p);
        applyAntigravity(seq, next);
        return;
      }
      if (kind === "cursor") {
        const login = window.ade?.ai?.cursorAuthLogin;
        if (!login) throw new Error("This window cannot sign in to Cursor. Sign in from Settings.");
        loginRef.current = { id: `cursor:${seq}`, live: true };
        setFlow({ ...IDLE, phase: "waiting" });
        const result = await login(p);
        if (seq !== seqRef.current || !aliveRef.current) return;
        loginRef.current = null;
        if (!result.ok) {
          setFlow({ ...IDLE, phase: "failed", message: result.error || "Cursor sign-in failed." });
          return;
        }
        setFlow((prev) => ({ ...prev, phase: "verifying" }));
        const verified = await window.ade.ai.verifyApiKey("cursor", p).catch(() => null);
        if (seq !== seqRef.current || !aliveRef.current) return;
        setFlow(verified && !verified.ok
          ? { ...IDLE, phase: "failed", message: verified.message || "Cursor did not accept that sign-in." }
          : { ...IDLE, phase: "done", email: result.email ?? null });
      }
    })().catch(fail);
  }, [applyAntigravity, applyHost, instanceId, kind, machineName, provider, runsHere, stopOnHost]);


  // Cursor reports its sign-in page through its status: show it, and open it
  // here when the chat runs on another computer (the SDK opened it there).
  const cursorWaitingForLink = kind === "cursor" && flow.phase === "waiting" && !flow.url;
  useEffect(() => {
    const read = window.ade?.ai?.cursorAuthStatus;
    if (!cursorWaitingForLink || !read) return undefined;
    const seq = seqRef.current;
    const timer = window.setInterval(() => {
      void read(pinRef.current).then((status) => {
        const url = signInPageUrl(status?.loginUrl);
        if (!url || seq !== seqRef.current || !aliveRef.current) return;
        openOnce(`cursor:${seq}`, url, true);
        setFlow((prev) => (prev.phase === "waiting" ? { ...prev, url } : prev));
      }).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [cursorWaitingForLink, openOnce]);

  // Poll the machine's sign-in while it runs.
  useEffect(() => {
    if (kind === "cursor" || (flow.phase !== "waiting" && flow.phase !== "verifying")) return undefined;
    const open = loginRef.current;
    if (!open?.live) return undefined;
    const seq = seqRef.current;
    const p = pinRef.current;
    const timer = window.setTimeout(() => {
      const read = kind === "account"
        ? pinnedProviderInstances(p)?.loginStatus?.({ loginId: open.id }).then((next) => applyHost(seq, next, true))
        : kind === "cli"
          ? window.ade?.ai?.cliLoginStatus?.({ loginId: open.id }, p).then((next) => applyHost(seq, next, false))
          : window.ade?.ai?.antigravitySignInStatus?.(p).then((next) => applyAntigravity(seq, next));
      void read?.catch((err: unknown) => {
        if (seq !== seqRef.current || !aliveRef.current) return;
        loginRef.current = null;
        setFlow({ ...IDLE, phase: "failed", message: providerActionMessage(err, "Lost track of that sign-in.") });
      });
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [applyAntigravity, applyHost, flow, kind]);

  const submitCode = useCallback(async (code: string) => {
    const open = loginRef.current;
    const trimmed = code.trim();
    if (!open?.live || !trimmed) return;
    const seq = seqRef.current;
    const p = pinRef.current;
    setSubmitError(null);
    try {
      if (kind === "account") {
        const next = await pinnedProviderInstances(p)?.loginSubmitCode?.({ loginId: open.id, code: trimmed });
        if (next) applyHost(seq, next, true);
      } else if (kind === "cli") {
        const next = await window.ade?.ai?.cliLoginSubmitCode?.({ loginId: open.id, code: trimmed }, p);
        if (next) applyHost(seq, next, false);
      } else if (kind === "antigravity") {
        applyAntigravity(seq, await window.ade?.ai?.antigravitySignInComplete?.({ flowId: open.id, callbackUrl: trimmed }, p) ?? null);
      }
    } catch (err) {
      if (seq !== seqRef.current || !aliveRef.current) return;
      setSubmitError(providerActionMessage(err, "That code was not accepted."));
    }
  }, [applyAntigravity, applyHost, kind]);

  const cancel = useCallback(() => {
    endAttempt("cancelled");
    stopOnHost();
    seqRef.current += 1;
    setSubmitError(null);
    setFlow(IDLE);
  }, [endAttempt, stopOnHost]);

  return { flow, submitError, start, submitCode, cancel };
}

/** The provider's flat mark: its brand logo where it has one, else ADE's. */
function brandMark(providerId: string, size: number) {
  const brand = providerBrand(SPECS[providerId]?.brandId ?? providerId);
  return brand.logo.kind === "solid" ? brand.logo.mark(size) : <ProviderLogo family={providerId} size={size} />;
}

export type ProviderSignInNeed = {
  provider: string;
  /** No login on the machine yet, or a turn that just failed on its sign-in. */
  reason: "no-login" | "failed-turn";
  /**
   * A failed turn on ADE Cloud waited for this computer to renew the sign-in,
   * and it did not (`system_notice.providerLogin` "owner_off").
   */
  ownerLabel?: string | null;
};

/**
 * The card in the composer's place. Enter signs in, Esc says not now.
 */
export function ProviderSignInComposer({
  need,
  pin,
  runsHere,
  machineName,
  instanceId,
  accountEmail,
  onSignedIn,
  onDismiss,
  onOpenSettings,
}: {
  need: ProviderSignInNeed;
  /** The chat's machine; null is the tab's own machine. */
  pin: OpenProjectBinding | null;
  /** The chat runs on the computer in front of the person. */
  runsHere: boolean;
  machineName: string;
  /** The Claude or Codex account the chat runs as; null is the default. */
  instanceId: string | null;
  /** The account that was signed in, when the machine still names it. */
  accountEmail: string | null;
  onSignedIn: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const spec = providerSignInSpec(need.provider) ?? { label: need.provider, via: need.provider, kind: "settings" as const };
  // The machine inside a sentence or the chip: "this computer" for the local
  // one (never its stored "This computer"), else its own name.
  const where = signInMachineWords(runsHere || machineName === THIS_MACHINE_NAME, machineName);
  const { flow, submitError, start, submitCode, cancel } = useProviderSignInFlow({
    provider: need.provider,
    kind: spec.kind,
    pin,
    runsHere,
    machineName: where,
    instanceId,
  });
  const [region, setRegion] = useState<KimiLoginRegion>("global");
  const [code, setCode] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const signingIn = flow.phase === "starting" || flow.phase === "waiting" || flow.phase === "verifying";
  // The account ADE knew before the sign-in, and the one the provider names
  // after it. Only both together can say "this is the wrong account".
  const expectedAccount = accountEmail?.trim() || null;
  const signedInAs = flow.email?.trim() || null;
  const wrongAccount = flow.phase === "done" && signInAccountMismatch(expectedAccount, signedInAs);

  // Signed in: the machine read the login back. Run the provider's own check
  // there once (it also drops the model caches), then hand the composer back
  // after a beat, unless the account is not the one the chat runs as.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  useEffect(() => {
    if (flow.phase !== "done") return;
    void checkProviderSignIn(need.provider, pinRef.current);
  }, [flow.phase, need.provider]);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  useEffect(() => {
    if (flow.phase !== "done" || wrongAccount) return undefined;
    const timer = window.setTimeout(() => onSignedInRef.current(), SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [flow.phase, wrongAccount]);

  const begin = useCallback(() => {
    if (spec.kind === "settings") {
      onOpenSettings();
      return;
    }
    setCode("");
    start(need.provider === "kimi" ? { kimiRegion: region } : undefined);
  }, [need.provider, onOpenSettings, region, spec.kind, start]);

  const submit = useCallback(() => {
    const value = code;
    void submitCode(value).then(() => setCode((current) => (current === value ? "" : current)));
  }, [code, submitCode]);

  // Enter opens the sign-in page (and copies the code) while the card waits.
  useEnterOpensSignInPage(rootRef, flow.phase === "waiting" ? flow.url : null, flow.deviceCode, openExternalUrl);

  const onKeyDown = cardEscapeHandler({ signingIn, cancelSignIn: cancel, responding: false, onDecline: onDismiss });
  const host = linkHost(flow.url);
  const heading = need.reason === "failed-turn" ? `Sign in to ${spec.label} again` : `Sign in to ${spec.label}`;
  const startLabel = spec.via ? `Continue with ${spec.via}` : `Sign in to ${spec.label}`;
  const reason = need.reason === "failed-turn"
    ? need.ownerLabel
      ? `${need.ownerLabel} didn't renew the ${spec.label} sign-in in time. Sign in on ${where}, or pick another model. Your message sends again as soon as you're back in.`
      : `${spec.label} is signed out on ${where}. Your message sends again as soon as you're back in.`
    : spec.kind === "settings"
      ? `${spec.label} has no sign-in on ${where} yet. Set it up there, then send.`
      : `${spec.label} isn't signed in on ${where} yet.`;
  const codexDeviceHint = need.provider === "codex" && !browserOnHost(runsHere) && flow.phase === "failed"
    ? " If ChatGPT refused the code, turn on device code sign-in in ChatGPT's security settings, then try again."
    : "";
  const stage: SignInStage = flow.phase === "idle"
    ? "form"
    : flow.phase === "done"
      ? wrongAccount ? "mismatch" : "done"
      : flow.phase === "starting" || (flow.phase === "waiting" && !flow.url && !flow.deviceCode && !flow.awaitingCode)
        ? "starting"
        : flow.phase;
  const failureTitle = flow.message ? "Sign-in did not complete." : "The sign-in was stopped.";
  const failureDetail = flow.message ? `${flow.message}${codexDeviceHint}` : null;
  const report = useMemo(() => (flow.phase === "failed" && flow.message
    ? formatSignInFailureReport({
        provider: need.provider,
        providerLabel: spec.label,
        place: runsHere ? "this computer" : "another computer",
        stage: flow.url ? "after the sign-in page opened" : "before the sign-in page opened",
        title: failureTitle,
        detail: failureDetail,
        output: null,
        secrets: [flow.deviceCode, flow.url],
      })
    : null), [failureDetail, failureTitle, flow.deviceCode, flow.message, flow.phase, flow.url, need.provider, runsHere, spec.label]);
  // The sheet's words for the same box.
  const pageName = spec.kind === "antigravity" ? "Google" : host ?? "The sign-in page";
  const pasteLabel = spec.kind === "antigravity" ? "Paste the code Google shows" : "Paste the code from the sign-in page";
  const codeHint = flow.deviceCode
    ? `On ${host ?? "the sign-in page"}, check that it shows this code, then approve.`
    : flow.awaitingCode
      ? `${pageName} shows a code once you approve. Paste it below.`
      : `${host ?? "The sign-in page"} opens in your browser. Approve there.`;

  return (
    <ProviderCardFrame
      rootRef={rootRef}
      brandId={spec.brandId ?? need.provider}
      heading={heading}
      turn={stage === "done"}
      testId="provider-sign-in-composer"
      provider={need.provider}
      signInCard
      onKeyDown={onKeyDown}
      tools={(
        <>
          <span className="ade-icc-chip" title={`This chat runs on ${where}`}>on {where}</span>
          {accountEmail ? <span className="ade-icc-chip" title="The account this chat runs as">{accountEmail}</span> : null}
          <CardBannerButtons
            onOpenSettings={onOpenSettings}
            onDecline={onDismiss}
            signingIn={signingIn}
            cancelSignIn={cancel}
            testIdPrefix="provider-sign-in"
          />
        </>
      )}
    >
      <div className="ade-sis" data-compact="true" data-card="true">
        {stage === "form" || stage === "failed" ? <p className="ade-icc-reason">{reason}</p> : null}
        {spec.kind !== "settings" && (stage === "form" || signingIn) ? (
          <SignInAccountNote providerLabel={spec.label} expectedAccount={expectedAccount} />
        ) : null}

        {signingIn || stage === "done" ? (
          <SignInSteps stage={stage}>
            <SignInCodePanel
              url={flow.url}
              deviceCode={flow.deviceCode}
              open={openExternalUrl}
              hint={codeHint}
              focusOpen={!flow.awaitingCode}
              codeTestId="provider-sign-in-device-code"
            />
            {flow.awaitingCode ? (
              <SignInPasteBox
                label={pasteLabel}
                placeholder={spec.kind === "antigravity" ? "http://127.0.0.1:…/?state=…&code=…" : "Paste the code here"}
                value={code}
                onChange={setCode}
                onSubmit={submit}
                submitLabel={spec.kind === "antigravity" ? "Continue" : "Submit"}
                autoFocus
                testId="provider-sign-in-code"
                submitTestId="provider-sign-in-submit-code"
              />
            ) : null}
          </SignInSteps>
        ) : null}

        {stage === "done" ? <SignInSuccess account={signedInAs} providerLabel={spec.label} /> : null}
        {stage === "mismatch" && expectedAccount && signedInAs ? (
          <SignInMismatch
            expected={expectedAccount}
            actual={signedInAs}
            onKeep={() => onSignedInRef.current()}
            onTryAgain={begin}
          />
        ) : null}
        {stage === "failed" ? (
          <SignInFailure title={failureTitle} detail={failureDetail} report={report} tone={flow.message ? "crit" : "neutral"} />
        ) : null}

        {stage === "form" || stage === "failed" ? (
          <div className="ade-sis-start-row">
              {need.provider === "kimi" ? (
                <span className="ade-icc-tabs" role="tablist" aria-label="Kimi account region">
                  {KIMI_REGIONS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={entry.id === region}
                      className="ade-icc-tab"
                      onClick={() => setRegion(entry.id)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </span>
              ) : null}
              <button
                type="button"
                className="ade-icc-primary ade-icc-primary-brand"
                autoFocus
                data-testid="provider-sign-in-start"
                onClick={begin}
              >
                <span className="ade-icc-primary-mark" aria-hidden>{brandMark(need.provider, 14)}</span>
                {spec.kind === "settings"
                  ? `Set up ${spec.label} on ${where}`
                  : stage === "failed" ? "Try again" : startLabel}
              </button>
          </div>
        ) : signingIn ? (
          // The sheet's footer: what ADE waits for on the left, Cancel on the right.
          <div className="ade-sis-status-row">
              <span className="ade-sis-footer-status" role="status">
                <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" />
                {stage === "starting"
                  ? "Starting the sign-in…"
                  : stage === "verifying"
                    ? "Checking the sign-in…"
                    : host ? `Waiting for ${host}…` : "Waiting for the browser…"}
              </span>
              <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={cancel}>Cancel</button>
          </div>
        ) : null}
      </div>
      {submitError && signingIn ? <CardError id="provider-sign-in-error" message={submitError} /> : null}
    </ProviderCardFrame>
  );
}

/**
 * The transcript's line for a turn that stopped on a signed-out provider. The
 * card itself sits in the composer; this records what happened, and turns to
 * "signed in again" once a later turn in the chat works.
 */
export function ProviderSignInReceipt({
  provider,
  displayName,
  machineName,
  sessionId,
  details,
}: {
  provider: string;
  displayName: string;
  machineName: string;
  sessionId: string | null;
  /** The provider's own words, folded away. */
  details?: ReactNode;
}) {
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (!sessionId) return undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      if (detail?.sessionId === sessionId) setRecovered(true);
    };
    window.addEventListener(CHAT_AUTH_RECOVERED_EVENT, handler);
    return () => window.removeEventListener(CHAT_AUTH_RECOVERED_EVENT, handler);
  }, [sessionId]);
  const brand = providerBrand(SPECS[provider]?.brandId ?? provider);
  const where = signInMachineWords(machineName === THIS_MACHINE_NAME, machineName);
  const logo = (
    <span className="ade-icc-receipt-logo" style={brand.banner} data-light={brand.lightBanner ? "true" : undefined} aria-hidden>
      <span style={{ color: brand.logo.kind === "solid" ? brand.logo.face : brand.logo.color }}>{brandMark(provider, 11)}</span>
    </span>
  );
  return (
    <CardReceipt
      testId="provider-sign-in-receipt"
      logo={logo}
      state={recovered ? "done" : "not-done"}
      name={SPECS[provider]?.label ?? displayName}
      after={recovered ? `signed in again on ${where}` : `was signed out on ${where}`}
      sub={details}
    />
  );
}
