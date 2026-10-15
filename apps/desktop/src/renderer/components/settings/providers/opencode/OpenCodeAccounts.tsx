/**
 * Settings → Providers → an OpenCode provider → Accounts.
 *
 * OpenCode keeps several logins per provider and uses one of them, the one in
 * use, for every chat on the machine. This shows that set for the machine the
 * Settings page is on: which login is in use, a one-click switch to another,
 * rename and sign out, and how to add one more — a browser sign-in, or a cloud
 * login that rides on the machine's own gcloud or AWS login.
 *
 * A cloud login is saved to the ADE account, so each of the user's machines
 * sets it up; whether that machine actually has the gcloud or AWS login behind
 * it is the machine's own answer, shown on the row with the command that fixes
 * it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CloudCheck,
  Copy,
  Globe,
  PencilSimple,
  Plus,
  SignOut,
} from "@phosphor-icons/react";
import type {
  OpenCodeAccount,
  OpenCodeCloudConnectResult,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthPrompt,
} from "../../../../../shared/types/config";
import type { OpenProjectBinding } from "../../../../../shared/types";
import { Dialog, confirmDialog, promptDialog } from "../../../ui/dialog";
import { Banner } from "../../../ui/notice/Banner";
import { showToast } from "../../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../../lib/launchPromptClipboard";
import "./openCodeAccounts.css";

/** Labels OpenCode gives a login when nobody named it; they say nothing about which login it is. */
const GENERIC_LABELS = new Set(["oauth", "api key", "manually enter api key", "credential"]);

const CLOUD_METHOD_NAMES: Record<string, string> = {
  "google-adc": "Google Cloud login",
  "aws-profile": "AWS profile",
};

function cloudMethodName(methodId: string): string {
  return CLOUD_METHOD_NAMES[methodId] ?? "Cloud login";
}

/** What a login is, in words: "Subscription", "API key", "Google Cloud login · my-project · global". */
export function openCodeAccountDetail(account: OpenCodeAccount): string {
  if (account.cloud) {
    return [cloudMethodName(account.cloud.methodId), ...Object.values(account.cloud.details)].join(" · ");
  }
  if (account.kind === "subscription") return "Subscription";
  if (account.kind === "api_key") return "API key";
  return "Login";
}

/** The account's name: the user's label, else what it is. */
export function openCodeAccountName(account: OpenCodeAccount, providerName: string): string {
  const label = account.label.trim();
  const generic = !label
    || GENERIC_LABELS.has(label.toLowerCase())
    || label.toLowerCase() === account.providerId.toLowerCase()
    || label.toLowerCase() === providerName.toLowerCase();
  if (!generic) return label;
  if (account.cloud) return Object.values(account.cloud.details)[0] ?? cloudMethodName(account.cloud.methodId);
  return account.kind === "subscription" ? `${providerName} subscription` : `${providerName} key`;
}

/** What signing a login out does, said before it happens. */
function signOutMessage(args: {
  synced: boolean;
  inUse: boolean;
  accountCount: number;
  providerName: string;
  machineName: string;
}): string {
  if (args.synced) return `It is removed from ${args.providerName} on all your computers.`;
  if (args.inUse && args.accountCount > 1) {
    return `${args.providerName} switches to your next account on ${args.machineName}.`;
  }
  return `${args.providerName} on ${args.machineName} stops using it.`;
}

/** One provider's OpenCode logins on the page's machine. Reloads when the machine changes. */
export function useOpenCodeAccounts(providerId: string, pin: OpenProjectBinding | null) {
  const [accounts, setAccounts] = useState<OpenCodeAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await window.ade.ai.opencodeAccounts({ providerId }, pinRef.current);
      if (request !== requestRef.current) return;
      setAccounts(result.accounts);
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [providerId]);

  // Keyed on the pin's key, not the object: a rebuilt pin for the same machine
  // must not refetch.
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    void reload();
  }, [reload, pinKey]);

  return { accounts, loading, error, reload };
}

function ReadinessLine({ account, machineName }: { account: OpenCodeAccount; machineName: string }) {
  const readiness = account.cloud?.readiness;
  if (!readiness || readiness.state === "unknown") return null;
  if (readiness.state === "ready") {
    return (
      <div className="ade-oc-acct-readiness" title={readiness.detail}>
        <span className="kit-dot" data-state="ok" aria-hidden />
        <span>Ready on {machineName}</span>
      </div>
    );
  }
  return (
    <div className="ade-oc-acct-readiness" data-state="warn">
      <span className="kit-dot" data-state="warn" aria-hidden />
      <span>{readiness.detail.replace("this computer", machineName)} Run</span>
      <code className="ade-oc-acct-command">{readiness.command}</code>
      <button
        type="button"
        className="kit-icon-btn ade-oc-acct-copy"
        aria-label={`Copy ${readiness.command}`}
        title="Copy"
        onClick={() => {
          void copyTextToClipboard(readiness.command).then((ok) => {
            if (ok) showToast({ title: "Command copied", tone: "success" });
          });
        }}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

function AccountRow({
  account,
  providerName,
  machineName,
  busy,
  onActivate,
  onRename,
  onRemove,
}: {
  account: OpenCodeAccount;
  providerName: string;
  machineName: string;
  busy: boolean;
  onActivate: (account: OpenCodeAccount) => void;
  onRename: (account: OpenCodeAccount) => void;
  onRemove: (account: OpenCodeAccount) => void;
}) {
  const name = openCodeAccountName(account, providerName);
  return (
    <li className="ade-oc-acct-row" data-active={account.active ? "true" : undefined}>
      <span className="ade-oc-acct-icon" aria-hidden>
        {account.cloud ? <CloudCheck size={14} /> : <Globe size={14} />}
      </span>
      <div className="ade-oc-acct-main">
        <div className="ade-oc-acct-name" title={name}>{name}</div>
        <div className="ade-oc-acct-detail">
          {openCodeAccountDetail(account)}
          {account.cloud?.synced ? <span className="ade-oc-acct-sync"> · On all your computers</span> : null}
        </div>
        <ReadinessLine account={account} machineName={machineName} />
      </div>
      <div className="ade-oc-acct-actions">
        {account.active ? (
          <span className="kit-tag" data-tone="ok">In use</span>
        ) : (
          <button
            type="button"
            className="kit-btn kit-btn-ghost"
            data-size="sm"
            disabled={busy}
            aria-label={`Use ${name}`}
            onClick={() => onActivate(account)}
          >
            Use
          </button>
        )}
        <button
          type="button"
          className="kit-icon-btn"
          disabled={busy}
          aria-label={`Rename ${name}`}
          title="Rename"
          onClick={() => onRename(account)}
        >
          <PencilSimple size={13} />
        </button>
        <button
          type="button"
          className="kit-icon-btn ade-oc-acct-signout"
          disabled={busy}
          aria-label={`Sign out ${name}`}
          title="Sign out"
          onClick={() => onRemove(account)}
        >
          <SignOut size={13} />
        </button>
      </div>
    </li>
  );
}

/**
 * The accounts list with its add button. Renders nothing until the machine
 * has a login for the provider: the dialog's sign-in section covers that case.
 */
export function OpenCodeAccountsSection({
  providerId,
  providerName,
  machineName,
  pin,
  accounts,
  loading,
  error,
  reload,
  onAddAccount,
  onChanged,
}: {
  providerId: string;
  providerName: string;
  /** The machine as it reads mid-sentence: "this computer", or its name. */
  machineName: string;
  pin: OpenProjectBinding | null;
  accounts: OpenCodeAccount[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  onAddAccount: () => void;
  /** After a switch, rename or sign-out, so the page re-reads provider status. */
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(
    async (account: OpenCodeAccount, work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
      setBusyId(account.id);
      setActionError(null);
      try {
        const result = await work();
        if (!result.ok) {
          setActionError(result.error ?? "That account change did not go through.");
          return;
        }
        if (done) showToast({ title: done, tone: "success" });
        await reload();
        onChanged();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [onChanged, reload],
  );

  const activate = useCallback(
    (account: OpenCodeAccount) => {
      const name = openCodeAccountName(account, providerName);
      void run(
        account,
        () => window.ade.ai.opencodeAccountActivate({ id: account.id }, pin),
        `${providerName} now uses ${name}`,
      );
    },
    [pin, providerName, run],
  );

  const rename = useCallback(
    (account: OpenCodeAccount) => {
      void promptDialog({
        title: "Rename account",
        defaultValue: openCodeAccountName(account, providerName),
        confirmLabel: "Rename",
        validate: (value) => (value.trim().length > 80 ? "Keep it under 80 characters." : null),
      }).then((label) => {
        const next = label?.trim();
        if (!next) return;
        void run(account, () => window.ade.ai.opencodeAccountRename({ id: account.id, label: next }, pin));
      });
    },
    [pin, providerName, run],
  );

  const remove = useCallback(
    (account: OpenCodeAccount) => {
      const name = openCodeAccountName(account, providerName);
      const synced = account.cloud?.synced === true;
      void confirmDialog({
        title: `Sign out ${name}?`,
        message: signOutMessage({ synced, inUse: account.active, accountCount: accounts.length, providerName, machineName }),
        confirmLabel: "Sign out",
        destructive: true,
      }).then((ok) => {
        if (ok) void run(account, () => window.ade.ai.opencodeAccountRemove({ id: account.id }, pin));
      });
    },
    [accounts.length, machineName, pin, providerName, run],
  );

  if (accounts.length === 0) return null;
  // A failed refresh keeps the last list; only say so when it is stale.
  const shownError = actionError ?? error;

  return (
    <section className="ade-oc-acct" aria-label={`${providerName} accounts`}>
      <header className="ade-oc-acct-head">
        <span className="kit-eyebrow">Accounts</span>
        {accounts.length ? <span className="kit-num ade-oc-acct-count">{accounts.length}</span> : null}
        {loading ? <ArrowsClockwise size={11} className="animate-spin motion-reduce:animate-none ade-oc-acct-spin" aria-label="Refreshing" /> : null}
        <button type="button" className="kit-btn" data-size="sm" onClick={onAddAccount} style={{ marginLeft: "auto" }}>
          <Plus size={11} weight="bold" /> Add account
        </button>
      </header>
      {shownError ? (
        <Banner
          layout="inline"
          model={{
            id: `opencode-accounts-${providerId}`,
            tone: "error",
            title: shownError,
            actions: [{ label: "Retry", onClick: () => { setActionError(null); void reload(); }, variant: "secondary" }],
          }}
        />
      ) : null}
      {accounts.length ? (
        <ul className="ade-oc-acct-list">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              providerName={providerName}
              machineName={machineName}
              busy={busyId !== null}
              onActivate={activate}
              onRename={rename}
              onRemove={remove}
            />
          ))}
        </ul>
      ) : null}
      {accounts.length > 1 ? (
        <div className="ade-oc-acct-hint">Every chat on {machineName} uses the account in use.</div>
      ) : null}
    </section>
  );
}

function promptVisible(prompt: OpenCodeProviderAuthPrompt, inputs: Record<string, string>): boolean {
  if (!prompt.when) return true;
  const current = inputs[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? current === prompt.when.value : current !== prompt.when.value;
}

function CloudLoginForm({
  providerId,
  providerName,
  method,
  methodIndex,
  pin,
  onBack,
  onAdded,
}: {
  providerId: string;
  providerName: string;
  method: OpenCodeProviderAuthMethod;
  methodIndex: number;
  pin: OpenProjectBinding | null;
  onBack: (() => void) | null;
  onAdded: (result: OpenCodeCloudConnectResult) => void;
}) {
  const prompts = method.prompts ?? [];
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(prompts.map((prompt) => [
      prompt.key,
      prompt.defaultValue ?? (prompt.type === "select" ? prompt.options?.[0]?.value ?? "" : ""),
    ])),
  );
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = prompts.filter((prompt) => promptVisible(prompt, inputs));
  const missing = visible.some((prompt) => prompt.required && !inputs[prompt.key]?.trim());

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(visible.map((prompt) => [prompt.key, inputs[prompt.key]?.trim() ?? ""]));
      const result = await window.ade.ai.opencodeCloudConnect({
        providerId,
        methodIndex,
        inputs: answers,
        ...(label.trim() ? { label: label.trim() } : {}),
      }, pin);
      if (!result.ok) {
        setError(result.error ?? `OpenCode could not add the ${providerName} login.`);
        return;
      }
      onAdded(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ade-oc-cloud-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? <Banner layout="inline" model={{ id: "opencode-cloud-error", tone: "error", title: error }} /> : null}
      {visible.map((prompt) => {
        const id = `opencode-cloud-${providerId}-${prompt.key}`;
        const listId = `${id}-options`;
        return (
          <label key={prompt.key} className="ade-oc-cloud-field" htmlFor={id}>
            <span className="ade-oc-cloud-label">{prompt.message}</span>
            {prompt.type === "select" ? (
              <select
                id={id}
                className="kit-input"
                value={inputs[prompt.key] ?? ""}
                onChange={(event) => setInputs((prev) => ({ ...prev, [prompt.key]: event.target.value }))}
              >
                {(prompt.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <>
                <input
                  id={id}
                  className="kit-input"
                  value={inputs[prompt.key] ?? ""}
                  placeholder={prompt.placeholder}
                  list={prompt.options?.length ? listId : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setInputs((prev) => ({ ...prev, [prompt.key]: event.target.value }))}
                />
                {prompt.options?.length ? (
                  <datalist id={listId}>
                    {prompt.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </datalist>
                ) : null}
              </>
            )}
            {prompt.description ? <span className="ade-oc-cloud-hint">{prompt.description}</span> : null}
          </label>
        );
      })}
      <label className="ade-oc-cloud-field" htmlFor={`opencode-cloud-${providerId}-label`}>
        <span className="ade-oc-cloud-label">Name <span className="ade-oc-cloud-optional">optional</span></span>
        <input
          id={`opencode-cloud-${providerId}-label`}
          className="kit-input"
          value={label}
          maxLength={80}
          placeholder={visible[0] ? inputs[visible[0].key] || method.label : method.label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="ade-oc-cloud-note">
        <CloudCheck size={13} aria-hidden />
        Saved to your ADE account. Each of your computers uses its own {cloudMethodName(method.methodId ?? "")}.
      </div>
      <div className="ade-oc-cloud-actions">
        {onBack ? (
          <button type="button" className="kit-btn kit-btn-ghost" onClick={onBack} disabled={busy}>Back</button>
        ) : null}
        <button type="submit" className="kit-btn kit-btn-primary" disabled={missing || busy}>
          {busy ? "Adding…" : "Add login"}
        </button>
      </div>
    </form>
  );
}

/**
 * Add another login: pick a way in (a browser sign-in or a cloud login), then
 * either hand off to the browser sign-in dialog or fill the cloud login's form
 * here. With one way in, the picker is skipped.
 */
export function OpenCodeAddAccountDialog({
  providerId,
  providerName,
  methods,
  pin,
  onClose,
  onStartOAuth,
  onAdded,
}: {
  providerId: string;
  providerName: string;
  /** The provider's full method list; indexes are the backend's. */
  methods: OpenCodeProviderAuthMethod[];
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onStartOAuth: (methodIndex: number) => void;
  onAdded: (result: OpenCodeCloudConnectResult) => void;
}) {
  const choices = useMemo(
    () => methods
      .map((method, index) => ({ method, index }))
      .filter((entry) => entry.method.type === "oauth" || entry.method.type === "cloud"),
    [methods],
  );
  const onlyCloud = choices.length === 1 && choices[0]!.method.type === "cloud" ? choices[0]! : null;
  const [cloudChoice, setCloudChoice] = useState<{ method: OpenCodeProviderAuthMethod; index: number } | null>(onlyCloud);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={cloudChoice ? cloudMethodName(cloudChoice.method.methodId ?? "") : "Add an account"}
      description={cloudChoice
        ? `${providerName} · uses a login the computer already has. No key is stored.`
        : `${providerName} · OpenCode uses one account at a time.`}
      width={420}
    >
      {cloudChoice ? (
        <CloudLoginForm
          providerId={providerId}
          providerName={providerName}
          method={cloudChoice.method}
          methodIndex={cloudChoice.index}
          pin={pin}
          onBack={onlyCloud ? null : () => setCloudChoice(null)}
          onAdded={onAdded}
        />
      ) : (
        <ul className="ade-oc-add-list">
          {choices.map(({ method, index }) => (
            <li key={index}>
              <button
                type="button"
                className="kit-row ade-oc-add-row"
                onClick={() => (method.type === "cloud" ? setCloudChoice({ method, index }) : onStartOAuth(index))}
              >
                <span className="ade-oc-acct-icon" aria-hidden>
                  {method.type === "cloud" ? <CloudCheck size={14} /> : <Globe size={14} />}
                </span>
                <span className="ade-oc-add-text">
                  <span className="ade-oc-add-title">{method.label}</span>
                  <span className="ade-oc-add-sub">
                    {method.type === "cloud" ? "Uses the computer's own cloud login" : "Sign in through your browser"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
