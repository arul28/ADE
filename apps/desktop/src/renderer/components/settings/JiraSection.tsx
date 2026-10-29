import { jiraErrorMessage } from "../../../shared/jiraErrors";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check, CircleNotch, Kanban, LinkBreak } from "@phosphor-icons/react";
import type { JiraConnectionStatus, JiraProject } from "../../../shared/types/jira";
import {
  JIRA_CONNECTION_CHANGED_EVENT,
  JIRA_PROJECT_BINDINGS_CHANGED_EVENT,
  rememberJiraConnectionStatus,
} from "../issues/jiraIssueStore";
import { setIssueTopBarVisible, useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import { JiraMark } from "../lanes/jiraBrand";
import { SettingsTextField } from "./primitives";
import {
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { useActiveProjectRoot } from "../../state/appStore";
import { Banner } from "../ui/notice";
import "./IntegrationsSettings.css";
import { saveProjectLocalConfig } from "../../lib/projectLocalConfig";

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
  const [projectQuery, setProjectQuery] = useState("");

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
      setConnectionError(jiraErrorMessage(error, "Couldn't load Jira connection status."));
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
      setProjectError(jiraErrorMessage(error, "Couldn't load Jira projects."));
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
      setProjectError(jiraErrorMessage(error, "Couldn't load this project's Jira project bindings."));
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
      setConnectionError("Fill in the site, email and API token.");
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
      setConnectionError(jiraErrorMessage(error, "Couldn't connect Jira."));
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
      setConnectionError(jiraErrorMessage(error, "Couldn't disconnect Jira."));
    } finally {
      setBusy(false);
    }
  };

  const saveProjectKeys = async (nextKeys: string[]) => {
    setProjectBusy(true);
    setProjectError(null);
    try {
      // The shared layer is never written (`.ade/ade.yaml` is not config
      // input any more), so the binding lives in this checkout's local.yaml.
      await saveProjectLocalConfig(({ local }) => ({
        ...local,
        issueTrackers: {
          ...(local.issueTrackers ?? {}),
          jira: { projectKeys: nextKeys },
        },
      }), pinRef.current);
      setProjectKeys(nextKeys);
      window.dispatchEvent(new Event(JIRA_PROJECT_BINDINGS_CHANGED_EVENT));
    } catch (error) {
      setProjectError(jiraErrorMessage(error, "Couldn't save Jira project bindings."));
      await loadProjectBinding();
    } finally {
      setProjectBusy(false);
    }
  };

  const account = connection?.account;
  const connected = connection?.connected === true;

  const siteHost = (connection?.siteUrl ?? siteUrl).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const status = loading && !connection
    ? { tone: "checking" as const, label: "Checking…" }
    : connection?.error
      ? { tone: "warn" as const, label: "Needs attention" }
      : connected
        ? { tone: "ok" as const, label: "Connected" }
        : { tone: "neutral" as const, label: "Not connected" };
  const facts: IntegrationFact[] = connected
    ? [
        { label: "Site", value: siteHost || "—", mono: true },
        { label: "Projects here", value: projectKeys.length ? projectKeys.join(", ") : "None chosen", mono: projectKeys.length > 0 },
      ]
    : [];
  const query = projectQuery.trim().toLowerCase();
  const shownProjects = query
    ? projects.filter((project) => project.key.toLowerCase().includes(query) || project.name.toLowerCase().includes(query))
    : projects;
  const toggleProject = (key: string) => {
    if (projectBusy) return;
    void saveProjectKeys(projectKeys.includes(key) ? projectKeys.filter((entry) => entry !== key) : [...projectKeys, key]);
  };

  const projectsCard = (
    <IntegrationCard
      anchor="jira-projects"
      icon={<Kanban size={16} weight="duotone" />}
      title="Projects for this checkout"
      hint="Pick the Jira projects you work in here. New issues default to them, and ADE recognizes their issue keys in chat."
      badge={connected && projectKeys.length ? <span className="kit-tag" data-tone="ok">{projectKeys.length} chosen</span> : null}
      actions={connected && projects.length > 8 ? (
        <SettingsTextField value={projectQuery} onChange={setProjectQuery} placeholder="Search projects" ariaLabel="Search Jira projects" />
      ) : null}
    >
      {!connected ? (
        <p className="ade-ig-note">Connect Jira first. Your projects appear here to choose from.</p>
      ) : projectLoading ? (
        <p className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="ade-ig-note">This Jira account can&rsquo;t see any projects.</p>
      ) : (
        <div className="ade-ig-checklist" role="group" aria-label="Jira projects">
          {shownProjects.map((project) => {
            const on = projectKeys.includes(project.key);
            return (
              <button
                key={project.key}
                type="button"
                className="ade-ig-check"
                aria-pressed={on}
                disabled={projectBusy}
                onClick={() => toggleProject(project.key)}
              >
                <span className="ade-ig-check-box" aria-hidden>{on ? <Check size={11} weight="bold" /> : null}</span>
                <span className="ade-ig-check-key">{project.key}</span>
                <span className="ade-ig-check-name">{project.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {connected ? (
        <p className="ade-ig-note ade-ig-foot">
          {projectBusy ? <><CircleNotch size={12} className="animate-spin" /> Saving…</> : "Saved for this checkout, on this machine."}
        </p>
      ) : null}
      {projectError ? <Banner layout="inline" model={{ id: "jira-project-binding-error", tone: "error", title: "Couldn't load or save the projects", detail: projectError, actions: [{ label: "Retry", onClick: () => { void loadProjectBinding(); if (connected) void loadProjects(); } }] }} /> : null}
    </IntegrationCard>
  );

  return (
    <IntegrationPage id="jira">
      <IntegrationHero
        id="jira"
        anchor={connected ? "jira-connection" : undefined}
        status={status}
        account={connected ? {
          avatar: account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : (account?.displayName?.charAt(0).toUpperCase() ?? <JiraMark size={16} />),
          title: account?.displayName ?? connection?.email ?? email,
          detail: connection?.email ?? email,
        } : null}
        actions={connected ? (
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void handleDisconnect()}>
            <LinkBreak size={12} /> Disconnect
          </button>
        ) : null}
        facts={facts}
        topBar={{
          label: "Jira issues",
          checked: issueTopBar.jira,
          onChange: (visible) => setIssueTopBarVisible("jira", visible),
          anchor: "jira-top-bar",
        }}
      />

      {connectionError ? (
        <Banner layout="inline" model={{ id: "jira-connection-error", tone: "error", title: connection?.error?.reason === "unauthenticated" ? "Jira rejected the saved API token" : "Couldn't connect to Jira", detail: connectionError, actions: [{ label: "Check again", onClick: () => { void loadStatus(); } }] }} />
      ) : null}
      {connection?.error && !connectionError ? (
        <Banner layout="inline" model={{ id: "jira-saved-credential-error", tone: "warning", title: connection.error.reason === "unauthenticated" ? "Jira rejected the saved API token" : "Jira needs attention", detail: connection.error.message }} />
      ) : null}

      <IntegrationColumns>
        {connected ? null : (
          <IntegrationCard
            anchor="jira-connection"
            icon={<JiraMark size={15} />}
            title="Connect Jira Cloud"
            hint="Sign in with your Atlassian email and an API token. The token stays in this machine's encrypted credential store."
            actions={loading ? <CircleNotch size={14} className="animate-spin" /> : null}
          >
            <ol className="ade-ig-steps">
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>1</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Create an API token</b></div>
                  <p className="ade-ig-note">Atlassian makes them in your account&rsquo;s security settings. Copy it when it&rsquo;s shown.</p>
                  <div className="ade-ig-step-actions">
                    <a className="ade-modern-btn" href={JIRA_API_TOKENS_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                      <ArrowSquareOut size={12} /> Open Atlassian
                    </a>
                  </div>
                </div>
              </li>
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>2</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Paste your details</b></div>
                  <div className="ade-ig-form" style={{ marginTop: 6 }}>
                    <SettingsTextField value={siteUrl} onChange={setSiteUrl} type="url" placeholder="https://your-team.atlassian.net" ariaLabel="Jira site URL" autoCapitalize="none" autoCorrect="off" />
                    <SettingsTextField value={email} onChange={setEmail} type="email" placeholder="you@example.com" ariaLabel="Atlassian account email" autoComplete="username" autoCapitalize="none" autoCorrect="off" />
                    <div className="ade-ig-form-row">
                      <SettingsTextField value={apiToken} onChange={setApiToken} type="password" placeholder="API token" ariaLabel="Jira API token" autoComplete="new-password" mono />
                      <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || loading} onClick={() => void handleConnect()}>
                        {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                        Connect
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            </ol>
          </IntegrationCard>
        )}
        {projectsCard}
      </IntegrationColumns>
    </IntegrationPage>
  );
}
