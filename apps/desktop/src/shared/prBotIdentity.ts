/**
 * Who wrote a PR comment, review, or thread: a person, an agent reviewer, or
 * another bot. One rule for desktop, the TUI, and (ported) iOS.
 *
 * GitHub says an account is a bot two ways: REST `user.type === "Bot"` (login
 * ends in `[bot]`) and GraphQL `__typename === "Bot"` (login has NO suffix —
 * `coderabbitai`, `devin-ai-integration`, `cursor`). A login-suffix rule alone
 * misses every GraphQL bot, so callers pass the account flag when they have it,
 * and the known-login table below catches agents on old snapshots without it.
 */

export type PrBotRole =
  /** Reviews code and leaves findings (CodeRabbit, Devin, Cursor Bugbot, …). */
  | "agent-reviewer"
  /** Posts deploy previews (Vercel, Netlify, Cloudflare Pages, …). */
  | "deploy"
  /** Opens or updates dependency PRs (Dependabot, Renovate). */
  | "dependency"
  /** CI, coverage, quality, and security reporters. */
  | "ci"
  /** Any other app or bot. */
  | "bot";

export type PrAuthorIdentity = {
  login: string;
  /** Login with any `[bot]` suffix removed, lowercased. */
  normalizedLogin: string;
  isBot: boolean;
  /** Stable key for icon and color lookup, or null for a person / unknown bot. */
  kind: string | null;
  /** Product name to show instead of the raw login ("CodeRabbit"). */
  displayName: string;
  role: PrBotRole | "human";
  /** Brand color for the monogram fallback, or null. */
  brandColor: string | null;
};

type KnownBot = {
  kind: string;
  displayName: string;
  role: PrBotRole;
  brandColor: string;
  logins: readonly string[];
};

/**
 * Normalized logins (no `[bot]`, lowercase). Add a login here when a new agent
 * shows up; an unknown bot still classifies as a bot from the account flag.
 */
const KNOWN_BOTS: readonly KnownBot[] = [
  // Agent reviewers
  { kind: "coderabbit", displayName: "CodeRabbit", role: "agent-reviewer", brandColor: "#FF570A", logins: ["coderabbitai", "coderabbit"] },
  { kind: "devin", displayName: "Devin", role: "agent-reviewer", brandColor: "#3B82F6", logins: ["devin-ai-integration", "devin-ai", "devin"] },
  { kind: "cursor", displayName: "Cursor", role: "agent-reviewer", brandColor: "#E6E6E6", logins: ["cursor", "cursor-com", "cursoragent", "cursor-bugbot", "bugbot"] },
  { kind: "greptile", displayName: "Greptile", role: "agent-reviewer", brandColor: "#22C55E", logins: ["greptile-apps", "greptileai", "greptile"] },
  { kind: "seer", displayName: "Seer", role: "agent-reviewer", brandColor: "#A78BFA", logins: ["seer-by-sentry"] },
  { kind: "copilot", displayName: "Copilot", role: "agent-reviewer", brandColor: "#8B5CF6", logins: ["copilot-pull-request-reviewer", "copilot", "copilot-swe-agent", "github-copilot"] },
  { kind: "codex", displayName: "Codex", role: "agent-reviewer", brandColor: "#10A37F", logins: ["chatgpt-codex-connector", "codex", "openai-codex"] },
  { kind: "claude", displayName: "Claude", role: "agent-reviewer", brandColor: "#D97757", logins: ["claude", "claude-code", "anthropic-claude", "claude-bot"] },
  { kind: "gemini", displayName: "Gemini", role: "agent-reviewer", brandColor: "#4285F4", logins: ["gemini-code-assist", "gemini-cli", "google-gemini"] },
  { kind: "jules", displayName: "Jules", role: "agent-reviewer", brandColor: "#7C4DFF", logins: ["google-labs-jules", "jules"] },
  { kind: "amazonq", displayName: "Amazon Q", role: "agent-reviewer", brandColor: "#FF9900", logins: ["amazon-q-developer", "amazon-q"] },
  { kind: "windsurf", displayName: "Windsurf", role: "agent-reviewer", brandColor: "#0B9A8A", logins: ["windsurf-bot", "windsurf", "codeium"] },
  { kind: "sourcery", displayName: "Sourcery", role: "agent-reviewer", brandColor: "#F5A623", logins: ["sourcery-ai", "sourcery-ai-experiments"] },
  { kind: "qodo", displayName: "Qodo", role: "agent-reviewer", brandColor: "#7B61FF", logins: ["qodo-merge-pro", "qodo-merge", "qodo-ai", "codiumai-pr-agent-pro", "codiumai-pr-agent"] },
  { kind: "ellipsis", displayName: "Ellipsis", role: "agent-reviewer", brandColor: "#6366F1", logins: ["ellipsis-dev"] },
  { kind: "graphite", displayName: "Graphite", role: "agent-reviewer", brandColor: "#A3A3A3", logins: ["graphite-app", "graphite-reviewer"] },
  { kind: "sweep", displayName: "Sweep", role: "agent-reviewer", brandColor: "#5B8DEF", logins: ["sweep-ai", "sweep-ai-dev"] },
  { kind: "korbit", displayName: "Korbit", role: "agent-reviewer", brandColor: "#14B8A6", logins: ["korbit-ai"] },
  { kind: "bito", displayName: "Bito", role: "agent-reviewer", brandColor: "#2563EB", logins: ["bito-code-review", "bito"] },
  { kind: "cubic", displayName: "cubic", role: "agent-reviewer", brandColor: "#A855F7", logins: ["cubic-dev-ai"] },
  { kind: "baz", displayName: "Baz", role: "agent-reviewer", brandColor: "#F43F5E", logins: ["baz-reviewer", "baz-scm"] },
  { kind: "entelligence", displayName: "Entelligence", role: "agent-reviewer", brandColor: "#0EA5E9", logins: ["entelligence-ai-pr-reviews"] },
  { kind: "augment", displayName: "Augment", role: "agent-reviewer", brandColor: "#22D3EE", logins: ["augmentcode", "augment-code"] },
  { kind: "whatthediff", displayName: "What The Diff", role: "agent-reviewer", brandColor: "#F97316", logins: ["what-the-diff"] },
  { kind: "opencode", displayName: "OpenCode", role: "agent-reviewer", brandColor: "#E5E5E5", logins: ["opencode-agent", "opencode"] },
  { kind: "ade", displayName: "ADE", role: "agent-reviewer", brandColor: "#A78BFA", logins: ["ade-dev", "ade-agent", "ade-bot"] },
  // Deploy previews
  { kind: "vercel", displayName: "Vercel", role: "deploy", brandColor: "#EDEDED", logins: ["vercel"] },
  { kind: "netlify", displayName: "Netlify", role: "deploy", brandColor: "#32E6E2", logins: ["netlify"] },
  { kind: "cloudflare", displayName: "Cloudflare", role: "deploy", brandColor: "#F38020", logins: ["cloudflare-workers-and-pages", "cloudflare-pages", "cloudflare"] },
  { kind: "railway", displayName: "Railway", role: "deploy", brandColor: "#C4B5FD", logins: ["railway-app"] },
  { kind: "render", displayName: "Render", role: "deploy", brandColor: "#8B5CF6", logins: ["render"] },
  { kind: "supabase", displayName: "Supabase", role: "deploy", brandColor: "#3ECF8E", logins: ["supabase"] },
  { kind: "mintlify", displayName: "Mintlify", role: "deploy", brandColor: "#0D9373", logins: ["mintlify"] },
  { kind: "expo", displayName: "Expo", role: "deploy", brandColor: "#E5E5E5", logins: ["expo-github-app"] },
  // Dependencies
  { kind: "dependabot", displayName: "Dependabot", role: "dependency", brandColor: "#025E8C", logins: ["dependabot", "dependabot-preview"] },
  { kind: "renovate", displayName: "Renovate", role: "dependency", brandColor: "#1A8CFF", logins: ["renovate", "renovate-bot"] },
  // CI, coverage, quality, security
  { kind: "github-actions", displayName: "GitHub Actions", role: "ci", brandColor: "#2088FF", logins: ["github-actions"] },
  { kind: "codecov", displayName: "Codecov", role: "ci", brandColor: "#F01F7A", logins: ["codecov", "codecov-commenter"] },
  { kind: "sonar", displayName: "SonarQube Cloud", role: "ci", brandColor: "#F3702A", logins: ["sonarcloud", "sonarqubecloud"] },
  { kind: "deepsource", displayName: "DeepSource", role: "ci", brandColor: "#34D399", logins: ["deepsource-io", "deepsource-autofix"] },
  { kind: "snyk", displayName: "Snyk", role: "ci", brandColor: "#4C4A73", logins: ["snyk-bot", "snyk-io"] },
  { kind: "socket", displayName: "Socket", role: "ci", brandColor: "#C084FC", logins: ["socket-security"] },
  { kind: "sentry", displayName: "Sentry", role: "ci", brandColor: "#A78BFA", logins: ["sentry", "sentry-io"] },
  { kind: "changesets", displayName: "Changesets", role: "ci", brandColor: "#FACC15", logins: ["changeset-bot"] },
  { kind: "mergify", displayName: "Mergify", role: "ci", brandColor: "#1CB893", logins: ["mergify"] },
  { kind: "kodiak", displayName: "Kodiak", role: "ci", brandColor: "#94A3B8", logins: ["kodiakhq"] },
  // Other apps
  { kind: "linear", displayName: "Linear", role: "bot", brandColor: "#5E6AD2", logins: ["linear", "linear-app"] },
];

const KNOWN_BOT_BY_LOGIN: ReadonlyMap<string, KnownBot> = new Map(
  KNOWN_BOTS.flatMap((bot) => bot.logins.map((login) => [login, bot] as const)),
);

export function normalizeGithubLogin(login: string | null | undefined): string {
  return (login ?? "").trim().toLowerCase().replace(/\[bot\]$/, "");
}

function looksLikeBotLogin(login: string): boolean {
  const lower = login.trim().toLowerCase();
  return lower.endsWith("[bot]") || lower.endsWith("-bot") || lower === "github-actions";
}

/**
 * A person can own `cursor`, `claude`, or `linear`, so a short table login only
 * names a bot when GitHub also says so (account flag or `[bot]`). A distinctive
 * login — hyphenated, or an `…ai` app slug like `coderabbitai` — is safe alone,
 * which is what keeps old snapshots without the flag classified.
 */
function isDistinctiveBotLogin(normalizedLogin: string): boolean {
  return normalizedLogin.includes("-") || normalizedLogin.endsWith("ai");
}

/**
 * Classify one author. `accountIsBot` is the GitHub account flag when the
 * caller has it; the known-login table and the `[bot]` suffix are fallbacks.
 */
export function classifyPrAuthor(
  login: string | null | undefined,
  accountIsBot?: boolean | null,
): PrAuthorIdentity {
  const raw = (login ?? "").trim();
  const normalizedLogin = normalizeGithubLogin(raw);
  const known = KNOWN_BOT_BY_LOGIN.get(normalizedLogin) ?? null;
  const githubSaysBot = Boolean(accountIsBot) || looksLikeBotLogin(raw);
  const isBot = githubSaysBot || (known !== null && isDistinctiveBotLogin(normalizedLogin));
  if (known && isBot) {
    return {
      login: raw,
      normalizedLogin,
      isBot: true,
      kind: known.kind,
      displayName: known.displayName,
      role: known.role,
      brandColor: known.brandColor,
    };
  }
  return {
    login: raw,
    normalizedLogin,
    isBot,
    kind: null,
    displayName: isBot ? normalizedLogin || raw : raw,
    role: isBot ? "bot" : "human",
    brandColor: null,
  };
}

export function isPrBotAuthor(login: string | null | undefined, accountIsBot?: boolean | null): boolean {
  return classifyPrAuthor(login, accountIsBot).isBot;
}

/** Every kind the table knows, for icon-map coverage tests. */
export function knownPrBotKinds(): string[] {
  return KNOWN_BOTS.map((bot) => bot.kind);
}
