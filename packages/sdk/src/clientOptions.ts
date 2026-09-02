/**
 * The public option surface of `createAdeChat` and `threads.open`.
 *
 * Types only, and mostly documentation: the MCP per-provider table, the three
 * permission forms, the `cwd` refusals and the resume rule are each a paragraph
 * an embedder has to read before shipping, and they are the part of this
 * package most likely to be edited. Kept apart from `client.ts` so the
 * implementation stays readable and so a doc change never touches the file that
 * owns the runtime's lifecycle.
 */

import type { ThreadInstructions } from "./hostConfig.js";
import type { PermissionPreset, ThreadPermissionPolicy } from "./permissions.js";
import type { RuntimeDownloader } from "./download.js";
import type { AdeProvider, AgentChatSettingSources, McpServerConfig } from "./types.js";
import type { AdeThread } from "./thread.js";

export type CreateAdeChatOptions = {
  /** Isolated per-app ADE state root. Created if missing. */
  home: string;
  /** Pin a specific `ade` build. Skips PATH discovery and the downloader. */
  binaryPath?: string;
  /**
   * Where the native modules the runtime dlopens live. Maps to
   * `ADE_RUNTIME_NODE_MODULES`. Required alongside `binaryPath` when the
   * modules are not beside the binary, which is the normal case for an app
   * bundle: the binary lands in `Contents/Resources/ade-runtime/bin` and the
   * modules in `Contents/Resources/ade-runtime/native/node_modules`.
   */
  runtimeNodeModules?: string;
  /** Maps to `ADE_RUNTIME_ROOT`. Defaults to the parent of `runtimeNodeModules`. */
  runtimeRoot?: string;
  /**
   * Never reach the network. Throws `runtime_unavailable` instead of
   * downloading. Defaults to true, which preserves 0.1.x behavior.
   *
   * A shipping app wants false: a packaging mistake then fails loudly in QA,
   * rather than working on the developer's machine through a silent download
   * and failing on a locked-down user's.
   */
  allowDownload?: boolean;
  /** Release channel for the downloader: `latest` (default) or a tag. */
  channel?: string;
  logger?: (line: string) => void;
  /**
   * Default instructions for every thread this client opens.
   *
   * A per-thread `instructions` wins outright — it is not merged with this one,
   * because two texts silently concatenated is nobody's intent. Use this for
   * the persona your whole app shares and the per-thread field for a narrower
   * one.
   */
  instructions?: ThreadInstructions;
};

/** Escape hatches for tests and embedders. Not part of the stable surface. */
export type InternalAdeChatOptions = CreateAdeChatOptions & {
  /** Override the endpoint (a mock server's temp socket, for instance). */
  socketPath?: string;
  /** Attach to an already-running runtime instead of spawning one. */
  attach?: boolean;
  download?: RuntimeDownloader;
  releaseRepo?: string;
  allowPathDiscovery?: boolean;
  /** Anchor for the `@ade-dev/runtime-*` lookup. Tests and vendored trees only. */
  resolveBundledFrom?: string;
  clientName?: string;
  /** Override the least-privilege role. Escape hatch; not for normal use. */
  adeDefaultRole?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Interval for `providers.onChange` re-derivation while listeners exist. */
  providerPollIntervalMs?: number;
};

export type ThreadOpenOptions = {
  provider: AdeProvider;
  model: string;
  /**
   * MCP servers to attach to this thread.
   *
   * Refused outright by providers with no MCP surface (Pi), so a thread never
   * opens silently tool-less. Read {@link AdeThread.mcpCapability} afterwards
   * for what the provider actually delivered.
   *
   * Supplying servers also turns on strict mode unless you set
   * `loadUserMcpServers: true` — see that field.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the tool
   * surface it was created with, and the SDK logs one line when the map passed
   * here differs. See {@link ThreadResumeOptions}.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Whether to also load the user's and project's own MCP configuration.
   *
   * Applies when you supply `mcpServers` or set this flag explicitly: either
   * makes the SDK send `strictMcpConfig` — `true` to withhold the user's
   * config, and an explicit `false` (not an omission) when you set this flag
   * true, because omitting the key is not the same as asking for the user's
   * servers.
   *
   * A thread that does neither sends no MCP field at all and lets the runtime's
   * session profile decide. The profile SDK threads run is strict by default,
   * so "sent nothing" means the user's own MCP config is withheld — pass
   * `loadUserMcpServers: true` if you want it loaded.
   *
   * IMPORTANT — false is NOT a uniform guarantee. Only Claude can enforce it.
   * Every other provider is best-effort because the gap is in the provider's
   * own SDK, not in ADE:
   *
   * | provider | strict mode | what still loads anyway                        |
   * |----------|-------------|------------------------------------------------|
   * | claude   | enforced    | nothing (MCP-wise)                             |
   * | codex    | best-effort | servers contributed by a Codex *plugin*        |
   * | cursor   | best-effort | user-layer servers                             |
   * | droid    | best-effort | tools appearing only after the first sweep     |
   * | opencode | best-effort | the global OpenCode config dir (for auth)      |
   * | pi       | unsupported | n/a — no MCP surface at all                    |
   *
   * That table is a summary of ADE's own `CALLER_MCP_SUPPORT` table in
   * `apps/desktop/src/shared/callerMcpServers.ts`, which is where each level,
   * mechanism and residual is decided; this doc comment restates it and must be
   * updated when a row there changes.
   *
   * Note that even for Claude, "enforced" scopes to MCP only: the user's
   * rules, commands, and output styles still load, because those are not MCP
   * and are not what strict mode excludes.
   *
   * Do not present this to your users as "only your tools are loaded" without
   * checking {@link AdeThread.mcpCapability}: it names the exact residual for
   * the thread you actually got, and it is authoritative where this table is
   * only a summary.
   *
   * The table above applies only when this is false. Setting it TRUE (or
   * supplying servers and opting back in) is a delivery-only request: the
   * user's own MCP config loads by design, the report comes back with
   * `strictRequested: false`, `residual` is null, and `mechanism` describes how
   * the servers were delivered rather than any enforcement. Nothing in that
   * report claims isolation, because none was asked for.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the value it
   * was created with, and the SDK logs one line when the value passed here
   * differs. See {@link ThreadResumeOptions}.
   */
  loadUserMcpServers?: boolean;
  /**
   * How tool use is gated on this thread. Three accepted forms.
   *
   * `"default"` leaves each provider's own behavior in place, and what that
   * means differs enough per provider to be worth stating: on Claude, ADE
   * installs no gate at all and the Agent SDK decides non-interactively; on
   * Codex, an approval request PARKS THE TURN until something answers it.
   *
   * `"always-allow"` maps to each provider's full-auto create args —
   * `bypassPermissions` on Claude, `danger-full-access` on Codex.
   *
   * A {@link ThreadPermissionPolicy} object is the third form, and the only one
   * that is neither of those extremes: name the tools that may run, the tools
   * that may not, and what happens to everything else. `fallback: "deny"`
   * guarantees a turn never parks, which is what a host with no approval UI
   * wants. `fallback: "ask"` emits `approval_request` and needs
   * {@link AdeThread.approve} wired to a card.
   *
   * Read {@link AdeThread.permissionCapability} afterwards: only Claude gates
   * every tool call against the policy.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the value it
   * was created with, and the SDK logs one line when the value passed here
   * differs. See {@link ThreadResumeOptions}.
   */
  permissions?: PermissionPreset | ThreadPermissionPolicy;
  /**
   * Host instructions for this thread.
   *
   * A bare string is shorthand for `{ mode: "append", text }`, which keeps
   * ADE's own personal-chat framing and adds yours after it. `"replace"` uses
   * your text alone — for a chat branded as your assistant, which must not
   * mention ADE.
   *
   * This does NOT put the text in the transcript: `exportThread` returns no
   * user message carrying it, which is the whole difference from the
   * hidden-first-message workaround it replaces. Falls back to the client-level
   * `instructions` when omitted; check {@link AdeThread.instructionsCapability}
   * for what the provider did with it.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the value it
   * was created with, and the SDK logs one line when the value passed here
   * differs. See {@link ThreadResumeOptions}.
   */
  instructions?: ThreadInstructions;
  /**
   * Absolute directory the provider runs in.
   *
   * Created recursively (mode 0755) when missing. Defaults to the runtime's own
   * scratch workspace at `<home>/personal-chats/workspaces`, and omitting it
   * keeps exactly that behavior.
   *
   * Refused, with `invalid_option`: a relative path (it would resolve against
   * the runtime's working directory, not yours), a path starting with `~` (not
   * expanded), a filesystem root, the user's home directory itself, and
   * anything inside the SDK's own `home`.
   *
   * This is a working directory, NOT a sandbox. For containment use
   * `permissions.sandboxRoot`; the two are separate fields precisely so setting
   * one does not read as implying the other.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the value it
   * was created with, and the SDK logs one line when the value passed here
   * differs. See {@link ThreadResumeOptions}.
   */
  cwd?: string;
  /**
   * Which on-disk configuration layers the provider loads.
   *
   * Defaults to `"none"`, which is what every 0.1.x thread got: no filesystem
   * settings. `"project"` loads files in `cwd` (a `CLAUDE.md` your app ships);
   * `"user"` loads the machine user's own global config; `"all"` loads user,
   * project and local.
   *
   * `"project"` is usually the right choice for an embedder. Loading a user's
   * personal `~/.claude` into an app-branded assistant is a surprise, and it
   * should take an explicit `"user"` or `"all"` to get it. Only Claude has a
   * real switch — see {@link AdeThread.settingSourcesCapability}.
   *
   * IGNORED ON RESUME: a key this home already knows re-applies the value it
   * was created with, and the SDK logs one line when the value passed here
   * differs. See {@link ThreadResumeOptions}.
   */
  settingSources?: AgentChatSettingSources;
  reasoningEffort?: string;
  title?: string;
};

/**
 * Options for reopening a key this home already knows.
 *
 * `provider` and `model` become optional because a durable thread already
 * recorded them — but they are still used if the runtime lost the session and
 * the thread has to be recreated, so a caller that has them should pass them.
 *
 * A RESUME RE-APPLIES THE STORED VALUES. `cwd`, `instructions`,
 * `settingSources`, `permissions`, `mcpServers` and `loadUserMcpServers` are
 * read off the durable record, not off this object: one key is one
 * conversation, and moving a live agent to a new directory, a new policy or a
 * new tool surface on reopen is not what "reopen" means. Passing a value that
 * differs from the stored one is not an error and does not change the thread;
 * the SDK logs one line naming the option it ignored. To run under different
 * host configuration, open a different key.
 *
 * The exception is a recreate: when the runtime has lost the session entirely,
 * the thread is created afresh and these options DO win over the record.
 */
export type ThreadResumeOptions = Partial<ThreadOpenOptions>;
