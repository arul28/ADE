import { useCallback, useEffect, useState } from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import type { MessagesIntegrationStatus, MessagesIntegrationSettings } from "../../../../shared/types/messagesIntegration";
import { ipcErrorMessage } from "../../../lib/format";

/**
 * Settings › Integrations › Messages, on a Mac.
 *
 * Agents read the person's texts (a sign-in code, a conversation) and send
 * texts they approve. Off until connected; then Read Texts and Send Texts on,
 * Send Without Asking off. It is this Mac's (its Messages database and app),
 * so it reads this desktop's own main process, never a pinned machine; a
 * cloud lane reaches it through the Mac the person is using.
 */
export function MessagesIntegrationCard() {
  const api = window.ade?.builtInBrowser;
  const [status, setStatus] = useState<MessagesIntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api?.messagesIntegrationStatus) return;
    try {
      setStatus(await api.messagesIntegrationStatus());
      setError(null);
    } catch (failure) {
      setError(ipcErrorMessage(failure) || "ADE couldn't read the Messages integration.");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = useCallback(async (next: Partial<MessagesIntegrationSettings>) => {
    if (!api?.messagesIntegrationSet || busy) return;
    setBusy(true);
    try {
      setStatus(await api.messagesIntegrationSet(next));
      setError(null);
    } catch (failure) {
      setError(ipcErrorMessage(failure) || "ADE couldn't change the Messages integration.");
    } finally {
      setBusy(false);
    }
  }, [api, busy]);

  if (!status?.supported) return null;
  const switchRow = (key: keyof MessagesIntegrationSettings, title: string, hint: string, disabled = false) => (
    <div className="ade-ig-msg-row" key={key}>
      <span className="ade-ig-msg-text">
        <span className="ade-ig-msg-title">{title}</span>
        <span className="ade-ig-msg-hint">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={status[key]}
        aria-label={title}
        data-testid={`messages-switch-${key}`}
        className="ade-ig-msg-switch"
        data-on={status[key] ? "true" : "false"}
        disabled={busy || disabled}
        onClick={() => void set({ [key]: !status[key] })}
      >
        <span className="ade-ig-msg-knob" />
      </button>
    </div>
  );

  return (
    <section className="ade-ix-section ade-ig-msg" aria-label="Messages" data-settings-group="messages" data-testid="messages-integration">
      <div className="ade-ig-msg-head">
        <span className="ade-ig-msg-logo" aria-hidden><ChatCircleText size={18} weight="fill" /></span>
        <span className="ade-ig-msg-text">
          <span className="ade-ig-msg-title">Messages</span>
          <span className="ade-ig-msg-hint">
            Let agents read your texts (sign-in codes, conversations) and send texts you approve, on this Mac.
            Cloud lanes ask the Mac you're using.
          </span>
        </span>
        {!status.connected ? (
          <button type="button" className="ade-ig-msg-connect" disabled={busy} data-testid="messages-connect" onClick={() => void set({ connected: true })}>
            Connect
          </button>
        ) : (
          <button type="button" className="ade-ig-msg-disconnect" disabled={busy} data-testid="messages-disconnect" onClick={() => void set({ connected: false })}>
            Disconnect
          </button>
        )}
      </div>
      {status.connected ? (
        <div className="ade-ig-msg-rows">
          {status.access === "needs_full_disk_access" ? (
            <div className="ade-ig-msg-warn" role="alert">
              ADE needs Full Disk Access to read Messages.
              <button type="button" onClick={() => void window.ade.app.openSystemSettingsPane("macos-full-disk-access")}>Open Full Disk Access</button>
              <button type="button" onClick={() => void load()}>Check again</button>
            </div>
          ) : status.access === "no_database" ? (
            <div className="ade-ig-msg-warn" role="alert">Messages isn't set up on this Mac (no messages found).</div>
          ) : null}
          {switchRow("readTexts", "Read texts", "Agents can read your conversations and attachments, for example to find a sign-in code.")}
          {switchRow("sendTexts", "Send texts", "Agents can send a text. You approve each one first, unless the next switch is on.")}
          {switchRow("sendWithoutAsking", "Send without asking", "Texts go out without an approval card.", !status.sendTexts)}
          <div className="ade-ig-msg-foot">
            Sending uses the Messages app; macOS asks once to let ADE control it.
            <button type="button" onClick={() => void window.ade.app.openSystemSettingsPane("macos-automation")}>Automation settings</button>
          </div>
        </div>
      ) : null}
      {error ? <div className="ade-ig-msg-warn" role="alert">{error}</div> : null}
    </section>
  );
}
