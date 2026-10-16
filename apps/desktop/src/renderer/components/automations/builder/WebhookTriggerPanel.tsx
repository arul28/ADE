import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowsClockwise,
  Bell,
  Bug,
  CheckCircle,
  Copy,
  CreditCard,
  Eye,
  EyeSlash,
  Funnel,
  GithubLogo,
  Globe,
  Key,
  Lightning,
  PaperPlaneTilt,
  Plus,
  Robot,
  ShieldCheck,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";
import type {
  AutomationTrigger,
  AutomationWebhookDeliverySummary,
  AutomationWebhookEndpoint,
  AutomationWebhookFilter,
  AutomationWebhookFilterOp,
  AutomationWebhookPreset,
  AutomationWebhookTestResult,
  AutomationWebhookTriggerConfig,
  OpenProjectBinding,
} from "../../../../shared/types";
import {
  WEBHOOK_PRESETS,
  describeWebhookFilter,
  listWebhookLeafPaths,
  webhookPresetDef,
} from "../../../../shared/automationWebhooks";
import { generateProjectSecretValue } from "../../../../shared/projectSecretRequest";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { SettingsToggle } from "../../settings/settingsSectionUi";
import { LinearMark } from "../../lanes/linearBrand";
import { inputCls, labelCls, selectCls } from "../designTokens";
import { choiceCls, eyebrowCls, panelCls, tagCls, toneTextCls } from "../webhookSurface";
import { WebhookDeliveries } from "./WebhookDeliveries";

const EXPLAINER_DISMISSED_KEY = "ade.automations.webhookExplainer.dismissed";

const PRESET_ICONS: Record<AutomationWebhookPreset, ReactNode> = {
  github: <GithubLogo size={15} weight="fill" />,
  stripe: <CreditCard size={15} weight="fill" />,
  linear: <LinearMark size={14} />,
  sentry: <Bug size={15} weight="fill" />,
  generic: <Globe size={15} weight="regular" />,
};

const FILTER_OP_LABELS: Record<AutomationWebhookFilterOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  exists: "is present",
  matches: "matches regex",
};

function webhooksApi() {
  return window.ade?.automations?.webhooks ?? null;
}

async function copyText(text: string, what: string) {
  if (await copyTextToClipboard(text)) {
    showToast({ tone: "success", title: `${what} copied` });
  } else {
    showToast({ tone: "error", title: `Couldn't copy the ${what.toLowerCase()}` });
  }
}

/** A numbered row: the panel reads top to bottom like a short setup guide. */
function StepRow({
  n,
  title,
  hint,
  done,
  children,
}: {
  n: number;
  title: string;
  hint?: ReactNode;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
            done ? "text-[var(--color-success)]" : "bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)] text-muted-fg",
          )}
        >
          {done ? <CheckCircle size={14} weight="fill" /> : n}
        </span>
        <span className="mt-1 w-px flex-1 bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]" />
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="text-[12.5px] font-medium text-fg">{title}</div>
        {hint ? <div className="mt-0.5 text-[11.5px] leading-[1.45] text-muted-fg">{hint}</div> : null}
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

/** The doorbell picture: who rings, what answers, what happens. */
function HowItWorks({ presetLabel, onDismiss }: { presetLabel: string; onDismiss: () => void }) {
  const tiles: Array<{ icon: ReactNode; title: string; text: string }> = [
    { icon: <Lightning size={14} />, title: `${presetLabel} rings`, text: "Something happens there, so it sends a request." },
    { icon: <Bell size={14} />, title: "Your URL answers", text: "A private address only this automation owns." },
    { icon: <Robot size={14} />, title: "ADE runs the agent", text: "After checking it's real and worth running." },
  ];
  return (
    <div className={cn(panelCls, "relative p-3.5")}>
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-2 top-2 rounded p-1 text-muted-fg hover:bg-[color-mix(in_srgb,var(--color-fg)_5.5%,transparent)] hover:text-fg"
        aria-label="Hide explanation"
        title="Hide explanation"
      >
        <X size={11} />
      </button>
      <div className={eyebrowCls}>How a webhook works</div>
      <p className="mt-1.5 max-w-xl text-[12px] leading-[1.5] text-fg/85">
        A webhook is a doorbell. You give a service a URL, and it rings that URL whenever something happens. ADE answers
        the door and starts your agent. Nothing to poll, nothing to keep open.
      </p>
      <div className="mt-3 flex items-stretch gap-1.5">
        {tiles.map((tile, index) => (
          <div key={tile.title} className="flex min-w-0 flex-1 items-stretch gap-1.5">
            <div className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--color-fg)_7%,transparent)] px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg">
                <span className="text-muted-fg">{tile.icon}</span>
                {tile.title}
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-muted-fg">{tile.text}</div>
            </div>
            {index < tiles.length - 1 ? (
              <span className="flex items-center text-muted-fg/50">
                <ArrowRight size={12} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function RouteBadge({ endpoint }: { endpoint: AutomationWebhookEndpoint }) {
  if (endpoint.route === "relay") return <span className={tagCls("ok")}>PUBLIC · ADE RELAY</span>;
  if (endpoint.route === "gateway") return <span className={tagCls("ok")}>PUBLIC · YOUR ADDRESS</span>;
  return <span className={tagCls("warn")}>THIS COMPUTER ONLY</span>;
}

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: AutomationWebhookFilter;
  onChange: (next: AutomationWebhookFilter) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
      <input
        className={cn(inputCls, "font-mono")}
        value={filter.path}
        placeholder="body.action"
        spellCheck={false}
        onChange={(event) => onChange({ ...filter, path: event.target.value })}
        aria-label="Field"
      />
      <select
        className={cn(selectCls, "w-[124px]")}
        value={filter.op}
        onChange={(event) => onChange({ ...filter, op: event.target.value as AutomationWebhookFilterOp })}
        aria-label="Comparison"
      >
        {(Object.keys(FILTER_OP_LABELS) as AutomationWebhookFilterOp[]).map((op) => (
          <option key={op} value={op}>
            {FILTER_OP_LABELS[op]}
          </option>
        ))}
      </select>
      <input
        className={cn(inputCls, "font-mono", filter.op === "exists" && "opacity-40")}
        value={filter.value ?? ""}
        placeholder={filter.op === "exists" ? "—" : "opened"}
        disabled={filter.op === "exists"}
        spellCheck={false}
        onChange={(event) => onChange({ ...filter, value: event.target.value })}
        aria-label="Value"
      />
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-1.5 text-muted-fg/60 hover:bg-[color-mix(in_srgb,var(--color-fg)_5.5%,transparent)] hover:text-[var(--color-error)]"
        aria-label="Remove condition"
        title="Remove condition"
      >
        <Trash size={12} />
      </button>
    </div>
  );
}

export function WebhookTriggerPanel({
  trigger,
  onChange,
  runtimePin = null,
  agentPrompt = null,
  onUsePrompt,
}: {
  trigger: AutomationTrigger;
  onChange: (next: AutomationTrigger) => void;
  runtimePin?: OpenProjectBinding | null;
  /** The first agent step's prompt, so the panel knows whether to offer the preset's. */
  agentPrompt?: string | null;
  onUsePrompt?: (prompt: string) => void;
}) {
  const api = webhooksApi();
  const config = trigger.webhook ?? null;
  const hookId = config?.hookId ?? null;
  const preset = webhookPresetDef(config?.preset ?? "generic");
  const [endpoint, setEndpoint] = useState<AutomationWebhookEndpoint | null>(null);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deliveries, setDeliveries] = useState<AutomationWebhookDeliverySummary[]>([]);
  const [latestBody, setLatestBody] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AutomationWebhookTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [secretNames, setSecretNames] = useState<Set<string> | null>(null);
  const [secretDraft, setSecretDraft] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [savingSecret, setSavingSecret] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [explainerHidden, setExplainerHidden] = useState(() => {
    try {
      return window.localStorage.getItem(EXPLAINER_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [replacingSecret, setReplacingSecret] = useState(false);
  const creatingRef = useRef(false);
  const latestTriggerRef = useRef(trigger);
  latestTriggerRef.current = trigger;
  const latestOnChangeRef = useRef(onChange);
  latestOnChangeRef.current = onChange;

  const patchConfig = useCallback(
    (patch: Partial<AutomationWebhookTriggerConfig>) => {
      if (!config) return;
      onChange({ ...trigger, webhook: { ...config, ...patch } });
    },
    [config, onChange, trigger],
  );

  // A new webhook trigger gets its URL right away: the URL is the whole point.
  useEffect(() => {
    if (hookId || !api || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    void api
      .createEndpoint({ label: null }, runtimePin)
      .then((created) => {
        setEndpoint(created);
        // Read the trigger as it is now: the user may have picked a service
        // while the URL was being made.
        const latest = latestTriggerRef.current;
        latestOnChangeRef.current({ ...latest, webhook: { preset: "generic", ...(latest.webhook ?? {}), hookId: created.hookId } });
      })
      .catch((error: unknown) => setEndpointError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookId, api]);

  const refreshEndpoint = useCallback(async () => {
    if (!hookId || !api) return;
    try {
      setEndpoint(await api.getEndpoint({ hookId }, runtimePin));
      setEndpointError(null);
    } catch (error) {
      setEndpointError(error instanceof Error ? error.message : String(error));
    }
  }, [api, hookId, runtimePin]);

  const refreshDeliveries = useCallback(async () => {
    if (!hookId || !api) return;
    try {
      const list = await api.listDeliveries({ hookId, limit: 20 }, runtimePin);
      setDeliveries(list);
      // Field picker reads a delivery that passed its checks: a forged or
      // malformed request must not decide which fields the user sees.
      const newest = list.find((entry) => entry.outcome === "ran" || entry.outcome === "filtered" || entry.outcome === "duplicate" || entry.outcome === "no_rule");
      if (newest) {
        const detail = await api.getDelivery({ id: newest.id }, runtimePin);
        if (detail?.body) {
          try {
            setLatestBody(JSON.parse(detail.body));
          } catch {
            setLatestBody(null);
          }
        }
      }
    } catch {
      // The log is a convenience; the trigger still works without it.
    }
  }, [api, hookId, runtimePin]);

  useEffect(() => {
    void refreshEndpoint();
    void refreshDeliveries();
  }, [refreshEndpoint, refreshDeliveries]);

  useEffect(() => {
    if (!hookId) return;
    const unsubscribe = window.ade?.automations?.onEvent?.((event) => {
      if (event.type === "webhook-deliveries-updated" && event.hookId === hookId) {
        void refreshDeliveries();
        void refreshEndpoint();
      }
    });
    return () => unsubscribe?.();
  }, [hookId, refreshDeliveries, refreshEndpoint]);

  const refreshSecrets = useCallback(async () => {
    try {
      const result = await window.ade?.projectSecrets?.list?.();
      setSecretNames(new Set((result?.secrets ?? []).map((entry) => entry.name)));
    } catch {
      setSecretNames(new Set());
    }
  }, []);
  useEffect(() => {
    void refreshSecrets();
  }, [refreshSecrets]);

  const signature = config?.signature ?? null;
  const secretSaved = Boolean(signature && secretNames?.has(signature.secretName)) && !replacingSecret;

  const choosePreset = (value: AutomationWebhookPreset) => {
    if (!config) return;
    const next = webhookPresetDef(value);
    setGeneratedSecret(null);
    setSecretDraft("");
    // Switching service resets the signature to that service's format, so the
    // check matches what it actually sends. Generic starts unsigned.
    patchConfig({
      preset: value,
      signature: value === "generic" ? null : { ...next.signature, secretName: next.secretName },
    });
  };

  const setSignatureEnabled = (enabled: boolean) => {
    if (!config) return;
    patchConfig({ signature: enabled ? { ...preset.signature, secretName: preset.secretName } : null });
  };

  const saveSecret = async (value: string): Promise<boolean> => {
    if (!signature || !value.trim()) return false;
    setSavingSecret(true);
    try {
      await window.ade.projectSecrets.set({ name: signature.secretName, value: value.trim() });
      await refreshSecrets();
      setReplacingSecret(false);
      setSecretDraft("");
      showToast({ tone: "success", title: `Saved ${signature.secretName}`, message: "Encrypted in this project's secrets." });
      return true;
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't save the secret", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSavingSecret(false);
    }
  };

  const generateSecret = async () => {
    const value = generateProjectSecretValue();
    // Only show the value once it is actually stored; a failed save would
    // otherwise hand the person a secret ADE never kept.
    if (await saveSecret(value)) setGeneratedSecret(value);
  };

  const rotate = async () => {
    if (!hookId || !api) return;
    const ok = await confirmDialog({
      title: "Make a new URL?",
      message: "The current URL stops working right away. Anything still using it will get “not found” until you paste the new one in.",
      confirmLabel: "Make new URL",
      destructive: true,
    });
    if (!ok) return;
    setRotating(true);
    try {
      setEndpoint(await api.rotateEndpoint({ hookId }, runtimePin));
      showToast({ tone: "success", title: "New URL ready", message: "Paste it into the service to replace the old one." });
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't make a new URL", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRotating(false);
    }
  };

  const recreateHere = async () => {
    if (!api) return;
    setCreating(true);
    try {
      const created = await api.createEndpoint({ label: null }, runtimePin);
      setEndpoint(created);
      patchConfig({ hookId: created.hookId });
    } catch (error) {
      setEndpointError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const sendTest = async () => {
    if (!hookId || !api) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await api.sendTest({ hookId, config }, runtimePin));
      void refreshDeliveries();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const filters = config?.filters ?? [];
  const setFilters = (next: AutomationWebhookFilter[]) => patchConfig({ filters: next });

  const fieldSource = latestBody ?? preset.sampleBody;
  const fields = useMemo(() => listWebhookLeafPaths(fieldSource).slice(0, 14), [fieldSource]);
  const promptIsEmpty = !agentPrompt?.trim();

  if (!api) {
    return <p className="text-[11px] text-muted-fg/70">Webhooks need a newer ADE runtime on this machine.</p>;
  }

  return (
    <div className="space-y-3">
      {explainerHidden ? null : (
        <HowItWorks
          presetLabel={config?.preset && config.preset !== "generic" ? preset.label : "A service"}
          onDismiss={() => {
            setExplainerHidden(true);
            try {
              window.localStorage.setItem(EXPLAINER_DISMISSED_KEY, "1");
            } catch {
              // Private mode; it just shows again next time.
            }
          }}
        />
      )}

      <div>
        <StepRow n={1} title="Which service will call it?" done={Boolean(config?.preset)}>
          <div className="flex flex-wrap gap-1.5">
            {WEBHOOK_PRESETS.map((entry) => {
              const active = (config?.preset ?? "generic") === entry.value;
              return (
                <button
                  key={entry.value}
                  type="button"
                  data-testid={`webhook-preset-${entry.value}`}
                  onClick={() => choosePreset(entry.value)}
                  className={cn(
                    choiceCls(active),
                    "inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[11.5px] font-medium",
                    !active && "text-muted-fg hover:text-fg",
                  )}
                >
                  <span className={active ? "text-fg" : "text-muted-fg"}>{PRESET_ICONS[entry.value]}</span>
                  {entry.label}
                </button>
              );
            })}
          </div>
        </StepRow>

        <StepRow
          n={2}
          title="Your webhook URL"
          hint="Treat it like a password: anyone who has it can ring the doorbell."
          done={Boolean(endpoint?.url && endpoint.route !== "local")}
        >
          {creating && !endpoint ? (
            <div className={cn(panelCls, "px-3 py-2.5 text-[11px] text-muted-fg/70")}>Making a private URL…</div>
          ) : endpoint?.url ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <code
                  className={cn(panelCls, "min-w-0 flex-1 truncate px-2.5 py-1.5 font-mono text-[11px] text-fg/90")}
                  title={endpoint.url}
                >
                  {endpoint.url}
                </code>
                <Button size="sm" variant="primary" onClick={() => void copyText(endpoint.url!, "URL")}>
                  <Copy size={12} />
                  Copy
                </Button>
                <Button size="sm" variant="outline" disabled={rotating} onClick={() => void rotate()} title="Make a new URL and retire this one">
                  <ArrowsClockwise size={12} className={cn(rotating && "animate-spin")} />
                  New URL
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-fg">
                <RouteBadge endpoint={endpoint} />
                {endpoint.route === "relay" ? <span>If this computer is asleep, ADE keeps requests for up to 3 days and runs them when it wakes.</span> : null}
              </div>
              {endpoint.route === "local" && endpoint.setupError ? (
                <Banner layout="inline" model={{ id: "webhook-local-only", tone: "warning", title: endpoint.setupError }} />
              ) : null}
            </div>
          ) : endpoint && !endpoint.ownedHere ? (
            <Banner
              layout="inline"
              model={{
                id: "webhook-other-machine",
                tone: "info",
                title: endpoint.setupError ?? "This URL lives on another machine.",
                actions: [{ label: "Make a URL here", onClick: () => void recreateHere(), disabled: creating }],
              }}
            />
          ) : endpointError ? (
            <Banner
              layout="inline"
              model={{
                id: "webhook-endpoint-error",
                tone: "error",
                title: endpointError,
                actions: [{ label: "Try again", onClick: () => void (hookId ? refreshEndpoint() : recreateHere()) }],
              }}
            />
          ) : null}
        </StepRow>

        <StepRow n={3} title={`Paste it into ${config?.preset && config.preset !== "generic" ? preset.label : "the service"}`}>
          <ol className="space-y-1">
            {preset.steps.map((step, index) => (
              <li key={step} className="flex gap-2 text-[11px] leading-relaxed text-fg/80">
                <span className="mt-[1px] text-muted-fg/50">{index + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </StepRow>

        <StepRow
          n={4}
          title="Prove it's really them"
          hint={
            signature
              ? preset.secretSource === "you"
                ? `${preset.label === "Anything else" ? "The service" : preset.label} signs every request with a secret you choose. ADE rejects anything without the right signature.`
                : `${preset.label} gives you a signing secret. Paste it here and ADE rejects anything not signed with it.`
              : "Optional, but recommended: without it, anyone with the URL can start a run."
          }
          done={Boolean(signature && secretSaved)}
        >
          <div className="space-y-2">
            <label className={cn(panelCls, "flex cursor-pointer items-center justify-between gap-3 px-3 py-2")}>
              <span className="flex items-center gap-2 text-[11.5px] text-fg/90">
                <ShieldCheck size={13} weight={signature ? "fill" : "regular"} className={signature ? toneTextCls.ok : "text-muted-fg"} />
                Require a signature
              </span>
              <SettingsToggle id={`webhook-signature-${hookId ?? "new"}`} checked={Boolean(signature)} onChange={setSignatureEnabled} />
            </label>

            {signature ? (
              <div className={cn(panelCls, "space-y-2 p-3")}>
                {secretSaved && !generatedSecret ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("flex items-center gap-1.5 text-[11.5px]", toneTextCls.ok)}>
                      <CheckCircle size={13} weight="fill" />
                      <span className="font-mono">{signature.secretName}</span> is saved in this project
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setReplacingSecret(true)}>
                      Replace
                    </Button>
                  </div>
                ) : generatedSecret ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-fg/85">
                      Here's your new secret. Paste it into {preset.label === "Anything else" ? "the service" : preset.label}'s <b>Secret</b> field now. ADE saved it
                      as <span className="font-mono">{signature.secretName}</span> and won't show it again.
                    </div>
                    <div className="flex items-center gap-1.5">
                      <code className={cn(panelCls, "min-w-0 flex-1 truncate px-2.5 py-1.5 font-mono text-[11px] text-fg")}>
                        {generatedSecret}
                      </code>
                      <Button size="sm" variant="primary" onClick={() => void copyText(generatedSecret, "Secret")}>
                        <Copy size={12} />
                        Copy
                      </Button>
                      <Button size="sm" variant="ghost" data-testid="webhook-secret-done" onClick={() => setGeneratedSecret(null)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ) : preset.secretSource === "you" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" data-testid="webhook-generate-secret" disabled={savingSecret} onClick={() => void generateSecret()}>
                      <Sparkle size={12} weight="fill" />
                      Generate a secret
                    </Button>
                    <span className="text-[10.5px] text-muted-fg/65">or paste your own:</span>
                    <SecretInput
                      value={secretDraft}
                      visible={secretVisible}
                      onToggleVisible={() => setSecretVisible((v) => !v)}
                      onChange={setSecretDraft}
                      onSave={() => void saveSecret(secretDraft)}
                      saving={savingSecret}
                      placeholder="Your secret"
                    />
                  </div>
                ) : (
                  <SecretInput
                    value={secretDraft}
                    visible={secretVisible}
                    onToggleVisible={() => setSecretVisible((v) => !v)}
                    onChange={setSecretDraft}
                    onSave={() => void saveSecret(secretDraft)}
                    saving={savingSecret}
                    placeholder={config?.preset === "stripe" ? "whsec_…" : `Paste ${preset.label}'s signing secret`}
                  />
                )}
                <div className="flex items-center gap-1 text-[10px] text-muted-fg/55">
                  <Key size={10} />
                  Stored encrypted in this project's secrets. It never leaves this computer and is never shown to agents.
                </div>
                <button
                  type="button"
                  className="text-[10.5px] text-muted-fg/60 underline-offset-2 hover:text-fg hover:underline"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? "Hide signature format" : "Signature format"}
                </button>
                {showAdvanced ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className={labelCls}>Header</span>
                      <input
                        className={cn(inputCls, "font-mono")}
                        value={signature.header}
                        spellCheck={false}
                        onChange={(event) => patchConfig({ signature: { ...signature, header: event.target.value.toLowerCase() } })}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className={labelCls}>Secret name</span>
                      <input
                        className={cn(inputCls, "font-mono")}
                        value={signature.secretName}
                        spellCheck={false}
                        onChange={(event) => patchConfig({ signature: { ...signature, secretName: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") } })}
                      />
                    </label>
                    {signature.scheme === "hmac" ? (
                      <>
                        <label className="space-y-1">
                          <span className={labelCls}>Prefix</span>
                          <input
                            className={cn(inputCls, "font-mono")}
                            value={signature.prefix ?? ""}
                            placeholder="(none)"
                            spellCheck={false}
                            onChange={(event) => patchConfig({ signature: { ...signature, prefix: event.target.value } })}
                          />
                        </label>
                        <label className="space-y-1">
                          <span className={labelCls}>Encoding</span>
                          <select
                            className={selectCls}
                            value={signature.encoding ?? "hex"}
                            onChange={(event) => patchConfig({ signature: { ...signature, encoding: event.target.value === "base64" ? "base64" : "hex" } })}
                          >
                            <option value="hex">hex</option>
                            <option value="base64">base64</option>
                          </select>
                        </label>
                      </>
                    ) : (
                      <div className="text-[10.5px] text-muted-fg/65 sm:col-span-2">Stripe format: t=…,v1=… over the timestamp and body.</div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </StepRow>

        <StepRow
          n={5}
          title="Only run when…"
          hint="Checked before any agent starts, so noise never costs you a run. Leave empty to run on every request."
          done={filters.length > 0}
        >
          <div className="space-y-1.5">
            {filters.map((filter, index) => (
              <FilterRow
                key={index}
                filter={filter}
                onChange={(next) => setFilters(filters.map((entry, i) => (i === index ? next : entry)))}
                onRemove={() => setFilters(filters.filter((_, i) => i !== index))}
              />
            ))}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setFilters([...filters, { path: "body.", op: "equals", value: "" }])}>
                <Plus size={12} />
                Add condition
              </Button>
              {preset.suggestedFilters.length && !filters.length ? (
                <Button size="sm" variant="outline" data-testid="webhook-use-suggested-filters" casing="sentence" onClick={() => setFilters(preset.suggestedFilters.map((entry) => ({ ...entry })))}>
                  <Funnel size={12} />
                  Use: {preset.suggestedFilters.map(describeWebhookFilter).join(", ")}
                </Button>
              ) : null}
            </div>
          </div>
        </StepRow>

        <StepRow
          n={6}
          title="Use the request in your prompt"
          hint={
            latestBody
              ? "Fields from the last request that arrived. Click one to copy its placeholder, then paste it into the agent's prompt below."
              : `Fields from a sample ${config?.preset && config.preset !== "generic" ? preset.label : ""} request. Click one to copy its placeholder.`
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {fields.map((field) => (
                <button
                  key={field.path}
                  type="button"
                  onClick={() => void copyText(`{{trigger.${field.path}}}`, "Placeholder")}
                  className={cn(choiceCls(false), "group inline-flex max-w-full items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-left text-[10.5px]")}
                  title={`{{trigger.${field.path}}} → ${field.sample}`}
                >
                  <span className="font-mono text-fg/85">{field.path.replace(/^body\./, "")}</span>
                  <span className="truncate text-muted-fg">{field.sample}</span>
                </button>
              ))}
            </div>
            {onUsePrompt && promptIsEmpty ? (
              <Button size="sm" variant="outline" data-testid="webhook-use-suggested-prompt" onClick={() => onUsePrompt(preset.suggestedPrompt)}>
                <Sparkle size={12} weight="fill" />
                Start with a suggested prompt
              </Button>
            ) : null}
          </div>
        </StepRow>

        <StepRow n={7} title="Ring it once" hint="Sends a sample request to your URL, signed the way the service will sign it, so you can watch it arrive." done={deliveries.some((entry) => entry.outcome === "ran")}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" data-testid="webhook-send-test" disabled={testing || !endpoint?.url} onClick={() => void sendTest()}>
                <PaperPlaneTilt size={12} weight="fill" className={cn(testing && "animate-pulse")} />
                {testing ? "Sending…" : "Send test"}
              </Button>
              {testResult ? (
                <span className={cn("text-[11.5px]", testResult.ok ? toneTextCls.ok : toneTextCls.warn)}>
                  {testResult.ok
                    ? testResult.route === "relay"
                      ? "Delivered to ADE's relay. It shows up below in a moment."
                      : "Delivered. See it below."
                    : `Your URL answered ${testResult.status}. Open it below to see why.`}
                </span>
              ) : null}
            </div>
            {testError ? <Banner layout="inline" model={{ id: "webhook-test-error", tone: "warning", title: testError }} /> : null}
            {hookId ? (
              <WebhookDeliveries
                hookId={hookId}
                deliveries={deliveries}
                runtimePin={runtimePin}
                onChanged={() => void refreshDeliveries()}
              />
            ) : null}
          </div>
        </StepRow>
      </div>
    </div>
  );
}

function SecretInput({
  value,
  visible,
  onToggleVisible,
  onChange,
  onSave,
  saving,
  placeholder,
}: {
  value: string;
  visible: boolean;
  onToggleVisible: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  placeholder: string;
}) {
  return (
    <div className="flex min-w-[260px] flex-1 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <input
          className={cn(inputCls, "pr-8 font-mono")}
          type={visible ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onSave();
          }}
        />
        <button
          type="button"
          onClick={onToggleVisible}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg/60 hover:text-fg"
          aria-label={visible ? "Hide secret" : "Show secret"}
        >
          {visible ? <EyeSlash size={12} /> : <Eye size={12} />}
        </button>
      </div>
      <Button size="sm" variant="primary" disabled={saving || !value.trim()} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}
