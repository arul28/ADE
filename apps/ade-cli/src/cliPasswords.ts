/**
 * `ade passwords`, `ade code` and `ade messages`: the plans and their text
 * output. No value a person saved is ever printed: `code` prints a one-time
 * code, and `secrets exec` prints the command's own (masked) output.
 */
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  firstPositional,
  hasHelpFlag,
  isRecord,
  parseSnoozeDurationMs,
  readValue,
  topLevelHelpText,
  unwrapActionEnvelope,
  type CliPlan,
} from "./cli";

/**
 * `ade code [wait] --site <host>`: a sign-in code for a site. Today's source is
 * the saved login's authenticator (immediate); Messages joins when it is on.
 */
export function buildCodePlan(args: string[]): CliPlan {
  if (hasHelpFlag(args)) return { kind: "help", text: HELP_BY_COMMAND.code ?? topLevelHelpText() };
  const site = readValue(args, ["--site"])?.trim() || null;
  const account = readValue(args, ["--account"])?.trim() || null;
  if (firstPositional(args) === "wait") {
    const fromValue = readValue(args, ["--from"])?.trim() || "any";
    if (!["any", "messages", "authenticator"].includes(fromValue)) {
      throw new CliUsageError("--from is messages, authenticator or any.");
    }
    const timeoutValue = readValue(args, ["--timeout"]);
    const timeoutMs = timeoutValue ? parseSnoozeDurationMs(timeoutValue) : 2 * 60_000;
    return {
      kind: "execute",
      label: "code wait",
      formatter: "passwords-code",
      steps: [actionStep("result", "messages", "codeWait", {
        ...(site ? { site } : {}),
        ...(account ? { username: account } : {}),
        from: fromValue,
        timeoutMs,
        sinceMs: Date.now(),
      })],
      minTimeoutMs: timeoutMs + 30_000,
      progressNotice: `Waiting for a sign-in code${site ? ` for ${site}` : ""}…`,
    };
  }
  if (!site) throw new CliUsageError("ade code needs --site <host>, e.g. ade code --site github.com");
  return {
    kind: "execute",
    label: "code",
    formatter: "passwords-code",
    steps: [actionStep("result", "passwords", "code", { site, ...(account ? { username: account } : {}) })],
  };
}

/** `ade messages …`: the person's texts on their Mac (Settings › Integrations › Messages). */
export function buildMessagesPlan(args: string[]): CliPlan {
  if (hasHelpFlag(args)) return { kind: "help", text: HELP_BY_COMMAND.messages ?? topLevelHelpText() };
  const sub = firstPositional(args) ?? "recent";
  if (sub === "status") {
    return { kind: "execute", label: "messages status", steps: [actionStep("result", "messages", "status", {})] };
  }
  if (sub === "chats") {
    const limit = Number(readValue(args, ["--limit"]) ?? 20);
    return { kind: "execute", label: "messages chats", steps: [actionStep("result", "messages", "chats", { limit })] };
  }
  if (sub === "recent" || sub === "read" || sub === "list") {
    const from = readValue(args, ["--from"])?.trim() || null;
    const chat = readValue(args, ["--chat"])?.trim() || null;
    const sinceValue = readValue(args, ["--since"]);
    const limit = Number(readValue(args, ["--limit"]) ?? 20);
    return {
      kind: "execute",
      label: "messages recent",
      steps: [actionStep("result", "messages", "recent", {
        limit,
        ...(from ? { handle: from } : {}),
        ...(chat ? { chatGuid: chat } : {}),
        ...(sinceValue ? { sinceMs: Date.now() - parseSnoozeDurationMs(sinceValue) } : {}),
      })],
    };
  }
  if (sub === "send") {
    const to = readValue(args, ["--to"])?.trim() || null;
    const text = readValue(args, ["--text", "--message"]);
    if (!to || !text) throw new CliUsageError("messages send needs --to <phone or email> and --text \"…\".");
    return {
      kind: "execute",
      label: "messages send",
      steps: [actionStep("result", "messages", "send", { to, text })],
      minTimeoutMs: 31 * 60_000,
      progressNotice: `Asked the person to approve a text to ${to}…`,
    };
  }
  throw new CliUsageError(`Unknown messages command "${sub}". Use status, recent, chats or send.`);
}

/** `ade passwords …` words → the action they run. Adding and changing items is the person's, in Settings. */
const PASSWORDS_SUBCOMMANDS: Readonly<Record<string, "list" | "status" | "sync">> = {
  list: "list",
  ls: "list",
  status: "status",
  sync: "sync",
  pull: "sync",
};

/** `ade passwords list|status|sync`: summaries and status, never a value. */
export function buildPasswordsPlan(args: string[]): CliPlan {
  if (hasHelpFlag(args)) {
    return { kind: "help", text: HELP_BY_COMMAND.passwords ?? topLevelHelpText() };
  }
  const sub = firstPositional(args) ?? "list";
  const action = PASSWORDS_SUBCOMMANDS[sub];
  if (!action) {
    throw new CliUsageError(`Unknown passwords command "${sub}". Use list, status or sync; the person adds and changes items in Settings › Passwords.`);
  }
  return {
    kind: "execute",
    label: `passwords ${action}`,
    formatter: "passwords",
    steps: [actionStep("result", "passwords", action, {})],
  };
}

/** `ade secrets exec` in text: the command's own output (already masked), then one status line. */
export function formatSecretsExec(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  if (!isRecord(result)) return "";
  const out = [asString(result.stdout) ?? "", asString(result.stderr) ?? ""].filter(Boolean).join("\n").replace(/\n+$/, "");
  const injected = Array.isArray(result.injected) ? result.injected.filter((name): name is string => typeof name === "string") : [];
  const unmasked = Array.isArray(result.unmasked) ? result.unmasked.filter((name): name is string => typeof name === "string") : [];
  const status = result.timedOut === true ? "timed out" : `exit ${result.exitCode ?? asString(result.signal) ?? "?"}`;
  const lines = [
    out,
    `[ade secrets exec: ${status}; secrets in its environment: ${injected.join(", ") || "none"}${result.truncated === true ? "; output cut at 1 MB" : ""}]`,
  ];
  if (unmasked.length) lines.push(`[too short to mask in output: ${unmasked.join(", ")}]`);
  return lines.filter(Boolean).join("\n");
}

/** `ade passwords …` in text: summaries or the on/off status, never a value. */
export function formatPasswords(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  if (Array.isArray(result)) {
    if (result.length === 0) return "No saved logins or secrets. The person adds them in Settings › Passwords.";
    return result.filter(isRecord).map((item) => {
      if (item.kind === "secret") {
        return `secret  ${asString(item.title) ?? "?"}${typeof item.projectScope === "string" ? `  (project ${item.projectScope})` : "  (all projects)"}`;
      }
      const sites = Array.isArray(item.sites) ? item.sites.filter((site): site is string => typeof site === "string").join(", ") : "";
      return `login   ${sites || asString(item.title) || "?"}  ${asString(item.username) ?? "(no username)"}${item.hasTotp === true ? "  +code" : ""}`;
    }).join("\n");
  }
  if (isRecord(result) && typeof result.enabled === "boolean") {
    const here = result.machineKind === "cloud" ? "ADE Cloud computers" : "this computer";
    const lines = [
      `Passwords: ${result.signedIn === false ? "signed out" : result.enabled ? "on" : "off"} for ${here}`,
      `ADE Cloud computers: ${result.cloudEnabled === false ? "off" : result.cloudEnabled === true ? "on" : "not set"}`,
    ];
    if (typeof result.itemCount === "number") lines.push(`Saved items: ${result.itemCount}`);
    return lines.join("\n");
  }
  return "Passwords is up to date.";
}

/** `ade code` in text: the code, where it came from, and how long it lasts. */
export function formatPasswordsCode(value: unknown): string {
  const result = unwrapActionEnvelope(value);
  if (isRecord(result) && result.source === "messages") {
    return `${asString(result.code) ?? ""}  (texted${asString(result.from) ? ` by ${asString(result.from)}` : ""}${asString(result.receivedAt) ? ` at ${asString(result.receivedAt)}` : ""})`;
  }
  if (isRecord(result) && result.source === "authenticator") {
    return `${asString(result.code) ?? ""}  (authenticator; valid ${String(result.secondsLeft ?? "?")} s more)`;
  }
  if (!isRecord(result)) return "No authenticator code for that site. The person can add the site's authenticator key to its login in Settings › Passwords, or the code comes by text or email (open the mail in the ADE browser).";
  return `${asString(result.code) ?? ""}  (${asString(result.site) ?? ""}${asString(result.username) ? ` as ${asString(result.username)}` : ""}; valid ${String(result.secondsLeft ?? "?")} s more)`;
}
