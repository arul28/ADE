import type { GithubDirectError, GithubDirectErrorKind } from "../types";

/**
 * The words for each state a direct GitHub read can end in (spec section 5,
 * L12), as data. A surface (desktop, web, iPhone) draws them with its own
 * notice pattern; nothing here renders. PROPOSED: the owner approves the
 * final copy before a surface uses it.
 *
 * Links are exact. `connect` means "start the ADE GitHub sign-in"
 * (`POST /github/app/sign-in`), not a URL.
 */

/** Same pages as `githubRelayConfig.ts` and Settings › GitHub. */
export const ADE_GITHUB_APP_INSTALL_URL = "https://github.com/apps/ade-for-github/installations/new";
export const GITHUB_INSTALLATIONS_SETTINGS_URL = "https://github.com/settings/installations";
export const GITHUB_FINE_GRAINED_TOKEN_NEW_URL = "https://github.com/settings/personal-access-tokens/new?name=ADE&description=ADE%20desktop%20PR%20workflows&contents=write&pull_requests=write&metadata=read&actions=write&checks=write&statuses=read&workflows=write";

export type GithubDirectStateAction =
  | { label: string; kind: "connect" }
  | { label: string; kind: "link"; url: string };

export type GithubDirectStateCopy = {
  title: string;
  body: string;
  primary: GithubDirectStateAction | null;
  secondary: GithubDirectStateAction | null;
};

export type GithubDirectStateContext = {
  /** The repository the read was for, when there is one. */
  owner?: string | null;
  name?: string | null;
  /** The account's GitHub login, for the "check that @x has access" line. */
  githubLogin?: string | null;
  /** Formats an epoch ms as a local time ("3:40 PM"). */
  formatTime?: (epochMs: number) => string;
  /** The read still works through another sign-in (the CLI or a token). */
  changesUseOtherSignIn?: "gh" | "token" | null;
};

const repoLabel = (ctx: GithubDirectStateContext): string =>
  ctx.owner && ctx.name ? `${ctx.owner}/${ctx.name}` : "this repository";

const ownerLabel = (ctx: GithubDirectStateContext): string => ctx.owner ?? "the repository's owner";

/** A GitHub installation page we trust: only on github.com, else the generic list. */
function installationUrl(url: string | null | undefined): string {
  if (!url) return GITHUB_INSTALLATIONS_SETTINGS_URL;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" ? parsed.toString() : GITHUB_INSTALLATIONS_SETTINGS_URL;
  } catch {
    return GITHUB_INSTALLATIONS_SETTINGS_URL;
  }
}

/**
 * The copy for an error (or for a `read_only` diagnosis, which is an
 * `app_not_installed` error with `reason: "read_only"`). Null for kinds that
 * need no notice (`not_found`, `invalid_request`).
 */
export function githubDirectStateCopy(error: GithubDirectError, ctx: GithubDirectStateContext = {}): GithubDirectStateCopy | null {
  const context: GithubDirectStateContext = { owner: error.owner ?? ctx.owner, name: error.name ?? ctx.name, ...ctx };
  const when = (epochMs: number | null | undefined): string | null =>
    epochMs != null && context.formatTime ? context.formatTime(epochMs) : null;
  const kind: GithubDirectErrorKind = error.kind;
  switch (kind) {
    case "not_connected":
      if (error.reason === "signed_out") {
        return {
          title: "Sign in to ADE",
          body: "Sign in to your ADE account to see pull requests here.",
          primary: null,
          secondary: null,
        };
      }
      return {
        title: "Connect GitHub",
        body: "Connect GitHub to see pull requests and push from any device.",
        primary: { label: "Connect GitHub", kind: "connect" },
        secondary: { label: "Or paste a token", kind: "link", url: GITHUB_FINE_GRAINED_TOKEN_NEW_URL },
      };
    case "sign_in_expired":
      return {
        title: "GitHub connection ended",
        body: "Your GitHub connection ended. Connect GitHub again to keep working with pull requests.",
        primary: { label: "Connect GitHub", kind: "connect" },
        secondary: null,
      };
    case "app_not_installed":
      if (error.reason === "read_only") {
        return {
          title: "Read only",
          body: `You can read ${repoLabel(context)}, but ADE can't change it until the ADE GitHub App is installed on ${ownerLabel(context)}.`,
          primary: { label: "Install on GitHub", kind: "link", url: ADE_GITHUB_APP_INSTALL_URL },
          secondary: null,
        };
      }
      return {
        title: "Install the ADE GitHub App",
        body: `ADE can't read ${repoLabel(context)} yet. Install the ADE GitHub App on ${ownerLabel(context)}.`,
        primary: { label: "Install on GitHub", kind: "link", url: ADE_GITHUB_APP_INSTALL_URL },
        secondary: null,
      };
    case "rights_not_accepted": {
      const until = context.changesUseOtherSignIn === "gh"
        ? "Until then, ADE uses your GitHub CLI sign-in for changes."
        : context.changesUseOtherSignIn === "token"
          ? "Until then, ADE uses your token for changes."
          : "Until then, you can read pull requests here but not change them.";
      const orgLine = error.accountType === "Organization"
        ? ` If you don't own ${ownerLabel(context)}, ask an owner to approve it.`
        : "";
      return {
        title: "Approve the ADE GitHub App's update",
        body: `The ADE GitHub App on ${ownerLabel(context)} still has its old permissions. Approve the update so ADE can push and open pull requests. ${until}${orgLine}`,
        primary: { label: "Review on GitHub", kind: "link", url: installationUrl(error.manageUrl) },
        secondary: null,
      };
    }
    case "repo_not_reachable":
      if (error.sso) {
        return {
          title: "Single sign-on needed",
          body: `Start a single sign-on session for ${ownerLabel(context)} on GitHub, then connect GitHub again.`,
          primary: context.owner
            ? { label: "Start single sign-on", kind: "link", url: `https://github.com/orgs/${encodeURIComponent(context.owner)}/sso` }
            : null,
          secondary: { label: "Connect again", kind: "connect" },
        };
      }
      return {
        title: "Repository not reachable",
        body: `ADE can't reach ${repoLabel(context)}. Add it to the ADE GitHub App's repositories${context.githubLogin ? `, or check that @${context.githubLogin} has access to it` : ", or check that your GitHub account has access to it"}.`,
        primary: { label: "Choose repositories", kind: "link", url: installationUrl(error.manageUrl) },
        secondary: null,
      };
    case "rate_limited": {
      const at = when(error.retryAt);
      return {
        title: "GitHub rate limit reached",
        body: at ? `GitHub rate limit reached. Pull requests update again at ${at}.` : "GitHub rate limit reached. Pull requests update again in a few minutes.",
        primary: null,
        secondary: null,
      };
    }
    case "github_unavailable": {
      const at = when(error.retryAt);
      return {
        title: "GitHub isn't answering",
        body: at ? `GitHub isn't answering right now. ADE tries again at ${at}.` : "GitHub isn't answering right now. ADE tries again soon.",
        primary: null,
        secondary: null,
      };
    }
    case "forbidden":
      return {
        title: "GitHub refused",
        body: `GitHub didn't let ADE read ${repoLabel(context)}.`,
        primary: null,
        secondary: null,
      };
    case "not_found":
    case "invalid_request":
      return null;
  }
}
