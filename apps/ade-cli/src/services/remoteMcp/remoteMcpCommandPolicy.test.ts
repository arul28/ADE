import { describe, expect, it } from "vitest";
import { HELP_BY_COMMAND } from "../../cli";
import { checkRemoteAdeCommand } from "./remoteMcpCommandPolicy";

/**
 * What an outside AI app may run through ADE MCP. Read only must never reach a
 * write; full access must never reach what outlives revoking it (managing ADE
 * MCP, account credentials), another brain, or another machine.
 */
describe("checkRemoteAdeCommand", () => {
  it.each([
    ["write", "a socket path in place of the command word", ["/Users/u/.ade/sock/ade.sock", "mcp", "token", "create"]],
    ["write", "a leading global flag", ["--headless", "lanes", "create"]],
    ["write", "managing ADE MCP", ["mcp", "token", "create"]],
    ["write", "account tokens behind a flag or --", ["account", "--", "token", "create"]],
    ["write", "an account token through actions, split spelling", ["actions", "run", "account", "createToken"]],
    ["write", "the account bearer token through the `action` alias", ["action", "run", "account.getToken"]],
    ["write", "signing the account out through actions", ["actions", "run", "account.signOut"]],
    ["write", "ADE MCP itself through actions", ["actions", "run", "remote_mcp", "createToken"]],
    ["write", "the raw RPC tool door", ["actions", "call", "run_ade_action"]],
    ["write", "forwarding to another machine", ["chat", "send", "x", "--machine", "desktop"]],
    ["write", "removing a machine from the account, through the `machine` alias", ["machine", "remove", "key"]],
    ["write", "a command nobody has enabled for ADE MCP", ["not-a-real-command", "run"]],
    ["write", "signing the machine in to GitHub", ["github", "app-auth", "login"]],
    ["write", "clearing GitHub sign-in through the `gh` alias", ["gh", "app", "clear"]],
    ["write", "a GitHub sign-in through actions", ["actions", "run", "github.startAppUserDeviceAuth"]],
    ["write", "a Linear credential through actions, split spelling", ["actions", "run", "linear_credentials", "setToken"]],
    ["write", "disconnecting Jira", ["jira", "disconnect"]],
    ["write", "installing the ADE agent in Linear through actions", ["actions", "run", "linear_agent.startInstall"]],
    ["write", "an AI provider sign-in through actions", ["actions", "run", "ai", "cursorAuthLogin"]],
    ["write", "signing OpenCode out", ["providers", "opencode", "accounts", "rm", "acct"]],
    ["read", "creating a lane", ["lanes", "create", "--name", "x"]],
    ["read", "a flag before the subcommand", ["lanes", "--text", "create"]],
    ["read", "a write action through actions", ["actions", "run", "lane", "create"]],
    ["read", "a secret-returning read action", ["actions", "run", "account.getToken"]],
    ["read", "rebuilding the search index", ["search", "--rebuild"]],
    ["read", "an action named after an Object prototype member", ["actions", "run", "constructor.x"]],
    ["read", "another machine", ["lanes", "list", "--all-machines"]],
    ["read", "`--help` swallowed as a flag's value", ["chat", "send", "x", "--project-root", "--help"]],
    ["read", "arming a chat wait", ["chat", "wait", "x", "--async"]],
    ["read", "cancelling a chat wait", ["chat", "wait", "--cancel", "w1"]],
    ["write", "a stdin-reading command without stdin", ["files", "write", "--workspace", "l", "a.txt", "--stdin"]],
    ["write", "a body read from stdin without stdin", ["prs", "create", "--body-file", "-"]],
  ] as const)("%s access refuses %s", (scope, _label, args) => {
    const verdict = checkRemoteAdeCommand([...args], scope);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).not.toBe("");
    expect(verdict).not.toHaveProperty("args");
  });

  it.each([
    ["read", ["lanes", "list", "--text"], ["lanes", "list", "--text"]],
    ["read", ["ade", "git", "status", "--lane", "x"], ["git", "status", "--lane", "x"]],
    ["read", ["actions", "run", "lane", "list"], ["actions", "run", "lane", "list"]],
    ["read", ["search", "login bug", "--text"], ["search", "login bug", "--text"]],
    ["read", ["github", "app-auth", "status"], ["github", "app-auth", "status"]],
    ["read", ["lanes", "create", "--help"], ["lanes", "create", "--help"]],
    ["read", ["chat", "wait", "x", "--for", "idle"], ["chat", "wait", "x", "--for", "idle"]],
    ["read", ["skills", "list"], ["skills", "list"]],
    ["read", ["settings", "find", "providers"], ["settings", "find", "providers"]],
    ["write", ["lanes", "create", "--name", "fix-login"], ["lanes", "create", "--name", "fix-login"]],
    ["write", ["action", "run", "lane.create", "--arg", "name=x"], ["action", "run", "lane.create", "--arg", "name=x"]],
  ] as const)("%s access runs %j", (scope, input, expected) => {
    const verdict = checkRemoteAdeCommand([...input], scope);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok ? verdict.args : []).toEqual(expected);
    expect(verdict.ok ? verdict.args[0] : "").not.toBe("ade");
  });

  // Full access fails closed, so a new command is unreachable until someone
  // decides whether ADE MCP may run it. This catches the deciding being skipped.
  it.each([...new Set(Object.keys(HELP_BY_COMMAND).map((key) => key.split(" ")[0]!))])(
    "`ade %s` is classified for ADE MCP",
    (command) => {
      const verdict = checkRemoteAdeCommand([command, "--help"], "write");
      expect(verdict.ok ? "" : verdict.reason).not.toMatch(/isn't enabled for ADE MCP/);
    },
  );
});
