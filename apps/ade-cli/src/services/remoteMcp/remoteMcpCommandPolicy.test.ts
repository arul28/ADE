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
    ["write", "connecting an integration through the connect card", ["integrations", "connect", "linear", "--reason", "x"]],
    ["write", "adding an MCP server through actions", ["actions", "run", "mcp_registry.request"]],
    ["write", "installing the ADE agent in Linear through actions", ["actions", "run", "linear_agent.startInstall"]],
    ["write", "an AI provider sign-in through actions", ["actions", "run", "ai", "cursorAuthLogin"]],
    ["write", "signing OpenCode out", ["providers", "opencode", "accounts", "rm", "acct"]],
    ["write", "installing the Android SDK", ["android", "sdk", "install", "--folder", "/x"]],
    ["write", "the Android SDK folder behind a flag and its value", ["android", "sdk", "--folder", "/x", "use"]],
    ["write", "restarting the computer's adb server", ["android", "start", "--restart-adb"]],
    ["write", "restarting adb through actions", ["actions", "run", "android_emulator.start", "--input-json", '{"laneId":"l","restartAdb":true}']],
    ["write", "restarting adb through an actions --arg", ["actions", "run", "android_emulator.start", "--arg", "laneId=l", "--arg", "restartAdb=true"]],
    ["write", "restarting adb through an escaped JSON key", ["actions", "run", "android_emulator", "start", "--input-json", '{"\\u0072estartAdb":true}']],
    ["write", "restarting adb through an escaped key after --input-json=", ["actions", "run", "android_emulator.start", '--input-json={"\\u0072estartAdb":true}']],
    ["write", "restarting adb through an escaped key in an --args-list-json array", ["actions", "run", "android_emulator.start", "--args-list-json", '[{"\\u0072estartAdb":true}]']],
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
    ["read", "reading an env file", ["files", "read", "--workspace", "l", "app/.env.local"]],
    ["read", "reading an env file named in --path=", ["files", "read", "--workspace", "l", "--path=.env"]],
    ["read", "reading a file through actions run", ["actions", "run", "file.readFile", "--set", "path=.env"]],
    ["read", "searching git-ignored files (where .env lives)", ["files", "search", "--workspace", "l", "--query", "KEY", "--include-ignored"]],
    ["read", "turning a billed ADE Cloud ready machine on", ["cloud", "ready", "on", "--kind", "vm"]],
    ["read", "turning the ready machine off (deletes it)", ["cloud", "ready", "--json", "off"]],
    ["read", "retrying a ready prepare", ["cloud", "ready", "retry"]],
    ["read", "making an ADE Cloud machine", ["cloud", "create", "--kind", "box"]],
    ["write", "stopping a computer's work", ["cloud", "prepare-stop"]],
    ["write", "pushing a computer's lanes", ["cloud", "push-work"]],
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
    ["read", ["integrations", "status", "--text"], ["integrations", "status", "--text"]],
    ["read", ["settings", "find", "providers"], ["settings", "find", "providers"]],
    ["read", ["cloud", "ready"], ["cloud", "ready"]],
    ["read", ["cloud", "ready", "status", "--text"], ["cloud", "ready", "status", "--text"]],
    ["read", ["cloud", "hours", "--text"], ["cloud", "hours", "--text"]],
    ["write", ["lanes", "create", "--name", "fix-login"], ["lanes", "create", "--name", "fix-login"]],
    ["write", ["android", "sdk", "status"], ["android", "sdk", "status"]],
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
