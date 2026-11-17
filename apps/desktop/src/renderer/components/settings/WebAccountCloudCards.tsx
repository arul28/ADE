import { useCallback, useEffect, useState } from "react";
import { Plugs, ShareNetwork } from "@phosphor-icons/react";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { PROVIDER_LOGINS_CLOUD_SETTING, readCloudSetting } from "../../../shared/providerLoginsCloudSetting";
import { MCP_SERVERS_SETTING_KEY, MCP_TRANSPORT_LABEL, normalizeMcpRegistry } from "../../../shared/mcpRegistry";
import { Banner } from "../ui/notice";
import { SettingsToggle } from "./primitives/SettingsControls";

/**
 * Settings › ADE Cloud on ADE Web with no computer of the person's own: the
 * account settings a computer would show, read from the account itself
 * (`window.ade.accountSettings`, the push relay's settings route). Nothing
 * here wakes a computer or reads a secret.
 *
 * Each card reads once when it opens and again when the window gets focus.
 * A read that fails shows one line with Try again, never an empty list.
 */

type AccountRead<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };

const READ_FAILED = "ADE couldn't read this from your account. Try again.";

function readAccountSetting(key: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const store = window.ade?.accountSettings;
  if (!store) return Promise.resolve({ ok: false });
  return store
    .get({ scope: ACCOUNT_SCOPE_ALL, key })
    .then((answer) => (answer.ok ? { ok: true as const, value: answer.value } : { ok: false as const }))
    .catch(() => ({ ok: false as const }));
}

/** One account setting, read on open and on window focus (no poll). */
function useAccountSetting(key: string): [AccountRead<unknown>, () => void, (value: unknown) => void] {
  const [read, setRead] = useState<AccountRead<unknown>>({ state: "loading" });
  const load = useCallback(() => {
    void readAccountSetting(key).then((answer) => {
      setRead(answer.ok ? { state: "ready", value: answer.value } : { state: "failed" });
    });
  }, [key]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const replace = useCallback((value: unknown) => setRead({ state: "ready", value }), []);
  return [read, load, replace];
}

function ReadFailed({ id, onRetry }: { id: string; onRetry: () => void }) {
  return (
    <Banner
      layout="inline"
      model={{ id, tone: "warning", title: READ_FAILED, report: false, actions: [{ label: "Try again", onClick: onRetry }] }}
    />
  );
}

/**
 * The one switch for all of ADE Cloud's sign-ins: `providerLogins.cloud`
 * `enabled` (absent = on). The write keeps every other field of the setting
 * (the picks, the keys switched off, Claude's smart balance) as it is.
 */
export function WebSignInSharingCard() {
  const [read, reload, replace] = useAccountSetting(PROVIDER_LOGINS_CLOUD_SETTING);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = read.state === "ready" ? readCloudSetting(read.value).enabled : null;

  const setOn = async (next: boolean) => {
    const store = window.ade?.accountSettings;
    if (!store || read.state !== "ready") return;
    setPending(next);
    setError(null);
    // Read again right before the write, so a change from another device to
    // the other fields is kept.
    // If that read fails, nothing is written: a write with no base would
    // erase the picks and the keys switched off.
    const fresh = await readAccountSetting(PROVIDER_LOGINS_CLOUD_SETTING);
    if (!fresh.ok) {
      setError(READ_FAILED);
      setPending(null);
      return;
    }
    const base = fresh.value && typeof fresh.value === "object" && !Array.isArray(fresh.value)
      ? (fresh.value as Record<string, unknown>)
      : {};
    const value = { ...base, v: 1, enabled: next };
    try {
      const answer = await store.set({ scope: ACCOUNT_SCOPE_ALL, key: PROVIDER_LOGINS_CLOUD_SETTING, value });
      if (answer.ok) replace(value);
      else setError("ADE couldn't save that to your account. Try again.");
    } catch {
      setError("ADE couldn't save that to your account. Try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <section id="web-sign-in-sharing" className="kit-card adecd-card" aria-label="Share sign-ins with ADE Cloud">
      <header className="kit-card-head">
        <ShareNetwork size={14} />
        Sign-ins on ADE Cloud
      </header>
      <div className="kit-card-body">
        {read.state === "failed" ? <ReadFailed id="web-sign-in-sharing-read" onRetry={reload} /> : null}
        <div className="adecd-signin-switch">
          <div>
            <b>Share my sign-ins with ADE Cloud</b>
            <small>
              {on === false
                ? "Off: you sign in on each cloud computer yourself."
                : "Cloud computers use the sign-ins and keys saved in your account."}
            </small>
          </div>
          <SettingsToggle
            checked={pending ?? on ?? false}
            disabled={read.state !== "ready" || pending !== null}
            label="Share my sign-ins with ADE Cloud"
            onChange={(next) => void setOn(next)}
          />
        </div>
        {error ? (
          <Banner layout="inline" model={{ id: "web-sign-in-sharing-error", tone: "error", title: error, report: false, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The account's MCP servers (`mcp.servers`), by name and kind only. Adding,
 * changing and their secrets stay on a computer: the web holds no vault.
 */
export function WebMcpServersCard() {
  const [read, reload] = useAccountSetting(MCP_SERVERS_SETTING_KEY);
  const servers = read.state === "ready" ? normalizeMcpRegistry(read.value) : [];
  return (
    <section id="web-mcp-servers" className="kit-card adecd-card" aria-label="MCP servers">
      <header className="kit-card-head">
        <Plugs size={14} />
        MCP servers
      </header>
      <div className="kit-card-body">
        {read.state === "failed" ? <ReadFailed id="web-mcp-servers-read" onRetry={reload} /> : null}
        {read.state === "ready" && servers.length === 0 ? (
          <p className="adecd-lead">No MCP servers in your account. Add one in ADE on a computer and every agent gets it, ADE Cloud too.</p>
        ) : null}
        {servers.length ? (
          <>
            <p className="adecd-lead">Agents on every computer, ADE Cloud too, get these. Add or change them in ADE on a computer.</p>
            <ul className="kit-panel adecd-signin-list">
              {servers.map((server) => (
                <li key={server.name} className="adecd-signin">
                  <span className="adecd-signin-text">
                    <b>{server.name}</b>
                    <span>{MCP_TRANSPORT_LABEL[server.transport]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
