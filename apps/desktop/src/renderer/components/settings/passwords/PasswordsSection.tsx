/**
 * Settings › Passwords & Secrets: the person's page for ADE's vault.
 *
 * The vault is the account's and syncs to every computer the person signs in
 * to, so the page has no machine picker: it reads this computer's brain, which
 * also holds the secrets kept on this computer only. Every call goes through
 * `window.ade.passwords` with no pin (this computer's machine route).
 *
 * Values never reach this file except through Reveal / Copy, which main
 * answers after Touch ID or Windows Hello. Results of an action (a save, an
 * import, an export) are toasts, so they show wherever the page is scrolled.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  Check,
  ClockCounterClockwise,
  CloudArrowUp,
  Desktop,
  DotsThree,
  DownloadSimple,
  FileCsv,
  FileText,
  Key,
  MagnifyingGlass,
  Password,
  PencilSimple,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import type { PasswordEnvFile, PasswordItemSummary, PasswordLaneEnvPreview, PasswordsProject, PasswordsStatus, PasswordUseRecord } from "../../../../shared/types/passwords";
import { useAppStore } from "../../../state/appStore";
import { showToast } from "../../app/toast/toastStore";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { relativeWhen } from "../../../lib/format";
import { ModernPage } from "../primitives";
import { useSettingsSearchAnchors } from "../settingsSearchContext";
import {
  ChangeValueDialog,
  ImportEnvDialog,
  NewLoginDialog,
  NewSecretDialog,
  ResetPasswordsDialog,
} from "./PasswordDialogs";
import { errorText, loginHint, personCheckDeclined, plural, scopeLabel } from "./passwordsFormat";
import { subscribeLaneEnvImport, takeLaneEnvImport, type LaneEnvImportRequest } from "./laneEnvImport";
import "./passwords.css";

/** The largest CSV the page reads. The brain never needs a bigger one to import. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

type TabId = "logins" | "secrets" | "activity";

const TAB_ANCHORS: Record<string, TabId> = {
  "passwords-logins": "logins",
  "passwords-secrets": "secrets",
  "passwords-activity": "activity",
  // The removed Secrets page's links (`/settings#secrets`).
  secrets: "secrets",
};

type DialogState =
  | { kind: "new-login" }
  | { kind: "new-secret" }
  | { kind: "import-env"; file: PasswordEnvFile | PasswordLaneEnvPreview; laneEnv?: LaneEnvImportRequest }
  | { kind: "change-value"; item: PasswordItemSummary }
  | { kind: "reset" }
  | null;

function tabFromHash(hash: string): TabId | null {
  return TAB_ANCHORS[hash.replace(/^#/, "")] ?? null;
}

/** A page-sized "nothing here yet", with what to do about it. */
function EmptyHero({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ade-pw-hero">
      <span className="ade-pw-hero-icon" aria-hidden>{icon}</span>
      <h3 className="ade-pw-hero-title">{title}</h3>
      <p className="ade-pw-hero-text">{children}</p>
      {actions ? <div className="ade-pw-hero-actions">{actions}</div> : null}
    </div>
  );
}

/** A button that opens a small menu under it. */
function MenuButton({
  label,
  icon,
  ariaLabel,
  variant = "plain",
  children,
}: {
  label?: string;
  icon: ReactNode;
  ariaLabel: string;
  variant?: "plain" | "primary" | "icon";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={variant === "icon" ? "ade-pw-icon-btn" : "ade-modern-btn"}
        data-tone={variant === "primary" ? "primary" : undefined}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {label}
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={close} placement="bottom-end" role="menu" aria-label={ariaLabel} className="ade-pw-menu">
        {children(close)}
      </AnchoredMenu>
    </>
  );
}

function MenuItem({ icon, children, onClick, danger, checked, hint }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; checked?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      className="ade-pw-menu-item"
      data-danger={danger ? "true" : undefined}
      onClick={onClick}
    >
      <span className="ade-pw-menu-icon" aria-hidden>{checked === undefined ? icon : checked ? <Check size={13} weight="bold" /> : null}</span>
      <span className="ade-pw-menu-text">
        {children}
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  );
}

export function PasswordsSection() {
  const location = useLocation();
  const searchAnchors = useSettingsSearchAnchors();
  const openProjectRoot = useAppStore((state) => state.project?.rootPath ?? null);

  const [status, setStatus] = useState<PasswordsStatus | null>(null);
  const [items, setItems] = useState<PasswordItemSummary[]>([]);
  const [uses, setUses] = useState<PasswordUseRecord[]>([]);
  const [projects, setProjects] = useState<PasswordsProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash) ?? "logins");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<"switch" | "import" | "export" | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const loadItems = useCallback(async () => {
    setItems(await window.ade.passwords.list({}));
    setUses(await window.ade.passwords.activity({}).catch(() => []));
  }, []);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const next = await window.ade.passwords.status({});
      setStatus(next);
      if (next.signedIn && next.enabled) await loadItems();
      else setItems([]);
    } catch (err) {
      setLoadError(errorText(err, "ADE couldn't read Passwords & Secrets on this computer."));
    } finally {
      setLoaded(true);
    }
  }, [loadItems]);

  useEffect(() => {
    void load();
    void window.ade.passwords.projects().then(setProjects).catch((err: unknown) => {
      setProjects([]);
      showToast({ tone: "error", title: "Couldn't list this computer's projects", message: errorText(err, "Secrets can still be saved for every project.") });
    });
  }, [load]);

  // The `.env` tip: a file in a main checkout, maybe on another machine. Its
  // names and lengths come from that machine (the pin); so does the import.
  useEffect(() => {
    const open = () => {
      const request = takeLaneEnvImport();
      if (!request) return;
      setTab("secrets");
      void window.ade.passwords.previewLaneEnv({ path: request.path }, request.pin).then(
        (file) => {
          if (file.entries.length === 0) {
            showToast({ tone: "warning", title: `No secrets in ${file.fileName}`, message: "It has no NAME=value lines ADE can read.", report: false });
            return;
          }
          setDialog({ kind: "import-env", file, laneEnv: request });
        },
        (err: unknown) => showToast({ tone: "error", title: "Couldn't read that file", message: errorText(err, "Try again in a moment.") }),
      );
    };
    open();
    return subscribeLaneEnvImport(open);
  }, []);

  // A deeplink (`#passwords-secrets`, an old `?tab=secrets`) opens the view it
  // names; the settings search opens the view that holds its match.
  useEffect(() => {
    const fromHash = tabFromHash(location.hash);
    if (fromHash) setTab(fromHash);
  }, [location.hash]);
  useEffect(() => {
    const match = searchAnchors?.find((anchor) => TAB_ANCHORS[anchor] != null);
    if (match) setTab(TAB_ANCHORS[match]!);
  }, [searchAnchors]);

  const refreshStatus = useCallback(() => {
    void window.ade.passwords.status({}).then(setStatus).catch(() => undefined);
  }, []);

  const signedIn = status?.signedIn === true;
  const enabled = status?.enabled === true;
  const isCloud = status?.machineKind === "cloud";

  const logins = useMemo(
    // Passkeys sit with the logins: both are how you sign in to a site.
    () => items.filter((item) => item.kind === "login" || item.kind === "passkey").sort((a, b) => a.title.localeCompare(b.title)),
    [items],
  );
  const secrets = useMemo(
    () => items.filter((item) => item.kind === "secret").sort((a, b) => a.title.localeCompare(b.title)),
    [items],
  );
  const openProjectScope = projects.find((project) => project.rootPath === openProjectRoot)?.scope ?? null;
  // Projects to offer: this computer's, then any a saved secret is for.
  const knownProjects = useMemo(() => {
    const out = [...projects];
    for (const secret of secrets) {
      if (secret.projectScope && !out.some((project) => project.scope === secret.projectScope)) {
        out.push({ scope: secret.projectScope, name: scopeLabel(secret.projectScope, []), rootPath: "" });
      }
    }
    return out;
  }, [projects, secrets]);

  const setEnabledHere = async (next: boolean) => {
    if (!next) {
      const confirmed = await confirmDialog({
        title: "Turn off on this computer?",
        message: "This computer forgets its copy of your vault, and agents here stop signing in and using secrets. Everything stays in your account and on your other computers.",
        confirmLabel: "Turn off",
        destructive: true,
      });
      if (!confirmed) return;
    }
    setBusy("switch");
    try {
      const updated = await window.ade.passwords.setEnabled({ enabled: next });
      setStatus(updated);
      if (updated.signedIn && updated.enabled) await loadItems();
      else setItems([]);
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't change that", message: errorText(err, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  };

  const setCloud = async (next: boolean) => {
    setBusy("switch");
    try {
      setStatus(await window.ade.passwords.setCloudEnabled({ enabled: next }));
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't change that", message: errorText(err, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  };

  const handleSaved = useCallback(async (saved: PasswordItemSummary) => {
    setDialog(null);
    setTab(saved.kind === "secret" ? "secrets" : "logins");
    showToast({ tone: "success", title: `Saved ${saved.title}` });
    await loadItems().catch((err: unknown) => {
      showToast({ tone: "error", title: "Saved, but the list didn't refresh", message: errorText(err, "Reopen this page to see it.") });
    });
    refreshStatus();
  }, [loadItems, refreshStatus]);

  const removeItem = async (item: PasswordItemSummary) => {
    const noun = item.kind === "secret" ? "secret" : item.kind === "passkey" ? "passkey" : "login";
    const where = item.deviceOnly ? "from this computer" : "on every computer";
    const confirmed = await confirmDialog({
      title: `Delete ${item.title}?`,
      message: item.kind === "secret"
        ? `This ${noun} is deleted ${where}, and commands that use it stop getting a value. This can't be undone.`
        : `This ${noun} is deleted ${where}. This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await window.ade.passwords.remove({ id: item.id });
      showToast({ tone: "success", title: `Deleted ${item.title}` });
      await loadItems();
      refreshStatus();
    } catch (err) {
      showToast({ tone: "error", title: `Couldn't delete ${item.title}`, message: errorText(err, "Try again in a moment.") });
    }
  };

  const importCsv = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      showToast({ tone: "error", title: "That file is too big", message: "Export a CSV under 5 MB and try again.", report: false });
      return;
    }
    setBusy("import");
    try {
      const result = await window.ade.passwords.importCsv({ text: await file.text() });
      setTab("logins");
      showToast({
        tone: "success",
        title: `Imported ${plural(result.imported, "login")}`,
        message: `Skipped ${result.skippedDuplicate} already saved and ${result.skippedInvalid} without an https site or password. Delete the CSV now: it has your passwords in plain text.`,
        durationMs: 18_000,
      });
      await loadItems();
      refreshStatus();
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't import that file", message: errorText(err, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  };

  const chooseEnvFile = async () => {
    try {
      const file = await window.ade.passwords.chooseEnvFile();
      if (!file) return;
      if (file.entries.length === 0) {
        showToast({ tone: "warning", title: `No secrets in ${file.fileName}`, message: "It has no NAME=value lines ADE can read.", report: false });
        return;
      }
      setDialog({ kind: "import-env", file });
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't read that file", message: errorText(err, "Try another .env file.") });
    }
  };

  const exportSecrets = async (scope: string | null) => {
    setBusy("export");
    try {
      const result = await window.ade.passwords.exportSecrets({ projectScope: scope });
      showToast({
        tone: "success",
        title: `Exported ${plural(result.secretCount, "secret")}`,
        message: `Saved to ${result.filePath} on this computer. It holds the values in plain text: delete it when you're done.`,
        durationMs: 18_000,
      });
    } catch (err) {
      if (!personCheckDeclined(err)) showToast({ tone: "error", title: "Couldn't export", message: errorText(err, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  };

  // Every name an import would replace, this computer's own copies included (the import updates those in place).
  const existingByScope = useMemo(() => {
    const out = new Map<string | null, Set<string>>();
    for (const secret of secrets) {
      const names = out.get(secret.projectScope) ?? new Set<string>();
      names.add(secret.title);
      out.set(secret.projectScope, names);
    }
    return out;
  }, [secrets]);

  const statusText = !status
    ? (loaded ? "Couldn't read this computer's vault" : "Opening…")
    : !signedIn
      ? "Sign in to ADE to use it"
      : !enabled
        ? (isCloud ? "Off for ADE Cloud computers" : "Off on this computer")
        : `${plural(logins.length, "login")} · ${plural(secrets.length, "secret")}`;

  return (
    <div className="ade-pw-page">
      <ModernPage>
        {loadError ? (
          <Banner
            layout="inline"
            model={{
              id: "passwords-error",
              tone: "error",
              title: loadError,
              report: false,
              actions: [{ label: "Retry", onClick: () => void load() }],
            }}
          />
        ) : null}

        <div className="ade-pw-stack">
        <section className="ade-pw-bar" id="passwords-settings" data-settings-anchor="passwords-settings" data-settings-group="Passwords & Secrets">
          <div className="ade-pw-bar-status">
            <span className="ade-pw-bar-icon" data-on={enabled ? "true" : undefined} aria-hidden>
              {enabled ? <ShieldCheck size={16} weight="fill" /> : <ShieldWarning size={16} weight="fill" />}
            </span>
            <div className="ade-pw-bar-text">
              <span className="ade-pw-bar-title">{statusText}</span>
              <span className="ade-pw-bar-sub">
                {signedIn && enabled
                  ? "Encrypted, and synced to every computer you sign in to."
                  : signedIn && !enabled && !isCloud
                    ? "Turn it on to save logins and secrets here, and let agents here use them."
                    : "Agents use what's saved here, but never see it."}
              </span>
            </div>
          </div>
          {signedIn ? (
            <div className="ade-pw-bar-actions">
              {enabled ? (
                <>
                  <MenuButton label={busy === "import" ? "Importing…" : "Import"} icon={<UploadSimple size={13} />} ariaLabel="Import">
                    {(close) => (
                      <>
                        <MenuItem icon={<FileCsv size={14} />} hint="Chrome, Safari, 1Password, Bitwarden…" onClick={() => { close(); csvInputRef.current?.click(); }}>
                          Logins from a CSV…
                        </MenuItem>
                        <MenuItem icon={<FileText size={14} />} hint="NAME=value lines" onClick={() => { close(); void chooseEnvFile(); }}>
                          Secrets from a .env…
                        </MenuItem>
                      </>
                    )}
                  </MenuButton>
                  <MenuButton label="New" icon={<Plus size={12} weight="bold" />} ariaLabel="New" variant="primary">
                    {(close) => (
                      <>
                        <MenuItem icon={<Password size={14} />} onClick={() => { close(); setDialog({ kind: "new-login" }); }}>Login</MenuItem>
                        <MenuItem icon={<Key size={14} />} onClick={() => { close(); setDialog({ kind: "new-secret" }); }}>Secret</MenuItem>
                      </>
                    )}
                  </MenuButton>
                </>
              ) : !isCloud ? (
                <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy === "switch"} onClick={() => void setEnabledHere(true)}>
                  Turn on
                </button>
              ) : null}
              <MenuButton icon={<DotsThree size={16} weight="bold" />} ariaLabel="More options" variant="icon">
                {(close) => (
                  <>
                    <MenuItem
                      checked={status?.cloudEnabled !== false}
                      hint="Lets your cloud lanes unlock the vault while they work."
                      onClick={() => { close(); void setCloud(status?.cloudEnabled === false); }}
                    >
                      ADE Cloud computers can use it
                    </MenuItem>
                    {!isCloud && enabled ? (
                      <MenuItem icon={<Desktop size={14} />} onClick={() => { close(); void setEnabledHere(false); }}>
                        Turn off on this computer…
                      </MenuItem>
                    ) : null}
                    {enabled ? (
                      <>
                        <div className="ade-pw-menu-rule" role="separator" />
                        <MenuItem icon={<Trash size={14} />} danger onClick={() => { close(); setDialog({ kind: "reset" }); }}>
                          Reset Passwords &amp; Secrets…
                        </MenuItem>
                      </>
                    ) : null}
                  </>
                )}
              </MenuButton>
            </div>
          ) : null}
        </section>

        {signedIn && enabled ? (
          <section className="ade-pw-body" id={`passwords-${tab}`} data-settings-anchor={`passwords-${tab}`} data-settings-group="Passwords & Secrets">
            <div className="kit-seg ade-pw-tabs" role="tablist" aria-label="Passwords & Secrets">
              {([
                ["logins", "Logins", logins.length],
                ["secrets", "Secrets", secrets.length],
                ["activity", "Activity", null],
              ] as const).map(([id, label, count]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {label}
                  {count ? <span className="ade-pw-tab-count">{count}</span> : null}
                </button>
              ))}
            </div>

            {tab === "logins" ? (
              <LoginsView
                logins={logins}
                onNew={() => setDialog({ kind: "new-login" })}
                onImport={() => csvInputRef.current?.click()}
                onChange={(item) => setDialog({ kind: "change-value", item })}
                onDelete={(item) => void removeItem(item)}
              />
            ) : tab === "secrets" ? (
              <SecretsView
                secrets={secrets}
                projects={knownProjects}
                exporting={busy === "export"}
                onNew={() => setDialog({ kind: "new-secret" })}
                onImport={() => void chooseEnvFile()}
                onExport={(scope) => void exportSecrets(scope)}
                onChange={(item) => setDialog({ kind: "change-value", item })}
                onDelete={(item) => void removeItem(item)}
              />
            ) : (
              <ActivityView uses={uses} items={items} />
            )}
          </section>
        ) : null}
        </div>
      </ModernPage>

      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="ade-pw-file"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importCsv(file);
        }}
      />

      {dialog?.kind === "new-login" ? (
        <NewLoginDialog onClose={() => setDialog(null)} onSaved={(saved) => void handleSaved(saved)} />
      ) : null}
      {dialog?.kind === "new-secret" ? (
        <NewSecretDialog
          projects={knownProjects}
          defaultScope={openProjectScope}
          onClose={() => setDialog(null)}
          onSaved={(saved) => void handleSaved(saved)}
        />
      ) : null}
      {dialog?.kind === "import-env" ? (
        <ImportEnvDialog
          file={dialog.file}
          projects={knownProjects}
          defaultScope={openProjectScope}
          existing={existingByScope}
          onClose={() => setDialog(null)}
          importNames={dialog.laneEnv
            ? (names, scope) => window.ade.passwords.importLaneEnv({ path: dialog.laneEnv!.path, names, projectScope: scope }, dialog.laneEnv!.pin)
            : undefined}
          onImported={(result, scope) => {
            setDialog(null);
            setTab("secrets");
            const count = result.imported.length + result.replaced.length;
            showToast({
              tone: "success",
              title: `Imported ${plural(count, "secret")}`,
              message: `For ${scopeLabel(scope, knownProjects)}${result.replaced.length ? `; ${result.replaced.length} replaced an existing value` : ""}.`,
            });
            void loadItems();
            refreshStatus();
          }}
        />
      ) : null}
      {dialog?.kind === "change-value" ? (
        <ChangeValueDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={(saved) => void handleSaved(saved)} />
      ) : null}
      {dialog?.kind === "reset" ? (
        <ResetPasswordsDialog
          onClose={() => setDialog(null)}
          onReset={(next) => {
            setDialog(null);
            setStatus(next);
            void loadItems();
            showToast({ tone: "success", title: "Passwords & Secrets reset", message: "Every saved login and secret in your account is gone. Secrets kept on this computer only are still here." });
          }}
        />
      ) : null}
    </div>
  );
}

function LoginsView({
  logins,
  onNew,
  onImport,
  onChange,
  onDelete,
}: {
  logins: PasswordItemSummary[];
  onNew: () => void;
  onImport: () => void;
  onChange: (item: PasswordItemSummary) => void;
  onDelete: (item: PasswordItemSummary) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () => (query ? logins.filter((item) => `${item.title} ${item.username ?? ""} ${item.sites.join(" ")}`.toLowerCase().includes(query)) : logins),
    [logins, query],
  );
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;

  if (logins.length === 0) {
    return (
      <EmptyHero
        icon={<Password size={22} weight="duotone" />}
        title="Save your first login"
        actions={(
          <>
            <button type="button" className="ade-modern-btn" data-tone="primary" onClick={onNew}><Plus size={12} weight="bold" /> New login</button>
            <button type="button" className="ade-modern-btn" onClick={onImport}><FileCsv size={13} /> Import a CSV</button>
          </>
        )}
      >
        Agents sign in with your saved logins and fill your 2FA codes, but never see a password. Import the CSV that Chrome,
        Safari, 1Password or Bitwarden exports to bring everything over at once.
      </EmptyHero>
    );
  }

  return (
    <div className="ade-pw-split" role="tabpanel" aria-label="Logins">
      <div className="ade-pw-list">
        <label className="ade-pw-search">
          <MagnifyingGlass size={13} aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logins"
            aria-label="Search logins"
            spellCheck={false}
          />
        </label>
        <div className="ade-pw-items">
          {shown.length === 0 ? (
            <p className="ade-pw-nomatch">No login matches that.</p>
          ) : shown.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ade-pw-item"
              data-active={selected?.id === item.id ? "true" : undefined}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="ade-pw-favicon" aria-hidden>{item.title.slice(0, 1).toUpperCase()}</span>
              <span className="ade-pw-item-body">
                <span className="ade-pw-item-title">{item.title}</span>
                <span className="ade-pw-item-hint">{loginHint(item)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {selected ? (
        <div className="ade-pw-detail">
          <header className="ade-pw-detail-head">
            <span className="ade-pw-favicon" data-size="lg" aria-hidden>{selected.title.slice(0, 1).toUpperCase()}</span>
            <div>
              <h3>{selected.title}</h3>
              <p>{selected.sites.join(" · ") || "No site"}</p>
            </div>
          </header>
          <dl className="ade-pw-facts">
            <dt>Username</dt>
            <dd>{selected.username || "None"}</dd>
            {selected.kind === "passkey" ? (
              <>
                <dt>Passkey</dt>
                <dd>Used by ADE's browser after Touch ID</dd>
              </>
            ) : (
              <>
                <dt>Password</dt>
                <dd><RevealValue key={`${selected.id}:${selected.updatedAt}`} itemId={selected.id} field="password" label={selected.title} /></dd>
              </>
            )}
            {selected.hasTotp ? (
              <>
                <dt>2FA code</dt>
                <dd><LiveCode key={selected.id} itemId={selected.id} /></dd>
              </>
            ) : null}
            <dt>Updated</dt>
            <dd>{relativeWhen(selected.updatedAt)}</dd>
          </dl>
          <div className="ade-pw-detail-actions">
            {selected.kind === "passkey" ? null : (
              <button type="button" className="ade-modern-btn" onClick={() => onChange(selected)}>
                <PencilSimple size={13} /> Change password
              </button>
            )}
            <button type="button" className="ade-modern-btn" data-tone="danger" onClick={() => onDelete(selected)}>
              <Trash size={13} /> Delete
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SecretsView({
  secrets,
  projects,
  exporting,
  onNew,
  onImport,
  onExport,
  onChange,
  onDelete,
}: {
  secrets: PasswordItemSummary[];
  projects: PasswordsProject[];
  exporting: boolean;
  onNew: () => void;
  onImport: () => void;
  onExport: (scope: string | null) => void;
  onChange: (item: PasswordItemSummary) => void;
  onDelete: (item: PasswordItemSummary) => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const byScope = new Map<string | null, PasswordItemSummary[]>();
    for (const secret of secrets) {
      if (query && !`${secret.title} ${scopeLabel(secret.projectScope, projects)}`.toLowerCase().includes(query)) continue;
      const list = byScope.get(secret.projectScope) ?? [];
      list.push(secret);
      byScope.set(secret.projectScope, list);
    }
    return [...byScope.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : scopeLabel(a, projects).localeCompare(scopeLabel(b, projects))));
  }, [secrets, projects, query]);

  if (secrets.length === 0) {
    return (
      <EmptyHero
        icon={<Key size={22} weight="duotone" />}
        title="Keep API keys where agents can use them"
        actions={(
          <>
            <button type="button" className="ade-modern-btn" data-tone="primary" onClick={onNew}><Plus size={12} weight="bold" /> New secret</button>
            <button type="button" className="ade-modern-btn" onClick={onImport}><FileText size={13} /> Import a .env</button>
          </>
        )}
      >
        Agents run commands with your secrets in the environment (<code>ade secrets exec</code>) and see only masked output.
        Save a secret for every project, or for one.
      </EmptyHero>
    );
  }

  return (
    <div className="ade-pw-secrets" role="tabpanel" aria-label="Secrets">
      <label className="ade-pw-search" data-wide="true">
        <MagnifyingGlass size={13} aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search secrets or projects"
          aria-label="Search secrets"
          spellCheck={false}
        />
      </label>
      {groups.length === 0 ? <p className="ade-pw-nomatch">No secret matches that.</p> : null}
      {groups.map(([scope, list]) => (
        <div key={scope ?? "every"} className="ade-pw-group">
          <header className="ade-pw-group-head">
            <span className="ade-pw-group-name">{scopeLabel(scope, projects)}</span>
            <span className="ade-pw-group-count">{list.length}</span>
            <button
              type="button"
              className="ade-pw-link"
              disabled={exporting}
              title="Write these to a .env file in this computer's Downloads (asks for Touch ID)"
              onClick={() => onExport(scope)}
            >
              <DownloadSimple size={12} /> Export .env
            </button>
          </header>
          <div className="ade-pw-rows">
            {list.map((secret) => (
              <div key={secret.id} className="ade-pw-row">
                <span className="ade-pw-row-name">{secret.title}</span>
                <span className="ade-pw-row-value"><RevealValue key={`${secret.id}:${secret.updatedAt}`} itemId={secret.id} field="value" label={secret.title} /></span>
                <span className="ade-pw-row-meta">
                  {secret.deviceOnly ? (
                    <span className="kit-tag" title="Kept on this computer only, never synced"><Desktop size={10} weight="bold" /> This computer</span>
                  ) : (
                    <span className="ade-pw-row-synced" title="Synced to every computer you sign in to"><CloudArrowUp size={12} /></span>
                  )}
                  <span className="ade-pw-row-time">{relativeWhen(secret.updatedAt)}</span>
                </span>
                <span className="ade-pw-row-actions">
                  <button type="button" className="ade-pw-icon-btn" aria-label={`Change ${secret.title}`} title="Change value" onClick={() => onChange(secret)}>
                    <PencilSimple size={13} />
                  </button>
                  <button type="button" className="ade-pw-icon-btn" data-tone="danger" aria-label={`Delete ${secret.title}`} title="Delete" onClick={() => onDelete(secret)}>
                    <Trash size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityView({ uses, items }: { uses: PasswordUseRecord[]; items: PasswordItemSummary[] }) {
  if (uses.length === 0) {
    return (
      <EmptyHero icon={<ClockCounterClockwise size={22} weight="duotone" />} title="Nothing used yet">
        Each time an agent or you signs in with a saved login or runs a command with secrets, it shows here, with the computer it happened on.
      </EmptyHero>
    );
  }
  return (
    <ul className="ade-pw-activity" data-testid="passwords-activity-list" role="tabpanel" aria-label="Activity">
      {uses.slice(0, 200).map((use, index) => {
        const item = items.find((candidate) => candidate.id === use.itemId);
        // A secret row's id is the names given to the command.
        const what = use.kind === "secret" ? `Gave ${use.itemId} to \`${use.target}\`` : `Signed in to ${use.target}`;
        return (
          <li key={`${use.at}-${index}`} className="ade-pw-activity-row">
            <span className="ade-pw-activity-who" data-agent={use.by === "agent" ? "true" : undefined}>{use.by === "agent" ? "Agent" : "You"}</span>
            <span className="ade-pw-activity-what">
              {what}
              {item?.username ? <span className="ade-pw-activity-sub"> as {item.username}</span> : null}
            </span>
            <span className="ade-pw-activity-where">{use.machineName ?? ""}</span>
            <time className="ade-pw-activity-when" dateTime={use.at} title={new Date(use.at).toLocaleString()}>{relativeWhen(use.at)}</time>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The selected login's current authenticator code. Asked again when the code
 * runs out (not every second); the countdown in between is local.
 */
function LiveCode({ itemId }: { itemId: string }) {
  const [state, setState] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchCode = async () => {
      const next = await window.ade.passwords.code({ itemId }).catch(() => null);
      if (stopped) return;
      setState(next ? { code: next.code, expiresAt: Date.now() + next.secondsLeft * 1000 } : null);
      timer = setTimeout(() => void fetchCode(), Math.max(1_000, (next?.secondsLeft ?? 30) * 1000));
    };
    void fetchCode();
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
    };
  }, [itemId]);
  if (!state) return <span>saved</span>;
  const left = Math.max(0, Math.ceil((state.expiresAt - now) / 1000));
  return (
    <span className="ade-pw-code" data-testid="passwords-live-code">
      <span className="ade-pw-code-digits">{state.code.replace(/^(\d{3})(\d+)$/, "$1 $2")}</span>
      <span className="ade-pw-code-left">{left}s</span>
    </span>
  );
}

/**
 * Show / Copy one saved value after the person check (Touch ID / Windows
 * Hello in main). Keyed by item and its last change where it is used, so an
 * answer that arrives after the selection moved on lands in the old
 * (unmounted) row, and a new value never shows the old one. A copy never
 * passes through this page; the clipboard is cleared after 90 s.
 */
function RevealValue({ itemId, field, label }: { itemId: string; field: "password" | "value"; label: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), 30_000);
    return () => clearTimeout(timer);
  }, [shown]);
  const run = async (copy: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.ade.passwords.reveal({ itemId, field, copy, label });
      if (copy) showToast({ tone: "success", title: `Copied ${label}`, message: "The clipboard clears in 90 seconds." });
      else setShown(result.value ?? null);
    } catch (err) {
      if (!personCheckDeclined(err)) showToast({ tone: "error", title: `Couldn't read ${label}`, message: errorText(err, "Try again in a moment.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ade-pw-shown" data-testid={`passwords-reveal-${field}`}>
      <span className={shown === null ? "ade-pw-shown-dots" : "ade-pw-shown-value"}>{shown ?? "••••••••••"}</span>
      {shown === null ? (
        <button type="button" className="ade-pw-shown-btn" disabled={busy} onClick={() => void run(false)}>Show</button>
      ) : (
        <button type="button" className="ade-pw-shown-btn" onClick={() => setShown(null)}>Hide</button>
      )}
      <button type="button" className="ade-pw-shown-btn" disabled={busy} onClick={() => void run(true)}>Copy</button>
    </span>
  );
}
