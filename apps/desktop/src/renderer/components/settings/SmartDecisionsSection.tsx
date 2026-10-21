import { useEffect, useState } from "react";
import type { AiChatConfig } from "../../../shared/types";
import type { OpenCodeProviderAuthMethod } from "../../../shared/types/config";
import type { JevAvailabilityReason, JevDayTally } from "../../../shared/types/jev";
import { openCodeProviderDisplayName } from "../../../shared/opencodeProviders";
import { showToast } from "../app/toast/toastStore";
import { OAuthConnectModal } from "./OAuthConnectModal";
import { ModernRow, ModernRows, ModernSection, SettingsSegmented, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { useChatConfigToggle } from "./useChatConfigToggle";

type HintMode = NonNullable<AiChatConfig["modelHintMode"]>;

const HINT_OPTIONS: ReadonlyArray<{ value: HintMode; label: string }> = [
  { value: "model_and_effort", label: "Model and effort" },
  { value: "effort_only", label: "Effort only" },
  { value: "off", label: "Off" },
];

/** Jev's sign-in is OpenCode Zen's: the `opencode` provider in OpenCode. */
const ZEN_PROVIDER_ID = "opencode";
/**
 * The brain reads the sign-in store at most once a minute, so a sign-in just
 * made shows in its status only after this.
 */
const STATUS_SETTLE_MS = 61_000;
/** Jev 1.13's paid price per input token (OpenCode Zen: $0.042 per 1M input; output is free). */
const PAID_JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** "42 asked · 40 answered · 2 fell back · 14k tokens · about $0.0006 if paid". */
function todayUsageText(today: JevDayTally): string {
  const answered = (today.outcomes.ok ?? 0) + (today.outcomes.cached ?? 0);
  const parts = [
    `${today.wanted} asked`,
    `${answered} answered`,
    `${Math.max(0, today.wanted - answered)} fell back to ADE's rules`,
  ];
  if (today.inputTokens + today.outputTokens > 0) {
    parts.push(`${compactCount(today.inputTokens + today.outputTokens)} tokens`);
    const usd = today.inputTokens * PAID_JEV_USD_PER_INPUT_TOKEN;
    parts.push(`about $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} at Jev's paid price`);
  }
  return `Today in this project: ${parts.join(" · ")}.`;
}

/**
 * "Smart decisions (OpenCode Jev)" and the composer's model hint, which asks
 * the same Jev. On the Chat page because both act on chats and the composer.
 * Saved to this project's `.ade/local.yaml` on the machine this settings page
 * is scoped to, and read from that machine's Jev.
 *
 * With no OpenCode Zen sign-in on that machine the switch would do nothing, so
 * the row offers the sign-in instead, through the same dialog Providers uses.
 */
export function SmartDecisionsSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const { onWeb, status, saving, enabled, save } = useChatConfigToggle("smartDecisionsEnabled", { defaultOn: true });
  // Null until read, and on a machine whose ADE has no Jev.
  const [reason, setReason] = useState<JevAvailabilityReason | null>(null);
  const [today, setToday] = useState<JevDayTally | null>(null);
  const [statusRead, setStatusRead] = useState(0);
  const [signIn, setSignIn] = useState<{ methods: OpenCodeProviderAuthMethod[] } | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (onWeb) return;
    let cancelled = false;
    void window.ade.ai.jevStatus(pin).then((jev) => {
      if (cancelled) return;
      setReason(jev?.reason ?? null);
      setToday(jev?.today ?? null);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWeb, pinKey, statusRead]);

  // After a sign-in the row already shows as signed in; this read, once the
  // brain's store cache has expired, confirms it (or puts the sign-in back).
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => {
      setSettling(false);
      setStatusRead((count) => count + 1);
    }, STATUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  if (onWeb || reason == null) return null;
  const signedOut = reason === "not_signed_in" || reason === "token_expired";

  const openSignIn = async () => {
    setOpening(true);
    try {
      const result = await window.ade.ai.opencodeAuthMethods(pin);
      const methods = result.methods?.[ZEN_PROVIDER_ID] ?? [];
      if (!methods.some((method) => method.type === "oauth")) {
        throw new Error("OpenCode did not offer a Zen sign-in. Try it from Providers, under OpenCode.");
      }
      setSignIn({ methods });
    } catch (error) {
      showToast({
        title: "Couldn't start the OpenCode sign-in",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setOpening(false);
    }
  };

  const signInButton = (
    <button type="button" className="ade-modern-btn" disabled={opening} onClick={() => void openSignIn()}>
      {opening ? "Opening…" : "Sign in to OpenCode"}
    </button>
  );

  return (
    <ModernSection group="Smart decisions" title="Smart decisions" hint="Quick calls ADE makes about your chats and prompts.">
      <ModernRows>
        <ModernRow
          anchor="smart-decisions"
          title="Smart decisions (OpenCode Jev)"
          hint={signedOut
            ? reason === "token_expired"
              ? "Your OpenCode Zen sign-in expired. Sign in again to use the free Jev model; until then ADE's built-in rules decide."
              : "Free with an OpenCode Zen sign-in: ADE asks the free Jev model, for example whether a finished turn asked you something."
            : status === "loading"
              ? "Loading…"
              : status === "failed"
                ? "Couldn't load the configuration."
                : (
                  <>
                    Uses your OpenCode Zen sign-in to ask the free Jev model, for example whether a finished turn asked you something. When Jev is slow or unavailable, ADE's built-in rules decide.
                    {today && today.wanted > 0 ? <><br />{todayUsageText(today)}</> : null}
                  </>
                )}
          control={signedOut ? signInButton : (
            <SettingsToggle
              label="Smart decisions (OpenCode Jev)"
              checked={enabled}
              disabled={status !== "loaded" || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
        {signedOut ? null : <ModelHintRow />}
      </ModernRows>
      {signIn ? (
        <OAuthConnectModal
          providerId={ZEN_PROVIDER_ID}
          providerName={openCodeProviderDisplayName(ZEN_PROVIDER_ID, "OpenCode Zen")}
          methods={signIn.methods}
          onClose={() => setSignIn(null)}
          onConnected={() => {
            setSignIn(null);
            setReason("ok");
            setSettling(true);
          }}
        />
      ) : null}
    </ModernSection>
  );
}

/** Jev's model and effort hint in the composer. Needs Smart decisions on. */
function ModelHintRow() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const [mode, setMode] = useState<HintMode | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMode(null);
    void window.ade.projectConfig.get(pin).catch(() => null).then((config) => {
      if (!cancelled) setMode(config ? config.effective.ai?.chat?.modelHintMode ?? "model_and_effort" : null);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey]);

  const save = async (next: HintMode) => {
    const previous = mode;
    setSaving(true);
    setMode(next);
    try {
      await window.ade.ai.updateConfig({ chat: { modelHintMode: next } }, pin);
    } catch (error) {
      setMode(previous);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernRow
      anchor="model-hint"
      title="Suggest a model and effort while typing"
      hint={mode == null
        ? "Loading…"
        : "Jev reads the prompt, and ADE suggests the cheapest model and effort that do it well, beside the model picker. A model you pick in the composer, or a chat that has already run, keeps its model: then only its effort is suggested. Needs Smart decisions on."}
      control={(
        <SettingsSegmented
          ariaLabel="Suggest a model and effort while typing"
          value={mode ?? "model_and_effort"}
          options={HINT_OPTIONS}
          disabled={mode == null || saving}
          onChange={(next) => void save(next)}
        />
      )}
    />
  );
}
