/**
 * Settings › Passwords: the person's page for ADE's password manager.
 *
 * The page follows one machine (like Providers and Android devices): the
 * "use on this computer" switch is that computer's, while the vault and the
 * ADE Cloud switch are the account's. Every runtime call carries the page's
 * pin, and effects key on `pin?.key` so a rebuilt pin does not refetch.
 *
 * Values never reach this file. The list and every save answer with the same
 * summaries an agent may see; there is deliberately no reveal, copy or read
 * of a saved password or secret here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  CheckCircle,
  Key,
  MagnifyingGlass,
  Password,
  Plus,
  ShieldWarning,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import type { PasswordUseRecord, PasswordItemSummary, PasswordsStatus } from "../../../../shared/types/passwords";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { ipcErrorMessage } from "../../../lib/format";
import {
  ModernPage,
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsToggle,
} from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { useSettingsSearchAnchors } from "../settingsSearchContext";
import {
  ChangePasswordDialog,
  ChangeSecretValueDialog,
  NewLoginDialog,
  NewSecretDialog,
  ResetPasswordsDialog,
} from "./PasswordDialogs";
import "./passwords.css";

/** The largest CSV the page reads. The brain never needs a bigger one to import. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

type TabId = "logins" | "secrets" | "activity";

const TAB_ANCHORS: Record<string, TabId> = {
  "passwords-logins": "logins",
  "passwords-secrets": "secrets",
  "passwords-activity": "activity",
};

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "logins", label: "Logins" },
  { id: "secrets", label: "Secrets" },
  { id: "activity", label: "Activity" },
];

type DialogState =
  | { kind: "new-login" }
  | { kind: "new-secret" }
  | { kind: "change-password"; item: PasswordItemSummary }
  | { kind: "change-secret"; item: PasswordItemSummary }
  | { kind: "reset" }
  | null;

function tabFromHash(hash: string): TabId | null {
  return TAB_ANCHORS[hash.replace(/^#/, "")] ?? null;
}

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusLine(status: PasswordsStatus): string {
  if (!status.enabled) return status.machineKind === "cloud" ? "Off for ADE Cloud computers." : "Off on this computer.";
  if (status.itemCount == null) return "On for this computer.";
  const count = `${status.itemCount} saved item${status.itemCount === 1 ? "" : "s"}`;
  return status.machineKind === "cloud" ? `${count} · unlocked for ADE Cloud` : `${count} · encrypted`;
}

function loginHint(item: PasswordItemSummary): string {
  const parts = [item.username, item.sites.join(", ")].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || "No username";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ade-pw-fact">
      <span className="ade-pw-fact-label">{label}</span>
      <span className="ade-pw-fact-value">{children}</span>
    </div>
  );
}

function EmptyState({ title, hint, icon }: { title: string; hint: string; icon?: ReactNode }) {
  return (
    <div className="ade-pw-empty">
      <span className="ade-pw-empty-icon" aria-hidden>{icon ?? <Key size={18} weight="duotone" />}</span>
      <div className="ade-pw-empty-title">{title}</div>
      <div className="ade-pw-empty-hint">{hint}</div>
    </div>
  );
}

export function PasswordsSection() {
  const scope = useSettingsMachineScope();
  const pin = scope.pin;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? "this-machine";
  const machineLabel = scope.isThisMachine ? "this computer" : scope.machineName;
  const location = useLocation();
  const searchAnchors = useSettingsSearchAnchors();

  const [status, setStatus] = useState<PasswordsStatus | null>(null);
  const [items, setItems] = useState<PasswordItemSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash) ?? "logins");
  const [search, setSearch] = useState("");
  const [selectedLoginId, setSelectedLoginId] = useState<string | null>(null);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<"enabled" | "cloud" | "import" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [uses, setUses] = useState<PasswordUseRecord[]>([]);
  const loadItems = useCallback(async () => {
    setItems(await window.ade.passwords.list({}, pinRef.current));
    // An older brain has no Activity yet; the tab then just stays empty.
    setUses(await window.ade.passwords.activity?.({}, pinRef.current).catch(() => []) ?? []);
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const next = await window.ade.passwords.status({}, pinRef.current);
      setStatus(next);
      if (next.signedIn && next.enabled) await loadItems();
      else setItems([]);
    } catch (err) {
      setError(errorText(err, "ADE couldn't read Passwords on this computer."));
    } finally {
      setLoaded(true);
    }
  }, [loadItems]);

  // Keyed on the pin's key, never the pin object: a rebuilt pin with the same
  // key must not refetch the page.
  useEffect(() => {
    void load();
  }, [load, pinKey]);

  // A deeplink (`#passwords-secrets`) opens the tab it names, and the settings
  // search opens the tab that holds its match.
  useEffect(() => {
    const fromHash = tabFromHash(location.hash);
    if (fromHash) setTab(fromHash);
  }, [location.hash]);

  useEffect(() => {
    if (!searchAnchors) return;
    const match = searchAnchors.find((anchor) => TAB_ANCHORS[anchor] != null);
    if (match) setTab(TAB_ANCHORS[match]!);
  }, [searchAnchors]);

  const refreshStatus = useCallback(() => {
    void window.ade.passwords.status({}, pinRef.current).then(setStatus).catch(() => undefined);
  }, []);

  const signedIn = status?.signedIn === true;
  const enabled = status?.enabled === true;

  const logins = useMemo(
    () => items.filter((item) => item.kind === "login").sort((left, right) => left.title.localeCompare(right.title)),
    [items],
  );
  const secrets = useMemo(
    () => items.filter((item) => item.kind === "secret").sort((left, right) => left.title.localeCompare(right.title)),
    [items],
  );
  const query = search.trim().toLowerCase();
  const shownLogins = useMemo(
    () => (query
      ? logins.filter((item) => `${item.title} ${item.username ?? ""} ${item.sites.join(" ")}`.toLowerCase().includes(query))
      : logins),
    [logins, query],
  );
  const shownSecrets = useMemo(
    () => (query
      ? secrets.filter((item) => `${item.title} ${item.projectScope ?? ""}`.toLowerCase().includes(query))
      : secrets),
    [secrets, query],
  );
  const selectedLogin = shownLogins.find((item) => item.id === selectedLoginId) ?? shownLogins[0] ?? null;
  const selectedSecret = shownSecrets.find((item) => item.id === selectedSecretId) ?? shownSecrets[0] ?? null;

  const chooseTab = (next: TabId) => {
    setTab(next);
    setSearch("");
    setError(null);
  };

  const setSwitch = async (which: "enabled" | "cloud", next: boolean) => {
    if (!status) return;
    setBusy(which);
    setError(null);
    setNotice(null);
    try {
      const updated = which === "enabled"
        ? await window.ade.passwords.setEnabled({ enabled: next }, pinRef.current)
        : await window.ade.passwords.setCloudEnabled({ enabled: next }, pinRef.current);
      setStatus(updated);
      if (updated.signedIn && updated.enabled) await loadItems();
      else setItems([]);
    } catch (err) {
      setError(errorText(err, "ADE couldn't change that switch."));
    } finally {
      setBusy(null);
    }
  };

  const handleSaved = useCallback(async (saved: PasswordItemSummary) => {
    setDialog(null);
    setNotice(null);
    setError(null);
    setSearch("");
    setTab(saved.kind === "login" ? "logins" : "secrets");
    if (saved.kind === "login") setSelectedLoginId(saved.id);
    else setSelectedSecretId(saved.id);
    try {
      await loadItems();
    } catch (err) {
      setError(errorText(err, "Saved, but ADE couldn't read the list again."));
    }
    refreshStatus();
  }, [loadItems, refreshStatus]);

  const removeItem = async (item: PasswordItemSummary) => {
    const noun = item.kind === "login" ? "login" : "secret";
    const confirmed = await confirmDialog({
      title: `Delete this ${noun}?`,
      message: item.kind === "login"
        ? `“${item.title}” is removed from Passwords on every computer. This can't be undone.`
        : `“${item.title}” is removed from Passwords on every computer, and commands that use it stop getting a value. This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    setNotice(null);
    try {
      await window.ade.passwords.remove({ id: item.id }, pinRef.current);
      if (item.kind === "login") setSelectedLoginId(null);
      else setSelectedSecretId(null);
      await loadItems();
      refreshStatus();
    } catch (err) {
      setError(errorText(err, "ADE couldn't delete that item."));
    }
  };

  const importCsv = async (file: File) => {
    setError(null);
    setNotice(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setError("That file is larger than 5 MB. Export a smaller CSV and try again.");
      return;
    }
    setBusy("import");
    try {
      const text = await file.text();
      const result = await window.ade.passwords.importCsv({ text }, pinRef.current);
      setNotice(
        `Imported ${result.imported}, skipped ${result.skippedDuplicate} duplicates, ${result.skippedInvalid} rows without an https site or password. Delete the exported file now: it has your passwords in plain text.`,
      );
      await loadItems();
      refreshStatus();
    } catch (err) {
      setError(errorText(err, "ADE couldn't import that file."));
    } finally {
      setBusy(null);
    }
  };

  const headerActions = signedIn && enabled ? (
    <>
      <button
        type="button"
        className="ade-modern-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={busy === "import"}
      >
        <UploadSimple size={13} />
        {busy === "import" ? "Importing…" : "Import…"}
      </button>
      <button type="button" className="ade-modern-btn" onClick={() => setDialog({ kind: "new-login" })}>
        <Plus size={12} weight="bold" /> New login
      </button>
      <button type="button" className="ade-modern-btn" onClick={() => setDialog({ kind: "new-secret" })}>
        <Plus size={12} weight="bold" /> New secret
      </button>
    </>
  ) : null;

  const itemHint = tab === "logins"
    ? `${logins.length} saved · ${logins.filter((item) => item.hasTotp).length} with codes`
    : `${secrets.length} saved · encrypted`;

  const activeAnchor = tab === "logins" ? "passwords-logins" : tab === "secrets" ? "passwords-secrets" : "passwords-activity";

  return (
    <div className="ade-pw-page">
      <ModernPage>
        {error ? (
          <Banner
            layout="inline"
            model={{
              id: "passwords-error",
              tone: "error",
              title: error,
              report: false,
              actions: [{ label: "Retry", onClick: () => void load() }],
            }}
          />
        ) : null}
        {notice ? (
          <Banner
            layout="inline"
            model={{
              id: "passwords-notice",
              tone: "info",
              title: notice,
              report: false,
              dismiss: { onDismiss: () => setNotice(null) },
            }}
          />
        ) : null}

        <ModernSection
          group="Passwords"
          anchor="passwords-settings"
          title="Passwords"
          hint={!status
            ? loaded
              ? `Passwords on ${machineLabel} couldn't be read.`
              : `Reading Passwords on ${machineLabel}…`
            : status.signedIn
              ? statusLine(status)
              : undefined}
          icon={<Password size={16} weight="duotone" />}
          actions={headerActions}
        >
          {!status ? (
            loaded ? null : <p className="ade-pw-loading">Reading Passwords on {machineLabel}…</p>
          ) : !status.signedIn ? (
            <p className="ade-pw-signed-out">Sign in to ADE to use Passwords.</p>
          ) : (
            <>
              <ModernRows>
                <ModernRow
                  title="Use Passwords on this computer"
                  hint={status.machineKind === "cloud"
                    ? undefined
                    : "Off forgets this computer's copy of the key and its saved items. The account's vault stays."}
                  control={status.machineKind === "cloud" ? (
                    <span className="ade-pw-follows">ADE Cloud computers follow the switch below.</span>
                  ) : (
                    <SettingsToggle
                      checked={status.enabled}
                      onChange={(next) => void setSwitch("enabled", next)}
                      disabled={busy !== null}
                      label="Use Passwords on this computer"
                    />
                  )}
                />
                <ModernRow
                  title="ADE Cloud computers can use Passwords"
                  hint="Lets an ADE Cloud computer unlock the vault while it runs your work."
                  control={(
                    <SettingsToggle
                      checked={status.cloudEnabled ?? true}
                      onChange={(next) => void setSwitch("cloud", next)}
                      disabled={busy !== null}
                      label="ADE Cloud computers can use Passwords"
                    />
                  )}
                />
              </ModernRows>
              {!status.enabled ? (
                <p className="ade-pw-off">
                  Passwords is off on {machineLabel}. Turn it on to save logins and secrets, and to let agents use them.
                </p>
              ) : null}
            </>
          )}
        </ModernSection>

        {signedIn && enabled ? (
          <>
            <ModernSection
              group="Passwords"
              anchor={activeAnchor}
              title={tab === "logins" ? "Saved logins" : tab === "secrets" ? "Saved secrets" : "Activity"}
              hint={tab === "activity" ? "What agents and you used, and on which computer." : itemHint}
              icon={tab === "secrets" ? <Key size={16} weight="duotone" /> : undefined}
            >
              <div className="kit-seg ade-pw-tabs" role="tablist" aria-label="Passwords">
                {TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === entry.id}
                    onClick={() => chooseTab(entry.id)}
                  >
                    {entry.label}
                    {entry.id === "logins" && logins.length > 0 ? <span className="ade-pw-tab-count">{logins.length}</span> : null}
                    {entry.id === "secrets" && secrets.length > 0 ? <span className="ade-pw-tab-count">{secrets.length}</span> : null}
                  </button>
                ))}
              </div>

              {tab === "activity" ? (
                <div role="tabpanel" aria-label="Activity">
                  {uses.length === 0 ? (
                    <EmptyState
                      title="No activity yet"
                      hint="When an agent signs in or uses a secret, it shows here."
                      icon={<ShieldWarning size={18} weight="duotone" />}
                    />
                  ) : (
                    <ul className="ade-pw-activity" data-testid="passwords-activity-list">
                      {uses.slice(0, 200).map((use, index) => {
                        const item = items.find((candidate) => candidate.id === use.itemId);
                        const what = use.kind === "secret" ? `Used ${item?.title ?? "a secret"}` : `Signed in to ${use.target}`;
                        return (
                          <li key={`${use.at}-${index}`} className="ade-pw-activity-row">
                            <span className="ade-pw-activity-what">
                              {what}
                              {item?.username ? <span className="ade-pw-activity-sub"> as {item.username}</span> : null}
                            </span>
                            <span className="ade-pw-activity-who">{use.by === "agent" ? "Agent" : "You"}{use.machineName ? ` · ${use.machineName}` : ""}</span>
                            <time className="ade-pw-activity-when" dateTime={use.at}>{new Date(use.at).toLocaleString()}</time>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="ade-pw-split" role="tabpanel" aria-label={tab === "logins" ? "Saved logins" : "Saved secrets"}>
                  <div className="ade-pw-list">
                    <label className="ade-pw-search">
                      <MagnifyingGlass size={13} aria-hidden />
                      <input
                        type="search"
                        className="kit-input"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={tab === "logins" ? "Search logins" : "Search secrets"}
                        aria-label={tab === "logins" ? "Search logins" : "Search secrets"}
                        spellCheck={false}
                      />
                    </label>
                    {tab === "logins" ? (
                      shownLogins.length === 0 ? (
                        <EmptyState
                          title={logins.length === 0 ? "No saved logins yet" : "No login matches that"}
                          hint={logins.length === 0 ? "Add one with New login, or import a CSV." : "Try a site, title or username."}
                        />
                      ) : (
                        <div className="ade-pw-items">
                          {shownLogins.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className="ade-pw-item"
                              data-active={selectedLogin?.id === item.id ? "true" : undefined}
                              onClick={() => setSelectedLoginId(item.id)}
                            >
                              <span className="ade-pw-item-title">{item.title}</span>
                              <span className="ade-pw-item-hint">{loginHint(item)}</span>
                            </button>
                          ))}
                        </div>
                      )
                    ) : shownSecrets.length === 0 ? (
                      <EmptyState
                        title={secrets.length === 0 ? "No saved secrets yet" : "No secret matches that"}
                        hint={secrets.length === 0 ? "Add one with New secret." : "Try a name or project."}
                        icon={<Key size={18} weight="duotone" />}
                      />
                    ) : (
                      <div className="ade-pw-items">
                        {shownSecrets.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="ade-pw-item"
                            data-active={selectedSecret?.id === item.id ? "true" : undefined}
                            onClick={() => setSelectedSecretId(item.id)}
                          >
                            <span className="ade-pw-item-title">{item.title}</span>
                            <span className="ade-pw-item-hint">{item.projectScope ?? "All projects"}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="ade-pw-detail-wrap">
                    {tab === "logins" ? (
                      selectedLogin ? (
                        <div className="ade-pw-detail">
                          <header className="ade-pw-detail-head">
                            <div>
                              <h3>{selectedLogin.title}</h3>
                              <p>{selectedLogin.sites.join(" · ") || "No site"}</p>
                            </div>
                            <span className="kit-tag" data-tone="ok">
                              <CheckCircle size={11} weight="bold" /> Saved
                            </span>
                          </header>
                          <div className="ade-pw-facts">
                            <Fact label="Sites:">{selectedLogin.sites.join(", ") || "None"}</Fact>
                            <Fact label="Username:">{selectedLogin.username || "No username"}</Fact>
                            <Fact label="Password:">saved</Fact>
                            {selectedLogin.hasTotp ? <Fact label="Authenticator code:">saved</Fact> : null}
                            <Fact label="Updated:">{formatUpdatedAt(selectedLogin.updatedAt)}</Fact>
                          </div>
                          <div className="ade-pw-detail-actions">
                            <button
                              type="button"
                              className="ade-modern-btn"
                              onClick={() => setDialog({ kind: "change-password", item: selectedLogin })}
                            >
                              <Password size={13} /> Change password…
                            </button>
                            <button
                              type="button"
                              className="ade-modern-btn"
                              data-tone="danger"
                              onClick={() => void removeItem(selectedLogin)}
                            >
                              <Trash size={13} /> Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <EmptyState title="Nothing selected" hint="Pick a login on the left to see its details." />
                      )
                    ) : selectedSecret ? (
                      <div className="ade-pw-detail">
                        <header className="ade-pw-detail-head">
                          <div>
                            <h3>{selectedSecret.title}</h3>
                            <p>{selectedSecret.projectScope ?? "All projects"}</p>
                          </div>
                          <span className="kit-tag" data-tone="ok">
                            <CheckCircle size={11} weight="bold" /> Saved
                          </span>
                        </header>
                        <div className="ade-pw-facts">
                          <Fact label="Name:">{selectedSecret.title}</Fact>
                          <Fact label="Project:">{selectedSecret.projectScope ?? "All projects"}</Fact>
                          <Fact label="Value:">saved</Fact>
                          <Fact label="Updated:">{formatUpdatedAt(selectedSecret.updatedAt)}</Fact>
                        </div>
                        <div className="ade-pw-detail-actions">
                          <button
                            type="button"
                            className="ade-modern-btn"
                            onClick={() => setDialog({ kind: "change-secret", item: selectedSecret })}
                          >
                            <Key size={13} /> Change value…
                          </button>
                          <button
                            type="button"
                            className="ade-modern-btn"
                            data-tone="danger"
                            onClick={() => void removeItem(selectedSecret)}
                          >
                            <Trash size={13} /> Delete
                          </button>
                        </div>
                      </div>
                    ) : (
                      <EmptyState title="Nothing selected" hint="Pick a secret on the left to see its details." />
                    )}
                  </div>
                </div>
              )}
            </ModernSection>

            <ModernSection
              group="Passwords"
              anchor="passwords-reset"
              title="Danger zone"
              hint="Starting over deletes the vault itself, not just this computer's copy."
            >
              <ModernRows>
                <ModernRow
                  title="Reset Passwords"
                  hint="Deletes every saved login and secret on every computer, and starts an empty vault."
                  control={(
                    <button
                      type="button"
                      className="ade-modern-btn"
                      data-tone="danger"
                      onClick={() => setDialog({ kind: "reset" })}
                    >
                      <ShieldWarning size={13} /> Reset Passwords…
                    </button>
                  )}
                />
              </ModernRows>
            </ModernSection>
          </>
        ) : null}
      </ModernPage>

      <input
        ref={fileInputRef}
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
        <NewLoginDialog
          pin={pin}
          onClose={() => setDialog(null)}
          onSaved={(saved) => void handleSaved(saved)}
        />
      ) : null}
      {dialog?.kind === "new-secret" ? (
        <NewSecretDialog
          pin={pin}
          onClose={() => setDialog(null)}
          onSaved={(saved) => void handleSaved(saved)}
        />
      ) : null}
      {dialog?.kind === "change-password" ? (
        <ChangePasswordDialog
          item={dialog.item}
          pin={pin}
          onClose={() => setDialog(null)}
          onSaved={(saved) => void handleSaved(saved)}
        />
      ) : null}
      {dialog?.kind === "change-secret" ? (
        <ChangeSecretValueDialog
          item={dialog.item}
          pin={pin}
          onClose={() => setDialog(null)}
          onSaved={(saved) => void handleSaved(saved)}
        />
      ) : null}
      {dialog?.kind === "reset" ? (
        <ResetPasswordsDialog
          pin={pin}
          onClose={() => setDialog(null)}
          onReset={(next) => {
            setDialog(null);
            setStatus(next);
            setItems([]);
            setSelectedLoginId(null);
            setSelectedSecretId(null);
            setNotice("Passwords was reset. Every saved login and secret is gone.");
          }}
        />
      ) : null}
    </div>
  );
}
