import { useCallback, useEffect, useState } from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import type { MessagesIntegrationStatus, MessagesIntegrationSettings } from "../../../../shared/types/messagesIntegration";
import { ipcErrorMessage } from "../../../lib/format";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/notice";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "../primitives";

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
  const toggle = (key: keyof MessagesIntegrationSettings, title: string, hint: string, disabled = false) => (
    <ModernRow
      key={key}
      title={title}
      hint={hint}
      control={(
        <SettingsToggle
          checked={status[key]}
          onChange={(next) => void set({ [key]: next })}
          disabled={busy || disabled}
          label={title}
        />
      )}
    />
  );

  return (
    <div data-testid="messages-integration">
      <ModernSection
        group="messages"
        title="Messages"
        hint="Let agents read your texts (sign-in codes, conversations) and send texts you approve, on this Mac. Cloud lanes ask the Mac you're using."
        icon={<ChatCircleText size={16} weight="fill" />}
        actions={(
          <Button
            size="sm"
            variant={status.connected ? "outline" : "primary"}
            disabled={busy}
            data-testid={status.connected ? "messages-disconnect" : "messages-connect"}
            onClick={() => void set({ connected: !status.connected })}
          >
            {status.connected ? "Disconnect" : "Connect"}
          </Button>
        )}
      >
        {status.connected && status.access === "needs_full_disk_access" ? (
          <Banner
            layout="inline"
            model={{
              id: "messages-full-disk-access",
              tone: "warning",
              title: "ADE needs Full Disk Access to read Messages.",
              actions: [
                { label: "Open Full Disk Access", onClick: () => void window.ade.app.openSystemSettingsPane("macos-full-disk-access") },
                { label: "Check again", variant: "secondary", onClick: () => void load() },
              ],
            }}
          />
        ) : null}
        {status.connected && status.access === "no_database" ? (
          <Banner layout="inline" model={{ id: "messages-no-database", tone: "warning", title: "Messages isn't set up on this Mac (no messages found)." }} />
        ) : null}
        {status.connected ? (
          <ModernRows>
            {toggle("readTexts", "Read texts", "Agents can read your conversations and attachments, for example to find a sign-in code.")}
            {toggle("sendTexts", "Send texts", "Agents can send a text. You approve each one first, unless the next switch is on.")}
            {toggle("sendWithoutAsking", "Send without asking", "Texts go out without an approval card.", !status.sendTexts)}
            <ModernRow
              title="Sending uses the Messages app"
              hint="macOS asks once to let ADE control it."
              control={(
                <Button size="sm" variant="outline" onClick={() => void window.ade.app.openSystemSettingsPane("macos-automation")}>
                  Automation settings
                </Button>
              )}
            />
          </ModernRows>
        ) : null}
        {error ? <Banner layout="inline" model={{ id: "messages-integration-error", tone: "error", title: error, report: false }} /> : null}
      </ModernSection>
    </div>
  );
}
