import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CircleNotch, LinkBreak } from "@phosphor-icons/react";
import type { JiraConnectionStatus, JiraProject } from "../../../shared/types/jira";
import {
  JIRA_CONNECTION_CHANGED_EVENT,
  JIRA_PROJECT_BINDINGS_CHANGED_EVENT,
  rememberJiraConnectionStatus,
} from "../issues/jiraIssueStore";
import { setIssueTopBarVisible, useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import { ChipPicker } from "../issues/issueCreateChips";
import { JiraMark } from "../lanes/jiraBrand";
import { ModernPage, ModernRow, ModernRows, ModernSection, SettingsTextField, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { useActiveProjectRoot } from "../../state/appStore";
import { Banner } from "../ui/notice";
import "./IntegrationsSettings.css";

const JIRA_API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function JiraSection() {
  const { pin } = useSettingsMachineScope();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const projectRoot = useActiveProjectRoot();
  const issueTopBar = useIssueTopBarPreferences();
  const [connection, setConnection] = useState<JiraConnectionStatus | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setConnectionError(null);
    try {
      const status = await window.ade.jira.getConnectionStatus(pinRef.current);
      setConnection(status);
      if (status.siteUrl) setSiteUrl(status.siteUrl);
      if (status.email) setEmail(status.email);
      rememberJiraConnectionStatus(projectRoot, status, pinRef.current);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Couldn't load Jira connection status.");
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  const loadProjects = useCallback(async () => {
    setProjectLoading(true);
    setProjectError(null);
    try {
      setProjects(await window.ade.jira.listProjects({}, pinRef.current));
    } catch (error) {
      setProjects([]);
      setProjectError(error instanceof Error ? error.message : "Couldn't load Jira projects.");
    } finally {
      setProjectLoading(false);
    }
  }, []);

  const loadProjectBinding = useCallback(async () => {
    setProjectError(null);
    try {
      const snapshot = await window.ade.projectConfig.get(pinRef.current);
      setProjectKeys(snapshot.effective.issueTrackers?.jira?.projectKeys ?? []);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Couldn't load this project's Jira project bindings.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadProjectBinding();
    // The settings scope keeps the binding identity stable by key. The ref
    // supplies the current object to each call without restarting on rebuilds.
  }, [loadProjectBinding, loadStatus, pinKey]);

  useEffect(() => {
    if (!connection?.connected) {
      setProjects([]);
      return;
    }
    void loadProjects();
  }, [connection?.connected, loadProjects, pinKey]);

  const handleConnect = async () => {
    if (busy) return;
    const token = apiToken.trim();
    if (!siteUrl.trim() || !email.trim() || !token) {
      setConnectionError("Enter the Jira site URL, account email and API token.");
      return;
    }
    setBusy(true);
    setConnectionError(null);
    try {
      const status = await window.ade.jira.connect({ siteUrl: siteUrl.trim(), email: email.trim(), apiToken: token }, pinRef.current);
      setConnection(status);
      setApiToken("");
      rememberJiraConnectionStatus(projectRoot, status, pinRef.current);
      window.dispatchEvent(new Event(JIRA_CONNECTION_CHANGED_EVENT));
      if (!status.connected) setConnectionError(status.error?.message ?? "Jira did not accept these credentials.");
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Couldn't connect Jira.");
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setConnectionError(null);
    try {
      const status = await window.ade.jira.disconnect(pinRef.current);
      setConnection(status);
      rememberJiraConnectionStatus(projectRoot, status, pinRef.current);
      window.dispatchEvent(new Event(JIRA_CONNECTION_CHANGED_EVENT));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Couldn't disconnect Jira.");
    } finally {
      setBusy(false);
    }
  };

  const saveProjectKeys = async (nextKeys: string[]) => {
    setProjectBusy(true);
    setProjectError(null);
    try {
      const snapshot = await window.ade.projectConfig.get(pinRef.current);
      // The shared layer is never written (`.ade/ade.yaml` is not config
      // input any more), so the binding lives in this checkout's local.yaml.
      const local = snapshot.local;
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...local,
          issueTrackers: {
            ...(local.issueTrackers ?? {}),
            jira: { projectKeys: nextKeys },
          },
        },
      }, pinRef.current);
      setProjectKeys(nextKeys);
      window.dispatchEvent(new Event(JIRA_PROJECT_BINDINGS_CHANGED_EVENT));
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Couldn't save Jira project bindings.");
      await loadProjectBinding();
    } finally {
      setProjectBusy(false);
    }
  };

  const account = connection?.account;
  const connected = connection?.connected === true;
  const projectOptions = projects.map((project) => ({ id: project.key, label: `${project.key} · ${project.name}`, keywords: project.name }));

  return (
    <ModernPage>
      <ModernSection
        group="Jira"
        anchor="jira-connection"
        title="Jira"
        hint="Connect a Jira Cloud site to browse, edit and create its issues from ADE."
      >
        <ModernRows>
          <ModernRow
            title={connected ? "Connected Jira account" : "Connect Jira"}
            hint={connected ? "This machine stores the Jira API token in its encrypted credential store." : "Use an Atlassian API token with the email on your Jira account."}
            control={loading ? <CircleNotch size={14} className="animate-spin" /> : null}
          >
            {connected ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--kit-rule)] px-3 py-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-[color:var(--kit-fill)] text-[12px] font-semibold text-fg/80">
                  {account?.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" /> : account?.displayName?.charAt(0).toUpperCase() ?? <JiraMark size={16} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-fg/90">{account?.displayName ?? email}</span>
                  <span className="block truncate text-[11px] text-[color:var(--kit-text-3)]">{siteUrl} · {connection?.email ?? email}</span>
                </span>
                <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={() => void handleDisconnect()}>
                  <LinkBreak size={12} /> Disconnect
                </button>
              </div>
            ) : (
              <div className="grid max-w-[720px] gap-2 sm:grid-cols-2">
                <SettingsTextField value={siteUrl} onChange={setSiteUrl} type="url" placeholder="https://acme.atlassian.net" ariaLabel="Jira site URL" autoCapitalize="none" autoCorrect="off" />
                <SettingsTextField value={email} onChange={setEmail} type="email" placeholder="you@example.com" ariaLabel="Atlassian account email" autoComplete="username" autoCapitalize="none" autoCorrect="off" />
                <SettingsTextField value={apiToken} onChange={setApiToken} type="password" placeholder="Atlassian API token" ariaLabel="Jira API token" autoComplete="new-password" mono />
                <div className="flex items-center gap-2">
                  <button type="button" className="kit-btn kit-btn-primary" disabled={busy || loading} onClick={() => void handleConnect()}>
                    {busy ? <CircleNotch size={12} className="animate-spin" /> : <JiraMark size={12} />}
                    Connect Jira
                  </button>
                  <a className="inline-flex items-center gap-1 text-[11px] text-[color:var(--kit-text-2)] hover:text-fg" href={JIRA_API_TOKENS_URL} target="_blank" rel="noreferrer">
                    Create API token <ArrowSquareOut size={11} />
                  </a>
                </div>
              </div>
            )}
            {connectionError ? <div className="mt-2"><Banner layout="inline" model={{ id: "jira-connection-error", tone: "error", title: connection?.error?.reason === "unauthenticated" ? "Jira rejected the saved API token" : "Jira connection failed", detail: connectionError, actions: [{ label: "Retry status", onClick: () => { void loadStatus(); } }] }} /></div> : null}
            {connection?.error && !connectionError ? <div className="mt-2"><Banner layout="inline" model={{ id: "jira-saved-credential-error", tone: "warning", title: connection.error.reason === "unauthenticated" ? "Jira rejected the saved API token" : "Jira needs attention", detail: connection.error.message }} /></div> : null}
          </ModernRow>
          <ModernRow
            anchor="jira-top-bar"
            title="Show Jira in the top bar"
            hint="Show the Jira issues button when this machine is connected to Jira. Issue links still open in ADE when the button is hidden."
            control={<SettingsToggle checked={issueTopBar.jira} onChange={(visible) => setIssueTopBarVisible("jira", visible)} label="Show Jira in the top bar" />}
          />
        </ModernRows>
      </ModernSection>

      <ModernSection
        group="Jira project binding"
        anchor="jira-projects"
        title="Jira projects for this project"
        hint="Choose the Jira projects this checkout works with. ADE uses them as the issue pane and create form defaults, and to recognize Jira issue keys in chat."
      >
        <ModernRows>
          <ModernRow
            title="Bound Jira projects"
            hint="Saved for this checkout on this machine."
            control={connected ? (
              projectLoading ? <CircleNotch size={13} className="animate-spin" /> : (
                <ChipPicker
                  label="Jira projects"
                  display={projectKeys.length ? `${projectKeys.length} selected` : "Choose projects"}
                  options={projectOptions}
                  selected={projectKeys}
                  multi
                  placeholder="Search Jira projects…"
                  onPick={(key) => void saveProjectKeys(projectKeys.includes(key) ? projectKeys.filter((entry) => entry !== key) : [...projectKeys, key])}
                  muted={projectKeys.length === 0}
                />
              )
            ) : <span className="text-[11px] text-[color:var(--kit-text-3)]">Connect Jira to choose projects.</span>}
          >
            {projectBusy ? <div className="ade-modern-note"><CircleNotch size={12} className="animate-spin" /> Saving Jira project binding…</div> : null}
            {projectError ? <Banner layout="inline" model={{ id: "jira-project-binding-error", tone: "error", title: "Couldn't load or save Jira project bindings", detail: projectError, actions: [{ label: "Retry", onClick: () => { void loadProjectBinding(); if (connected) void loadProjects(); } }] }} /> : null}
          </ModernRow>
        </ModernRows>
      </ModernSection>
    </ModernPage>
  );
}
