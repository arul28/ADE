import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  GithubLogo,
  GlobeHemisphereWest,
  Key,
  LockSimple,
} from "@phosphor-icons/react";
import type { PublishProjectResult } from "../../../shared/types";
import { extractCodeFromMessage, parseCodedErrorMessage } from "../../lib/codedError";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { extractError } from "../../lib/format";
import { describeGithubPatVerification } from "../../lib/githubIntegrationStatus";
import { GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY } from "../../../shared/types";
import { GITHUB_OWNER_NOT_FOUND_CODE } from "../../../shared/githubApiPath";
import { Dialog, type DialogAction } from "../ui/dialog";
import { Banner, noticeKindModel, type NoticeKind } from "../ui/notice";
import "./PublishToGitHubDialog.css";
import { useOnlineCopyPins } from "../../state/repositoryScope";

const GITHUB_CLASSIC_TOKEN_NEW_URL =
  "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";

export type PublishToGitHubDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRepoName: string;
  onPublished: () => void;
};

type PublishError = { code: string; message: string };
type TokenError = { message: string; kind: NoticeKind };

type NameValidation = { ok: true } | { ok: false; reason: string };
type OwnerValidation = { ok: true } | { ok: false; reason: string };

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function validateRepoName(rawName: string): NameValidation {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, reason: "Enter a repository name" };
  if (name.length > 100) return { ok: false, reason: "Name must be 100 characters or fewer" };
  if (name.startsWith(".")) return { ok: false, reason: "Name cannot start with a dot" };
  if (name.includes("..")) return { ok: false, reason: "Name cannot contain '..'" };
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, reason: "Use letters, numbers, '-', '_' or '.'" };
  }
  return { ok: true };
}

function validateOwner(rawOwner: string): OwnerValidation {
  const owner = rawOwner.trim();
  if (owner.length === 0) return { ok: true };
  if (owner.length > 39) return { ok: false, reason: "Owner must be 39 characters or fewer" };
  if (!OWNER_PATTERN.test(owner)) {
    return { ok: false, reason: "Use a GitHub user or organization name" };
  }
  return { ok: true };
}

function detectTokenType(token: string): "classic" | "fine-grained" | "unknown" {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

const TOKEN_TYPE_LABEL: Record<ReturnType<typeof detectTokenType>, string> = {
  classic: "Classic token",
  "fine-grained": "Fine-grained token",
  unknown: "Unknown format",
};

/**
 * Answers about the project or the chosen name, not failures: the project
 * already has a remote, or the name is taken. A warning with nothing to report.
 */
const PUBLISH_STATE_CODES = new Set([
  "remote_already_exists",
  "repo_name_taken",
  GITHUB_OWNER_NOT_FOUND_CODE,
]);

/**
 * The login a publish runs as: the write credential's, which the service
 * compares the owner against, falling back to the read login for runtimes that
 * predate `writeUserLogin`.
 */
function publishLogin(status: { connected: boolean; userLogin: string | null; writeUserLogin?: string | null }): string | null {
  if (!status.connected) return null;
  return status.writeUserLogin || status.userLogin || null;
}

const VISIBILITY = [
  { value: true, label: "Private", detail: "Only you and people you invite", icon: LockSimple },
  { value: false, label: "Public", detail: "Anyone on the internet can see it", icon: GlobeHemisphereWest },
] as const;

/** GitHub's avatar for a login, or the GitHub mark while the owner is blank or not a login yet. */
function OwnerAvatar({ login, size = 20 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [login]);
  if (!login || failed || !OWNER_PATTERN.test(login)) {
    return (
      <span className="ade-gh-publish-avatar" data-fallback="true" style={{ width: size, height: size }}>
        <GithubLogo size={Math.round(size * 0.7)} weight="fill" />
      </span>
    );
  }
  return (
    <img
      className="ade-gh-publish-avatar"
      src={`https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=${size * 2}`}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  );
}

export function PublishToGitHubDialog({
  open,
  onOpenChange,
  defaultRepoName,
  onPublished,
}: PublishToGitHubDialogProps) {
  // Publish is offered for a project with no GitHub remote, which has one
  // copy: the tab's. Every call goes to that copy's machine.
  const pin = useOnlineCopyPins(open)[0] ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(defaultRepoName);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PublishError | null>(null);
  const [success, setSuccess] = useState<PublishProjectResult | null>(null);
  // What the form asked for, shown when an older runtime doesn't report the repo's own visibility.
  const [publishedPrivate, setPublishedPrivate] = useState(true);

  const [connectMode, setConnectMode] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState<TokenError | null>(null);
  const [storeUnreadable, setStoreUnreadable] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const ownerRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);

  // Reset all local state whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOwner("");
    setName(defaultRepoName);
    setDescription("");
    setIsPrivate(true);
    setPending(false);
    setError(null);
    setSuccess(null);
    setConnectMode(false);
    setTokenDraft("");
    setTokenSaving(false);
    setTokenError(null);
    setStoreUnreadable(false);
    if (!pinRef.current) return undefined;
    void window.ade.github.getStatus({ forceRefresh: false }, pinRef.current).then((status) => {
      if (cancelled) return;
      const login = publishLogin(status);
      // The status read can land after the user has typed an owner; keep theirs.
      if (login) setOwner((current) => (current.trim() ? current : login));
      // "Not connected" would be a guess here: an unreadable store reports no
      // credential whether or not one is saved.
      setStoreUnreadable(status.credentialStoreUnreadable === true);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, defaultRepoName, pin?.key]);

  const ownerValidation = useMemo(() => validateOwner(owner), [owner]);
  const validation = useMemo(() => validateRepoName(name), [name]);
  const trimmedOwner = owner.trim();
  const trimmedName = name.trim();
  const canSubmit = ownerValidation.ok && validation.ok && !pending && pin != null;

  const handleSubmit = useCallback(async () => {
    if (!ownerValidation.ok || !validation.ok || pending || !pin) return;
    setPending(true);
    setError(null);
    try {
      const result = await window.ade.github.publishCurrentProject({
        ...(trimmedOwner ? { owner: trimmedOwner } : {}),
        name: trimmedName,
        description: description.trim() || undefined,
        isPrivate,
      }, pin);
      setPublishedPrivate(isPrivate);
      setSuccess(result);
    } catch (err) {
      const code = extractCodeFromMessage(err);
      if (code === "github_not_connected") {
        // Re-read before offering a fix. "Not connected" is also what an
        // unreadable store looks like, and the answer to that one is repair,
        // not a replacement token.
        const status = await window.ade.github
          .getStatus({ forceRefresh: true }, pin)
          .catch(() => null);
        if (status) setStoreUnreadable(status.credentialStoreUnreadable === true);
        setConnectMode(true);
      } else if (code === "remote_already_exists") {
        setError({
          code,
          message: "This project already has a GitHub remote.",
        });
      } else {
        setError({
          code: code ?? "unknown",
          // Without the transport wrapper and the `code:` prefix the action adds.
          message: parseCodedErrorMessage(err).message || extractError(err),
        });
      }
    } finally {
      setPending(false);
    }
  }, [description, isPrivate, ownerValidation.ok, pending, pin, trimmedName, trimmedOwner, validation.ok]);

  const handleSaveToken = useCallback(async () => {
    const token = tokenDraft.trim();
    if (!token) {
      setTokenError({ message: "Paste a personal access token first.", kind: "hint" });
      return;
    }
    setTokenSaving(true);
    setTokenError(null);
    try {
      const result = await window.ade.github.setToken(token, pin);
      const verification = describeGithubPatVerification(result);
      if (!verification.verified) {
        setTokenError({ message: verification.message, kind: "hint" });
        return;
      }
      setTokenDraft("");
      setConnectMode(false);
      void window.ade.github.getStatus({ forceRefresh: true }, pin).then((status) => {
        const login = publishLogin(status);
        if (login) setOwner((current) => (current.trim() ? current : login));
      }).catch(() => {});
    } catch (err) {
      setTokenError({ message: extractError(err), kind: "failure" });
    } finally {
      setTokenSaving(false);
    }
  }, [pin, tokenDraft]);

  // After a failed publish, put the cursor where the fix goes. The fields are
  // disabled while publishing, so this waits for `pending` to clear.
  useEffect(() => {
    if (!error || pending) return;
    (error.code === GITHUB_OWNER_NOT_FOUND_CODE ? ownerRef : nameRef).current?.focus();
  }, [error, pending]);

  const handleDone = useCallback(() => {
    onPublished();
    onOpenChange(false);
  }, [onOpenChange, onPublished]);

  // The repair lives in the Connections panel, which is a header popover — this
  // modal has to get out of its way first.
  const handleOpenConnections = useCallback(() => {
    onOpenChange(false);
    openConnectionsPanel("machines");
  }, [onOpenChange]);

  if (success) {
    const pushed = success.state === "pushed";
    const repoPrivate = success.isPrivate ?? publishedPrivate;
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : handleDone())}
        title="Published to GitHub"
        description={pushed ? "The repository is live and this project pushes to it." : "The repository is ready. Nothing was pushed yet."}
        icon={<CheckCircle size={16} weight="fill" />}
        tone="success"
        size="md"
        focusKey="success"
        actions={[
          { label: "Done", variant: "solid", onClick: handleDone, autoFocus: true },
          {
            label: "Open on GitHub",
            variant: "secondary",
            icon: <ArrowSquareOut size={12} />,
            onClick: () => void window.ade.app.openExternal(success.htmlUrl),
          },
        ]}
      >
        <div className="ade-gh-publish-body">
          <div className="kit-panel ade-gh-publish-repo">
            <OwnerAvatar login={success.owner} size={32} />
            <div className="ade-gh-publish-repo-text">
              <span className="ade-gh-publish-repo-name">{success.fullName || success.htmlUrl}</span>
              <span className="ade-gh-publish-repo-url">{success.htmlUrl}</span>
            </div>
            <span className="kit-tag">
              {repoPrivate ? <LockSimple size={10} weight="bold" /> : <GlobeHemisphereWest size={10} weight="bold" />}
              {repoPrivate ? "Private" : "Public"}
            </span>
          </div>
          {!pushed ? (
            <Banner
              layout="inline"
              model={{
                id: "publish-github-nothing-pushed",
                tone: "info",
                title: "No commits to push yet",
                detail: "The remote is set. Commit, then push to fill the repository.",
              }}
            />
          ) : null}
        </div>
      </Dialog>
    );
  }

  if (connectMode) {
    const notConnectedBanner = (
      <Banner
        layout="inline"
        model={{
          id: "publish-github-not-connected",
          tone: "warning",
          icon: <GithubLogo size={16} weight="fill" />,
          title: storeUnreadable ? GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.title : "GitHub isn't connected",
          detail: storeUnreadable
            ? GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.detail
            : "Run gh auth login with the repo and workflow scopes, or paste a personal access token.",
        }}
      />
    );
    const back = () => setConnectMode(false);

    // Unreadable is NOT "not connected": the saved sign-in may still be on disk,
    // just unopenable here. Saving a token over it would destroy a credential
    // that repair can recover, so this state offers only the repair route.
    const actions: DialogAction[] = storeUnreadable
      ? [
          { label: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action, variant: "solid", onClick: handleOpenConnections, autoFocus: true },
          { label: "Back", variant: "secondary", onClick: back },
        ]
      : [
          {
            label: "Save token",
            variant: "solid",
            icon: <Key size={12} weight="bold" />,
            onClick: () => void handleSaveToken(),
            disabled: tokenDraft.trim().length === 0,
            busy: tokenSaving,
          },
          { label: "Back", variant: "secondary", onClick: back, disabled: tokenSaving },
        ];

    const detected = tokenDraft.trim() ? detectTokenType(tokenDraft.trim()) : null;
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Connect GitHub"
        description="Publishing needs a GitHub sign-in that can make repositories."
        icon={<GithubLogo size={16} weight="fill" />}
        size="md"
        focusKey="connect"
        initialFocusRef={storeUnreadable ? undefined : tokenRef}
        dismissible={!tokenSaving}
        actions={actions}
      >
        <div className="ade-gh-publish-body">
          {notConnectedBanner}
          {storeUnreadable ? null : (
            <form
              className="ade-gh-publish-body"
              onSubmit={(event) => {
                event.preventDefault();
                if (tokenDraft.trim() && !tokenSaving) void handleSaveToken();
              }}
            >
              <label className="ade-gh-publish-field">
                <span className="ade-gh-publish-label">
                  Personal access token
                  {detected ? <span className="kit-tag">{TOKEN_TYPE_LABEL[detected]}</span> : null}
                </span>
                <input
                  ref={tokenRef}
                  className="kit-input ade-gh-publish-input"
                  type="password"
                  value={tokenDraft}
                  placeholder="ghp_… or github_pat_…"
                  onChange={(event) => setTokenDraft(event.target.value)}
                  disabled={tokenSaving}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="kit-btn kit-btn-ghost ade-gh-publish-link"
                data-size="sm"
                onClick={() => void window.ade.app.openExternal(GITHUB_CLASSIC_TOKEN_NEW_URL)}
              >
                Make a token on GitHub
                <ArrowSquareOut size={11} />
              </button>
              {tokenError ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "publish-github-token-error",
                    ...noticeKindModel(tokenError.kind, tokenError.kind === "failure" ? { surface: "publish_github_token" } : undefined),
                    title: tokenError.message,
                  }}
                />
              ) : null}
              <button type="submit" hidden aria-hidden tabIndex={-1} />
            </form>
          )}
        </div>
      </Dialog>
    );
  }

  const ownerInvalid = !ownerValidation.ok;
  const nameInvalid = !validation.ok && name.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Publish to GitHub"
      description="Make a new repository and push this project to it."
      icon={<GithubLogo size={16} weight="fill" />}
      size="md"
      focusKey="form"
      initialFocusRef={nameRef}
      dismissible={!pending}
      actions={[
        {
          // A stable label keeps the button (keyed on it) in place; `busy` shows progress.
          label: "Publish",
          variant: "solid",
          onClick: () => void handleSubmit(),
          disabled: !canSubmit && !pending,
          busy: pending,
        },
        { label: "Cancel", variant: "secondary", onClick: () => onOpenChange(false), disabled: pending },
      ]}
    >
      <form
        className="ade-gh-publish-body"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="ade-gh-publish-field">
          <span className="ade-gh-publish-label" id="ade-gh-publish-repo-label">Repository</span>
          <div className="ade-gh-publish-path" role="group" aria-labelledby="ade-gh-publish-repo-label">
            <div className="kit-input ade-gh-publish-owner" aria-invalid={ownerInvalid}>
              <OwnerAvatar login={trimmedOwner} />
              <input
                ref={ownerRef}
                aria-label="Owner"
                aria-invalid={ownerInvalid}
                // The hint shows the name's error when only the name is wrong; not the owner's description then.
                aria-describedby={ownerInvalid || !nameInvalid ? "ade-gh-publish-repo-hint" : undefined}
                type="text"
                value={owner}
                placeholder="owner"
                onChange={(event) => setOwner(event.target.value)}
                disabled={pending}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <span className="ade-gh-publish-slash" aria-hidden>/</span>
            <input
              ref={nameRef}
              aria-label="Repository name"
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid && !ownerInvalid ? "ade-gh-publish-repo-hint" : undefined}
              className="kit-input ade-gh-publish-input"
              type="text"
              value={name}
              placeholder="my-project"
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {ownerInvalid || nameInvalid ? (
            <span className="ade-gh-publish-hint" id="ade-gh-publish-repo-hint" data-tone="crit" role="alert">
              {!ownerValidation.ok ? ownerValidation.reason : !validation.ok ? validation.reason : null}
            </span>
          ) : (
            <span className="ade-gh-publish-hint" id="ade-gh-publish-repo-hint">Your account or an organization you belong to.</span>
          )}
        </div>

        <label className="ade-gh-publish-field">
          <span className="ade-gh-publish-label">
            Description
            <span className="ade-gh-publish-optional">Optional</span>
          </span>
          <textarea
            className="kit-input ade-gh-publish-textarea"
            value={description}
            placeholder="What is this project?"
            onChange={(event) => setDescription(event.target.value)}
            disabled={pending}
            rows={2}
          />
        </label>

        <div className="ade-gh-publish-field">
          <span className="ade-gh-publish-label" id="ade-gh-publish-visibility">Visibility</span>
          <div className="ade-gh-publish-choices" role="radiogroup" aria-labelledby="ade-gh-publish-visibility">
            {VISIBILITY.map((option, index) => {
              const Icon = option.icon;
              const selected = isPrivate === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  // One Tab stop for the group; arrows move the choice, as a radio group does.
                  tabIndex={selected ? 0 : -1}
                  className="ade-gh-publish-choice"
                  onClick={() => setIsPrivate(option.value)}
                  onKeyDown={(event) => {
                    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                    const nextIndex = (index + step + VISIBILITY.length) % VISIBILITY.length;
                    const next = VISIBILITY[nextIndex];
                    if (!step || !next) return;
                    event.preventDefault();
                    setIsPrivate(next.value);
                    event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]
                      ?.focus();
                  }}
                  disabled={pending}
                >
                  <Icon size={16} weight={selected ? "fill" : "regular"} />
                  <span>
                    <b>{option.label}</b>
                    <small>{option.detail}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <Banner
            layout="inline"
            model={{
              id: "publish-github-error",
              tone: PUBLISH_STATE_CODES.has(error.code) ? "warning" : "error",
              title: error.message,
              report: PUBLISH_STATE_CODES.has(error.code) ? false : { surface: "publish_to_github", code: error.code },
            }}
          />
        ) : null}
        {/* Return in a field submits. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
