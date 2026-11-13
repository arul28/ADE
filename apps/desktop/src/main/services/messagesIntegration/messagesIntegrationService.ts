import fs from "node:fs";
import path from "node:path";
import { AdeExpectedError } from "../../../shared/expectedError";
import type { MessagesIntegrationSettings, MessagesIntegrationStatus } from "../../../shared/types/messagesIntegration";

/**
 * The Messages integration on a Mac: agents read the person's texts (a
 * sign-in code, a conversation) and send texts the person approved.
 *
 * - Off until the person connects it in Settings › Integrations › Messages.
 *   Then, as decided: Read Texts on, Send Texts on (a card approves each
 *   text), Send Without Asking off.
 * - Reading needs Full Disk Access for ADE (macOS guards ~/Library/Messages);
 *   the reader runs in a child process of ADE.app, so the grant is ADE's.
 * - Sending goes through the Messages app with AppleScript, which needs
 *   Automation permission the first time.
 *
 * The approval card itself is raised by the brain in the agent's chat
 * (`messages.send`), not here: this only enforces the switches. Text bodies,
 * codes and phone numbers are never logged.
 *
 * Windows and Linux: unsupported; every call says so.
 */

export type MessagesReader = {
  access(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  recent(options: Record<string, unknown>): Promise<unknown>;
  chats(options: { limit?: number }): Promise<unknown>;
  send(input: { to: string; text: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
};

const DEFAULT_SETTINGS: MessagesIntegrationSettings = {
  connected: false,
  readTexts: true,
  sendTexts: true,
  sendWithoutAsking: false,
};

export function createMessagesIntegrationService(args: {
  userDataDir: string;
  /** The reader core (`services/messages`); null where it cannot run. */
  reader: MessagesReader | null;
  platform?: NodeJS.Platform;
  logger?: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
}) {
  const platform = args.platform ?? process.platform;
  const supported = platform === "darwin" && args.reader !== null;
  const settingsPath = path.join(args.userDataDir, "messages-integration.json");

  const readSettings = (): MessagesIntegrationSettings => {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Partial<MessagesIntegrationSettings>;
      return {
        connected: parsed.connected === true,
        readTexts: parsed.readTexts !== false,
        sendTexts: parsed.sendTexts !== false,
        sendWithoutAsking: parsed.sendWithoutAsking === true,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  };

  const unsupported = () => new AdeExpectedError("Messages is on Macs only. Connect it in Settings › Integrations › Messages on a Mac.", "user");

  const requireOn = (what: "read" | "send"): MessagesIntegrationSettings => {
    if (!supported) throw unsupported();
    const settings = readSettings();
    if (!settings.connected) {
      throw new AdeExpectedError("Messages isn't connected on this Mac. The person can connect it in Settings › Integrations › Messages.", "user");
    }
    if (what === "read" && !settings.readTexts) throw new AdeExpectedError("Reading texts is off. The person can turn on Read Texts in Settings › Integrations › Messages.", "user");
    if (what === "send" && !settings.sendTexts) throw new AdeExpectedError("Sending texts is off. The person can turn on Send Texts in Settings › Integrations › Messages.", "user");
    return settings;
  };

  const readOrThrow = async <T>(run: () => Promise<unknown>): Promise<T> => {
    const result = await run() as { ok?: boolean; code?: string; message?: string } & T;
    if (result && result.ok === false) {
      if (result.code === "needs_full_disk_access") {
        throw new AdeExpectedError("ADE needs Full Disk Access to read Messages. The person can grant it in System Settings › Privacy & Security › Full Disk Access (Settings › Integrations › Messages has a button).", "user");
      }
      throw new AdeExpectedError(result.message || "Messages could not be read.", "user");
    }
    return result;
  };

  return {
    async status(): Promise<MessagesIntegrationStatus> {
      const settings = readSettings();
      if (!supported) return { ...settings, supported: false, access: "unsupported" };
      const access = await args.reader!.access().catch(() => ({ ok: false as const, code: "error", message: "" }));
      return {
        ...settings,
        supported: true,
        access: access.ok ? "ok" : access.code === "needs_full_disk_access" ? "needs_full_disk_access" : access.code === "no_database" ? "no_database" : "error",
      };
    },

    async setSettings(next: Partial<MessagesIntegrationSettings>): Promise<MessagesIntegrationStatus> {
      if (!supported) throw unsupported();
      const merged = { ...readSettings() };
      for (const key of ["connected", "readTexts", "sendTexts", "sendWithoutAsking"] as const) {
        if (typeof next[key] === "boolean") merged[key] = next[key]!;
      }
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      args.logger?.info("messages_integration.settings_changed", { ...merged });
      return await this.status();
    },

    async recent(options: Record<string, unknown>): Promise<unknown> {
      requireOn("read");
      return await readOrThrow(() => args.reader!.recent(options));
    },

    async chats(options: { limit?: number }): Promise<unknown> {
      requireOn("read");
      return await readOrThrow(() => args.reader!.chats(options));
    },

    /** Sends one text. The caller (the brain) has already had it approved unless Send Without Asking is on. */
    async send(input: { to: string; text: string }): Promise<{ sent: true; to: string }> {
      requireOn("send");
      const to = input.to.trim();
      if (!to || !input.text) throw new AdeExpectedError("A text needs a recipient (phone number or email) and a message.", "user");
      const result = await args.reader!.send({ to, text: input.text });
      if (!result.ok) {
        if (result.code === "needs_automation_permission") {
          throw new AdeExpectedError("ADE needs permission to control Messages. The person can allow it in System Settings › Privacy & Security › Automation.", "user");
        }
        throw new AdeExpectedError(result.message || "Messages could not send the text.", "user");
      }
      args.logger?.info("messages_integration.sent", {});
      return { sent: true, to };
    },
  };
}

export type MessagesIntegrationService = ReturnType<typeof createMessagesIntegrationService>;
