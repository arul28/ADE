import { useEffect, useState, type ElementType, type ReactNode } from "react";
import { CheckCircle, Command, Gauge, HandWaving, Smiley, Wallet } from "@phosphor-icons/react";
import type { AiChatConfig } from "../../../shared/types";
import { JEV_GROUP_CONFIG_KEY } from "../../../shared/jevSettings";
import type { OpenCodeProviderAuthMethod } from "../../../shared/types/config";
import type { JevStatus } from "../../../shared/types/jev";
import { openCodeProviderDisplayName } from "../../../shared/opencodeProviders";
import { showToast } from "../app/toast/toastStore";
import { OAuthConnectModal } from "./OAuthConnectModal";
import { ModernRow, ModernRows, ModernSection, SettingsSegmented, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { useChatConfigToggle } from "./useChatConfigToggle";

type HintMode = NonNullable<AiChatConfig["modelHintMode"]>;

const HINT_OPTIONS: ReadonlyArray<{ value: Exclude<HintMode, "off">; label: string }> = [
  { value: "model_and_effort", label: "Model and effort" },
  { value: "effort_only", label: "Effort only" },
];

/** Jev's sign-in is OpenCode Zen's: the `opencode` provider in OpenCode. */
const ZEN_PROVIDER_ID = "opencode";
/**
 * The brain reads the sign-in store at most once a minute, so a sign-in just
 * made shows in its status only after this.
 */
const STATUS_SETTLE_MS = 61_000;

/**
 * "Smart decisions (OpenCode Jev)": one master switch, then, while it is on,
 * one switch per group of things Jev decides (`shared/jevSettings.ts`), each
 * with its own options under it. On the Chat page because they act on chats
 * and the composer. Saved to this project's `.ade/local.yaml` on the machine
 * this settings page is scoped to, and read from that machine's Jev.
 *
 * Jev needs no sign-in: OpenCode's free allowance answers first and the ADE
 * bonus after it. An OpenCode Zen sign-in only adds the optional step between
 * them, the user's own Zen balance, offered through the same dialog Providers
 * uses.
 */
export function SmartDecisionsSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const { onWeb, status, saving, enabled, save } = useChatConfigToggle("smartDecisionsEnabled", { defaultOn: true });
  // Null until read, and on a machine whose ADE has no Jev.
  const [zen, setZen] = useState<JevStatus["zen"] | null>(null);
  const [statusRead, setStatusRead] = useState(0);
  const [signIn, setSignIn] = useState<{ methods: OpenCodeProviderAuthMethod[] } | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (onWeb) return;
    let cancelled = false;
    void window.ade.ai.jevStatus(pin).then((jev) => {
      if (!cancelled) setZen(jev?.zen ?? null);
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

  if (onWeb || zen == null) return null;

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
          title="Smart decisions (Jev)"
          hint={status === "loading"
            ? "Loading…"
            : status === "failed"
              ? "Couldn't load the configuration."
              : "ADE asks the small Jev model quick questions, for example whether a finished turn asked you something. It's free through OpenCode, with no sign-in; when that day's free allowance is out, ADE's bonus answers for signed-in ADE accounts. When Jev is slow or unavailable, ADE's built-in rules decide."}
          control={(
            <SettingsToggle
              label="Smart decisions (Jev)"
              checked={enabled}
              disabled={status !== "loaded" || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
      </ModernRows>
      {!enabled || status !== "loaded" ? null : (
        <div style={{ marginTop: 10 }}>
          <ModernRows>
            <GroupRow
              anchor="smart-chat-status"
              configKey={JEV_GROUP_CONFIG_KEY.chatStatus}
              icon={HandWaving}
              title="Waiting on you"
              hint="Whether a chat's last reply asked you something or is waiting on its own background work, whether a terminal CLI is waiting for your input, and whether a status line still matches the final reply."
            />
            <GroupRow
              anchor="smart-settle-nudge"
              configKey={JEV_GROUP_CONFIG_KEY.settleNudge}
              icon={CheckCircle}
              title="Settle finished chats"
              hint="Suggests settling a chat that has sat idle for 3 hours when its last turn reads as done."
            />
            <ModelHintRow />
            <GroupRow
              anchor="smart-palette"
              configKey={JEV_GROUP_CONFIG_KEY.palette}
              icon={Command}
              title="⌘K suggestions"
              hint="Puts the command that fits what you type at the top of ⌘K, under Suggested."
            />
            <GroupRow
              anchor="smart-lane-emoji"
              configKey={JEV_GROUP_CONFIG_KEY.laneEmoji}
              icon={Smiley}
              title="Lane emoji"
              hint="Picks an emoji for a new lane from its name."
            />
          </ModernRows>
          <div style={{ marginTop: 10 }}>
            <ModernRows>
              {zen === "signed_in" ? (
                <GroupRow
                  anchor="jev-zen-credit"
                  configKey="jevZenCreditEnabled"
                  defaultOn={false}
                  icon={Wallet}
                  title="Use my OpenCode Zen credit"
                  hint="Once the free allowance is out, spend your own OpenCode Zen balance on Jev before ADE's bonus. Jev costs about $0.04 per million input tokens: well under a cent a day."
                />
              ) : (
                <ModernRow
                  anchor="jev-zen-credit"
                  title={<GroupTitle icon={Wallet}>Use my OpenCode Zen credit</GroupTitle>}
                  hint={zen === "token_expired"
                    ? "Your OpenCode Zen sign-in expired. Sign in again to spend your own Zen balance on Jev once the free allowance is out. Optional: the ADE bonus covers it otherwise."
                    : "Optional: sign in to OpenCode Zen to spend your own balance on Jev once the free allowance is out, before ADE's bonus."}
                  control={signInButton}
                />
              )}
            </ModernRows>
          </div>
        </div>
      )}
      {signIn ? (
        <OAuthConnectModal
          providerId={ZEN_PROVIDER_ID}
          providerName={openCodeProviderDisplayName(ZEN_PROVIDER_ID, "OpenCode Zen")}
          methods={signIn.methods}
          onClose={() => setSignIn(null)}
          onConnected={() => {
            setSignIn(null);
            setZen("signed_in");
            setSettling(true);
          }}
        />
      ) : null}
    </ModernSection>
  );
}

function GroupTitle({ icon: Icon, children }: { icon: ElementType; children: ReactNode }) {
  return (
    <span className="ade-smart-group-title">
      <span className="ade-smart-group-icon" aria-hidden>
        <Icon size={15} weight="duotone" />
      </span>
      {children}
    </span>
  );
}

/** One switch under Smart decisions: a group of Jev decisions (off, its features use ADE's built-in rules), or the Zen credit opt-in. */
function GroupRow({ anchor, configKey, defaultOn = true, icon, title, hint }: {
  anchor: string;
  configKey: (typeof JEV_GROUP_CONFIG_KEY)[keyof typeof JEV_GROUP_CONFIG_KEY] | "jevZenCreditEnabled";
  defaultOn?: boolean;
  icon: ElementType;
  title: string;
  hint: string;
}) {
  const { status, saving, enabled, save } = useChatConfigToggle(configKey, { defaultOn });
  return (
    <ModernRow
      anchor={anchor}
      title={<GroupTitle icon={icon}>{title}</GroupTitle>}
      hint={status === "failed" ? "Couldn't load the configuration." : hint}
      control={(
        <SettingsToggle label={title} checked={enabled} disabled={status !== "loaded" || saving} onChange={(value) => void save(value)} />
      )}
    />
  );
}

/** Jev's model and effort hint in the composer: its switch is `modelHintMode` off, its option what it may suggest. */
function ModelHintRow() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const [mode, setMode] = useState<HintMode | null>(null);
  const [saving, setSaving] = useState(false);
  // What switching it back on restores.
  const [lastOn, setLastOn] = useState<Exclude<HintMode, "off">>("model_and_effort");

  useEffect(() => {
    let cancelled = false;
    setMode(null);
    void window.ade.projectConfig.get(pin).catch(() => null).then((config) => {
      if (cancelled) return;
      const next = config ? config.effective.ai?.chat?.modelHintMode ?? "model_and_effort" : null;
      setMode(next);
      if (next && next !== "off") setLastOn(next);
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
    if (next !== "off") setLastOn(next);
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

  const on = mode != null && mode !== "off";
  return (
    <ModernRow
      anchor="model-hint"
      title={<GroupTitle icon={Gauge}>Model and effort hint</GroupTitle>}
      hint={mode == null
        ? "Loading…"
        : "Suggests a model and effort beside the composer's pickers for a new chat, from how you picked for your last few similar ones. Sends the prompt and the first line of those chats. It never moves a model you picked to a weaker one."}
      control={(
        <SettingsToggle
          label="Model and effort hint"
          checked={on}
          disabled={mode == null || saving}
          onChange={(value) => void save(value ? lastOn : "off")}
        />
      )}
    >
      {on ? (
        <div className="ade-smart-group-options">
          <span className="ade-ap-rowhint">Suggest</span>
          <SettingsSegmented
            ariaLabel="What the hint may suggest"
            value={mode === "effort_only" ? "effort_only" : "model_and_effort"}
            options={HINT_OPTIONS}
            disabled={saving}
            onChange={(next) => void save(next)}
          />
        </div>
      ) : null}
    </ModernRow>
  );
}
