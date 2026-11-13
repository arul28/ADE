/**
 * The dialogs of Settings › Passwords.
 *
 * Each one is mounted only while it is open, so its fields — a password or a
 * secret value included — live no longer than the dialog itself. Closing it
 * unmounts the component and the value is gone from the renderer.
 */
import { useRef, useState } from "react";
import { Eye, EyeSlash, Key, Password, ShieldWarning } from "@phosphor-icons/react";
import type { PasswordItemSummary, PasswordsStatus } from "../../../../shared/types/passwords";
import type { OpenProjectBinding } from "../../../../shared/types";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { ipcErrorMessage } from "../../../lib/format";

/** The brain's own rule for a secret's name (`passwordService.saveSecret`). */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * What the brain will accept as a site, checked here first so a typo is a
 * field error rather than a failed save. Bare hosts are https; http is only
 * accepted for a local address, as everywhere else in Passwords.
 */
export function normalizeSiteInput(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  // A space is never part of a host. Chromium's URL parser would otherwise
  // percent-encode it and hand back a plausible-looking origin.
  if (/\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost"
    || url.hostname.endsWith(".localhost")
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol === "http:" && !local) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

function FieldError({ children }: { children: string | null }) {
  if (!children) return null;
  return <span className="ade-pw-field-error" role="alert">{children}</span>;
}

/** A value you type twice a year, with a way to check what you typed. */
function SecretField({
  value,
  onChange,
  placeholder,
  autoComplete = "new-password",
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="ade-pw-secret-field">
      <input
        className="kit-input"
        type={shown ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="ade-pw-reveal"
        aria-label={shown ? "Hide value" : "Show value"}
        title={shown ? "Hide value" : "Show value"}
        onClick={() => setShown((current) => !current)}
      >
        {shown ? <EyeSlash size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

export function NewLoginDialog({
  pin,
  onClose,
  onSaved,
}: {
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onSaved: (item: PasswordItemSummary) => void;
}) {
  const [title, setTitle] = useState("");
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [totp, setTotp] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const siteRef = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (saving) return;
    const origin = normalizeSiteInput(site);
    if (!origin) {
      setSiteError(site.trim() ? "Enter an https site, or a local address." : "Enter the site this login is for.");
      siteRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Enter the password.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await window.ade.passwords.saveLogin({
        ...(title.trim() ? { title: title.trim() } : {}),
        origins: [origin],
        username,
        password,
        ...(notes.trim() ? { notes } : {}),
        ...(totp.trim() ? { totpUri: totp.trim() } : {}),
      }, pin);
      setPassword("");
      setTotp("");
      onSaved(saved);
    } catch (err) {
      setPassword("");
      setError(errorText(err, "ADE couldn't save this login."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title="New login"
      description="Saved to Passwords and offered when an agent or you sign in to this site. The agent never sees the password."
      icon={<Key size={16} weight="duotone" />}
      tone="accent"
      size="md"
      initialFocusRef={siteRef}
      dismissible={!saving}
      actions={[
        { label: saving ? "Saving…" : "Save login", variant: "solid", onClick: () => void submit(), disabled: saving, busy: saving },
        { label: "Cancel", variant: "secondary", onClick: onClose, disabled: saving },
      ]}
    >
      <form
        className="ade-pw-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <label className="ade-pw-field">
          <span>Title</span>
          <input
            className="kit-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="GitHub"
            maxLength={120}
          />
        </label>
        <label className="ade-pw-field">
          <span>Site</span>
          <input
            ref={siteRef}
            className="kit-input"
            value={site}
            onChange={(event) => { setSite(event.target.value); setSiteError(null); }}
            placeholder="https://github.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <FieldError>{siteError}</FieldError>
        </label>
        <label className="ade-pw-field">
          <span>Username</span>
          <input
            className="kit-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="ade-pw-field">
          <span>Password</span>
          <SecretField value={password} onChange={setPassword} placeholder="Password" />
        </div>
        <div className="ade-pw-field">
          <span>Authenticator key</span>
          <SecretField value={totp} onChange={setTotp} placeholder="otpauth:// link or the key the site shows (optional)" />
        </div>
        <label className="ade-pw-field">
          <span>Notes</span>
          <textarea
            className="kit-input"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Anything worth remembering (optional)"
            rows={2}
          />
        </label>
        {error ? (
          <Banner layout="inline" model={{ id: "passwords-new-login-error", tone: "error", title: error, report: false }} />
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

export function NewSecretDialog({
  pin,
  onClose,
  onSaved,
}: {
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onSaved: (item: PasswordItemSummary) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (saving) return;
    const trimmed = name.trim();
    if (!SECRET_NAME.test(trimmed)) {
      setNameError("Use letters, numbers and underscores, and start with a letter or underscore.");
      nameRef.current?.focus();
      return;
    }
    if (!value) {
      setError("Enter the value.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await window.ade.passwords.saveSecret({
        name: trimmed,
        value,
        projectScope: null,
      }, pin);
      setValue("");
      onSaved(saved);
    } catch (err) {
      setValue("");
      setError(errorText(err, "ADE couldn't save this secret."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title="New secret"
      description="An API key or token agents can use in commands they run. They never see its value."
      icon={<Key size={16} weight="duotone" />}
      tone="accent"
      size="md"
      initialFocusRef={nameRef}
      dismissible={!saving}
      actions={[
        { label: saving ? "Saving…" : "Save secret", variant: "solid", onClick: () => void submit(), disabled: saving, busy: saving },
        { label: "Cancel", variant: "secondary", onClick: onClose, disabled: saving },
      ]}
    >
      <form
        className="ade-pw-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <label className="ade-pw-field">
          <span>Name</span>
          <input
            ref={nameRef}
            className="kit-input"
            value={name}
            onChange={(event) => { setName(event.target.value); setNameError(null); }}
            placeholder="OPENAI_API_KEY"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <FieldError>{nameError}</FieldError>
        </label>
        <div className="ade-pw-field">
          <span>Value</span>
          <SecretField value={value} onChange={setValue} placeholder="Value" />
        </div>
        <label className="ade-pw-field">
          <span>Project</span>
          <select className="kit-input" value="all" disabled>
            <option value="all">All projects</option>
          </select>
        </label>
        {error ? (
          <Banner layout="inline" model={{ id: "passwords-new-secret-error", tone: "error", title: error, report: false }} />
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

export function ChangePasswordDialog({
  item,
  pin,
  onClose,
  onSaved,
}: {
  item: PasswordItemSummary;
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onSaved: (item: PasswordItemSummary) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!password) {
      setError("Enter the new password.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Only the password: the brain keeps the login's exact sites,
      // username, title, notes and code.
      const saved = await window.ade.passwords.saveLogin({ id: item.id, password }, pin);
      setPassword("");
      onSaved(saved);
    } catch (err) {
      setPassword("");
      setError(errorText(err, "ADE couldn't change this password."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={`Change password for ${item.title}`}
      description="The site, username and title stay as they are. Agents that sign in will use the new password."
      icon={<Password size={16} weight="duotone" />}
      tone="accent"
      size="md"
      dismissible={!saving}
      actions={[
        { label: saving ? "Saving…" : "Change password", variant: "solid", onClick: () => void submit(), disabled: saving, busy: saving },
        { label: "Cancel", variant: "secondary", onClick: onClose, disabled: saving },
      ]}
    >
      <form
        className="ade-pw-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <div className="ade-pw-field">
          <span>New password</span>
          <SecretField value={password} onChange={setPassword} placeholder="New password" autoFocus />
        </div>
        {error ? (
          <Banner layout="inline" model={{ id: "passwords-change-password-error", tone: "error", title: error, report: false }} />
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

export function ChangeSecretValueDialog({
  item,
  pin,
  onClose,
  onSaved,
}: {
  item: PasswordItemSummary;
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onSaved: (item: PasswordItemSummary) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!value) {
      setError("Enter the new value.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await window.ade.passwords.saveSecret({
        id: item.id,
        name: item.title,
        value,
        projectScope: item.projectScope,
      }, pin);
      setValue("");
      onSaved(saved);
    } catch (err) {
      setValue("");
      setError(errorText(err, "ADE couldn't change this secret."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={`Change ${item.title}`}
      description="Every command that uses this secret gets the new value. Agents never see it."
      icon={<Key size={16} weight="duotone" />}
      tone="accent"
      size="md"
      dismissible={!saving}
      actions={[
        { label: saving ? "Saving…" : "Change value", variant: "solid", onClick: () => void submit(), disabled: saving, busy: saving },
        { label: "Cancel", variant: "secondary", onClick: onClose, disabled: saving },
      ]}
    >
      <form
        className="ade-pw-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <div className="ade-pw-field">
          <span>New value</span>
          <SecretField value={value} onChange={setValue} placeholder="New value" autoFocus />
        </div>
        {error ? (
          <Banner layout="inline" model={{ id: "passwords-change-secret-error", tone: "error", title: error, report: false }} />
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** Typed by the person to arm the reset, in lowercase so the command reads as itself. */
const RESET_WORD = "reset";

export function ResetPasswordsDialog({
  pin,
  onClose,
  onReset,
}: {
  pin: OpenProjectBinding | null;
  onClose: () => void;
  onReset: (status: PasswordsStatus) => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const armed = typed.trim() === RESET_WORD;

  const submit = async () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.ade.passwords.reset({ confirm: "reset" }, pin);
      onReset(next);
    } catch (err) {
      setError(errorText(err, "ADE couldn't reset Passwords."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title="Reset Passwords"
      description="Deletes every saved login and secret on every computer, and starts an empty vault. This can't be undone."
      icon={<ShieldWarning size={16} weight="duotone" />}
      tone="error"
      size="md"
      role="alertdialog"
      initialFocusRef={inputRef}
      dismissible={!busy}
      actions={[
        { label: busy ? "Resetting…" : "Reset Passwords", variant: "solid", onClick: () => void submit(), disabled: !armed || busy, busy },
        { label: "Cancel", variant: "secondary", onClick: onClose, disabled: busy },
      ]}
    >
      <form
        className="ade-pw-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <label className="ade-pw-field">
          <span>Type {RESET_WORD} to confirm</span>
          <input
            ref={inputRef}
            className="kit-input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={RESET_WORD}
            aria-label={`Type ${RESET_WORD} to confirm`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {error ? (
          <Banner layout="inline" model={{ id: "passwords-reset-error", tone: "error", title: error, report: false }} />
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
