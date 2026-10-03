import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Brain,
  ChartLineUp,
  ChatCircle,
  DeviceMobile,
  GearSix,
  GitBranch,
  HardDrives,
  Key,
  MagnifyingGlass,
  Palette,
  PlugsConnected,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { AccountPage } from "../account/AccountPage";
import { AppearanceSection } from "../settings/AppearanceSection";
import { AppleDevicesSection } from "../settings/AppleDevicesSection";
import { SettingsColumn } from "../settings/primitives";
import { ChatSection } from "../settings/ChatSection";
import { BudgetCapSettings } from "../settings/BudgetCapEditor";
import { AboutSection } from "../settings/AboutSection";
import { AdeCliSection } from "../settings/AdeCliSection";
import { AdeUsageSection } from "../settings/AdeUsageSection";
import { GitHubIntegrationSection } from "../settings/GitHubIntegrationSection";
import { KeepAwakeSection } from "../settings/KeepAwakeSection";
import { CaptureGestureSection } from "../settings/CaptureGestureSection";
import { LaneBehaviorSection } from "../settings/LaneBehaviorSection";
import { LaneTemplatesSection } from "../settings/LaneTemplatesSection";
import { LinearIntegrationSection } from "../settings/LinearIntegrationSection";
import { NotificationsSection } from "../settings/NotificationsSection";
import { PrChatTranscriptsSection } from "../settings/PrChatTranscriptsSection";
import { BrowserLinksSection } from "../settings/BrowserLinksSection";
import { BrowserAgentAccessSection } from "../settings/BrowserAgentAccessSection";
import { ProductAnalyticsSection } from "../settings/ProductAnalyticsSection";
import { DiagnosticsSharingSection } from "../settings/DiagnosticsSharingSection";
import { ProjectSection } from "../settings/ProjectSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { ProviderAccountsPanel } from "../settings/providers/accounts/ProviderAccountsPanel";
import { SettingsManagerPage } from "../settings/primitives/SettingsManagerPage";
import { ProviderLogo } from "../shared/ProviderLogos";
import { providerDescriptor } from "../settings/providers/descriptors";
import { SecretsSection } from "../settings/SecretsSection";
import { SessionLifecycleSection } from "../settings/SessionLifecycleSection";
import { StorageSection } from "../settings/StorageSection";
import { ArchiveSection } from "../settings/ArchiveSection";
import { RemoteSettingsBanner } from "../settings/RemoteContextBadge";
import { SettingsMachineScopeProvider } from "../settings/SettingsMachineScope";
import {
  MachineUnavailableNotice,
  SettingsMachineEyebrow,
  SettingsMachineNavRow,
  machineSectionAvailable,
  useSettingsMachinePage,
  type MachineSectionKind,
  type SettingsMachinePage,
} from "../settings/SettingsMachinesNav";
import { useProjectMachines, type ProjectMachine } from "../../state/projectMachines";
import { WebSettingsSection } from "../settings/WebScopePill";
import { Banner } from "../ui/notice";
import { SettingsSidebarHeader } from "../settings/SettingsSidebarHeader";
import {
  SETTINGS_ENTRIES,
  availableSettingsTabs,
  resolveSettingsHash,
  resolveSettingsTab,
  searchSettingsEntries,
  clearWebMachineBindingResolver,
  setWebMachineBindingResolver,
  settingsEntriesForTab,
  settingsTabLabel,
  type SettingEntry,
  type SettingsTabId,
  DEFAULT_SETTINGS_TAB,
  type SettingsTab,
  SETTINGS_GROUPS,
  groupScopeHint,
  isMachineSettingsTab,
  isThisComputerOnlyTab,
} from "../settings/settingsManifest";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { COLORS, SANS_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { ProjectSidebarSlot, useHasProjectSidebar } from "./projectSidebar/ProjectSidebarSlot";

/**
 * The settings shell. Tabs, ordering, deep links, and search all resolve
 * through `settingsManifest.ts` — this file renders, it does not decide.
 *
 * Sections mount per tab; a section that isn't on the active tab isn't
 * rendered. Several of them (Providers, Storage, Usage) open IPC on mount, so
 * rendering every tab at once would make opening settings expensive.
 */

const TAB_ICONS: Record<SettingsTabId, PhosphorIcon> = {
  account: UserCircle,
  general: GearSix,
  appearance: Palette,
  chat: ChatCircle,
  apple: DeviceMobile,
  agents: Brain,
  "lanes-git": GitBranch,
  integrations: PlugsConnected,
  notifications: Bell,
  secrets: Key,
  storage: HardDrives,
  archive: Archive,
  stats: ChartLineUp,
};

/** Tabs whose content sits in the centred `SettingsColumn`. */
const CENTERED_COLUMN_TABS: ReadonlySet<SettingsTabId> = new Set<SettingsTabId>([
  "appearance",
  "chat",
  "apple",
  "notifications",
  "stats",
  "secrets",
  "general",
  "agents",
  "lanes-git",
  "integrations",
  "storage",
  "archive",
]);

/** Tabs whose sections `TabContent` flows into the two-column layout. */
const FLOW_TABS: ReadonlySet<SettingsTabId> = new Set<SettingsTabId>([
  "general",
  "lanes-git",
  "integrations",
  "storage",
]);

/** Tour targets kept stable across the nine-tab split. */
const TOUR_IDS: Partial<Record<SettingsTabId, string>> = {
  agents: "backgroundJobs",
  "lanes-git": "laneTemplates",
};

/**
 * Every setting on a tab, unreachable ones included. `WebSettingsSection` needs
 * the full list to tell "this section has nowhere to write" apart from "this
 * section was handed no ids".
 */
function settingsEntryIdsForTab(tab: SettingsTabId): string[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab).map((entry) => entry.id);
}

/** Whether anything on this tab needs a machine to write to. */
function tabHasMachineSettings(tab: SettingsTabId): boolean {
  return SETTINGS_ENTRIES.some((entry) => entry.tab === tab && entry.web === "machine");
}

/**
 * What sits where the machine-scoped sections would be when the hosted client
 * has no project tab open. Saying nothing would read as "this tab is just
 * short" — the sections are absent for a reason the user can act on.
 */
function WebNoMachineNotice() {
  return (
    <Banner
      layout="inline"
      style={{ marginBottom: 20 }}
      model={{
        id: "settings-web-no-machine",
        tone: "neutral",
        icon: <HardDrives size={13} weight="regular" />,
        title: "Connect to a project to edit machine settings.",
      }}
    />
  );
}

/**
 * A `location.hash` as the manifest wants it: no leading `#`, percent-decoding
 * applied, and a malformed escape treated as literal text rather than thrown.
 *
 * Three call sites decoded the hash themselves — provider deeplinks, tab
 * resolution, and the scroll effect — which meant three chances for one of them
 * to forget the try/catch and take the settings page down on a URL a user can
 * type by hand.
 */
function decodeSettingsHash(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `#ai-provider-<id>` — the deeplink form of one provider's page. */
const PROVIDER_ANCHOR_PREFIX = "ai-provider-";

/** `#ai-harnesses` — the deeplink form of the harnesses page. */
const HARNESSES_ANCHOR = "ai-harnesses";

function providerIdFromHash(hash: string): string | null {
  const raw = decodeSettingsHash(hash);
  if (!raw.startsWith(PROVIDER_ANCHOR_PREFIX)) return null;
  return raw.slice(PROVIDER_ANCHOR_PREFIX.length) || null;
}

/**
 * Agents & Models. One provider's page is a sub-view of this tab rather than a
 * route of its own: `?provider=<id>`, with `#ai-provider-<id>` accepted so the
 * manifest entry for each provider deeplinks straight to it. While a provider
 * is open the tab shows only that page — the budget cap below the provider
 * list is not part of the provider you drilled into. Dictation lives
 * on the chat tab; scheduled work lives on notifications.
 */
function AgentsTabContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("provider")?.trim() || providerIdFromHash(location.hash);
  const providerId = requested && providerDescriptor(requested) ? requested : null;
  const harnessesOpen =
    searchParams.get("harnesses") === "1" || decodeSettingsHash(location.hash) === HARNESSES_ANCHOR;

  const handleProviderChange = useCallback((next: string | null) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set("provider", next);
    else nextParams.delete("provider");
    nextParams.delete("harnesses");
    navigate(
      {
        pathname: location.pathname,
        search: `?${nextParams.toString()}`,
        hash: next ? `#${PROVIDER_ANCHOR_PREFIX}${next}` : "",
      },
      { replace: true },
    );
  }, [location.pathname, navigate, searchParams]);

  if (isWebClientMode()) {
    return (
      <WebSettingsSection entryIds={["agents.accounts"]}>
        <WebAiAccountsPage />
      </WebSettingsSection>
    );
  }

  if (providerId) {
    return (
      <WebSettingsSection entryIds={[`agents.provider.${providerId}`]}>
        <ProvidersSection forceRefreshOnMount providerParam={providerId} onProviderChange={handleProviderChange} />
      </WebSettingsSection>
    );
  }

  return (
    <>
      <WebSettingsSection entryIds={["agents.providers"]}>
        <ProvidersSection
          forceRefreshOnMount
          providerParam={null}
          onProviderChange={handleProviderChange}
          // `#ai-harnesses` deeplinks scroll to the Custom section of this page.
          harnessesParam={harnessesOpen}
        />
      </WebSettingsSection>
      {/* Stored in the machine's `.ade/local.yaml` and enforced by its runtime. */}
      <WebSettingsSection entryIds={["agents.budget"]}>
        <BudgetCapSettings />
      </WebSettingsSection>
    </>
  );
}

/**
 * The web client's whole Providers tab: the connected machine's Claude and
 * Codex logins. Every other provider control signs in or reads files on that
 * machine, which a browser cannot do, so the tab shows only these two panels.
 */
function WebAiAccountsPage() {
  return (
    <SettingsManagerPage
      anchor="ai-accounts"
      title="AI accounts"
      description="Claude and Codex logins on the connected machine. Switching the default only changes new chats; running chats keep their account."
      icon={<UsersThree size={15} weight="duotone" />}
      tone="violet"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 28, paddingTop: 12 }}>
        {([["claude", "Claude"], ["codex", "Codex"]] as const).map(([provider, label]) => (
          <section key={provider} aria-label={`${label} accounts`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: 0,
                fontFamily: SANS_FONT,
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.textPrimary,
              }}
            >
              <ProviderLogo family={provider} size={18} />
              {label}
            </h3>
            <ProviderAccountsPanel provider={provider} providerLabel={label} />
          </section>
        ))}
      </div>
    </SettingsManagerPage>
  );
}

/**
 * One rendered section of a tab, and the manifest settings it holds.
 *
 * `"tab"` means "every entry on this tab", which is what a section that IS the
 * whole tab wants; naming them again would be a second list to keep in sync.
 */
type TabSection = {
  entryIds: readonly string[] | "tab";
  render: () => React.ReactNode;
  /** For pages under Machines: how the section reaches its machine. */
  machine?: MachineSectionKind;
  /** How the section is named in "not available here" notes. */
  title?: string;
  /** `full` spans both columns of a wide page instead of taking one. */
  span?: "full";
  /** Stack under the previous section in the same cell of a wide page. */
  stack?: true;
};

/**
 * What each tab renders, as data rather than as an eleven-arm switch.
 *
 * Every arm was the same shape — a `WebSettingsSection` wrapping one or two
 * section components — so the switch was a table written out longhand, and the
 * `entryIds` list beside each section is the part that actually matters: on the
 * desktop `WebSettingsSection` is a passthrough, and in the browser it uses
 * those ids to drop sections the manifest marks unreachable and head the rest
 * with their scope.
 *
 * `agents` is absent because it is a sub-view router, not a list of sections;
 * `TabContent` handles it directly.
 */
const TAB_SECTIONS: Partial<Record<SettingsTabId, readonly TabSection[]>> = {
  account: [
    {
      entryIds: ["account.profile", "account.computers"],
      // The account page, without its own page chrome.
      render: () => (
        <div id="account-profile" data-settings-anchor="account-profile">
          <AccountPage embedded />
        </div>
      ),
    },
  ],
  general: [
    {
      entryIds: ["general.about", "general.auto-updates"],
      // About has no section file of its own, so the page supplies its anchor.
      render: () => (
        <div id="about" data-settings-anchor="about">
          <AboutSection />
        </div>
      ),
      machine: "local",
      title: "About ADE and updates",
    },
    { entryIds: ["general.project"], render: () => <ProjectSection />, machine: "routed", title: "Project health" },
    { entryIds: ["general.ade-cli"], render: () => <AdeCliSection />, machine: "local", title: "ADE command line", stack: true },
    { entryIds: ["general.keep-awake"], render: () => <KeepAwakeSection />, machine: "local", title: "Keep awake" },
    { entryIds: ["general.capture-gesture"], render: () => <CaptureGestureSection />, machine: "local", title: "Capture gesture", stack: true },
    {
      entryIds: ["general.browser-agent-access"],
      render: () => <BrowserAgentAccessSection />,
      machine: "local",
      title: "ADE browser access",
    },
    // `.ade/local.yaml`, read by the link router of the window bound to that
    // checkout, so it has an effect only on the tab's own machine.
    { entryIds: ["general.link-open-mode"], render: () => <BrowserLinksSection />, machine: "bound", title: "Open links" },
    // Consent files in this install's ADE home (`~/.ade`), not the account.
    { entryIds: ["general.analytics"], render: () => <ProductAnalyticsSection />, machine: "local", title: "Product analytics", stack: true },
    {
      entryIds: ["general.diagnostics-sharing"],
      render: () => <DiagnosticsSharingSection />,
      machine: "local",
      title: "Diagnostics sharing",
    },
  ],
  appearance: [{ entryIds: "tab", render: () => <AppearanceSection /> }],
  apple: [{ entryIds: "tab", render: () => <SettingsColumn wide><AppleDevicesSection /></SettingsColumn> }],
  chat: [
    {
      entryIds: "tab",
      render: () => <ChatSection />,
    },
  ],
  "lanes-git": [
    {
      entryIds: [
        "lanes-git.new-lane-base",
        "lanes-git.auto-rebase",
        "lanes-git.rebase-suggestions",
        "lanes-git.rebase-min-behind",
      ],
      render: () => <LaneBehaviorSection />,
      machine: "routed",
      title: "Lane behaviour",
    },
    {
      entryIds: ["lanes-git.pr-chat-transcripts"],
      render: () => <PrChatTranscriptsSection />,
      machine: "routed",
      title: "PR chat transcripts",
    },
    // Last, so the two short sections above pair up and the full-width
    // template manager sits under them.
    { entryIds: ["lanes-git.lane-templates"], render: () => <LaneTemplatesSection />, machine: "routed", title: "Lane templates", span: "full" },
  ],
  // Connections live in the machine's credential store and are read by its
  // runtime. Their calls follow the tab's binding (no pin yet), so they are
  // shown for the machine the tab is bound to.
  integrations: [
    { entryIds: ["integrations.github"], render: () => <GitHubIntegrationSection />, machine: "bound", title: "GitHub" },
    { entryIds: ["integrations.linear"], render: () => <LinearIntegrationSection />, machine: "bound", title: "Linear" },
  ],
  notifications: [{ entryIds: "tab", render: () => <NotificationsSection /> }],
  secrets: [{ entryIds: ["secrets.secrets"], render: () => <SecretsSection /> }],
  storage: [
    {
      entryIds: ["storage.usage", "storage.lane-rules", "storage.diagnostics"],
      render: () => <StorageSection />,
      machine: "routed",
      title: "Disk usage and cleanup",
      span: "full",
    },
    {
      entryIds: ["storage.session-lifecycle"],
      render: () => <SessionLifecycleSection />,
      machine: "routed",
      title: "Session lifecycle",
      span: "full",
    },
  ],
  // Archived lanes and sessions belong to one machine's checkout, so the page
  // reads and acts through that machine's pin.
  archive: [{ entryIds: ["archive.items"], render: () => <ArchiveSection />, machine: "routed" }],
  stats: [{ entryIds: ["stats.usage"], render: () => <AdeUsageSection /> }],
};

/**
 * Providers is routed: every runtime call, the key store, provider accounts,
 * login terminals and auth-status feeds take the machine's pin. What stays on
 * This computer (opening a config file in the OS) is disabled in place.
 */
const AGENTS_TAB_KIND: MachineSectionKind = "routed";

/** Manifest entries whose section only works on the tab's own machine. */
const BOUND_MACHINE_ENTRY_IDS: ReadonlySet<string> = new Set(
  Object.values(TAB_SECTIONS).flatMap((sections) =>
    (sections ?? []).filter((section) => section.machine === "bound")
      .flatMap((section) => (section.entryIds === "tab" ? [] : [...section.entryIds]))),
);

function TabContent({
  tab,
  machine,
}: {
  tab: SettingsTabId;
  /** The machine a Machines page is for. Null for Account and Project pages. */
  machine: SettingsMachinePage | null;
}) {
  if (machine && !machine.online) {
    return <MachineUnavailableNotice machine={machine} />;
  }
  // Providers is the one tab that is not a list of sections: it routes between
  // the grid and one provider's page off `?provider=`.
  if (tab === "agents") {
    if (machine && !machineSectionAvailable(AGENTS_TAB_KIND, machine)) {
      return <MachineUnavailableNotice machine={machine} unavailableTitles={["Providers"]} />;
    }
    return (
      <SettingsColumn wide>
        <AgentsTabContent />
      </SettingsColumn>
    );
  }
  const sections = TAB_SECTIONS[tab];
  if (!sections) return null;
  const shown = machine
    ? sections.filter((section) => !section.machine || machineSectionAvailable(section.machine, machine))
    : sections;
  const hiddenTitles = machine
    ? sections.filter((section) => !shown.includes(section)).map((section) => section.title ?? "")
      .filter(Boolean)
    : [];
  const items = shown.map((section) => {
    const entryIds = section.entryIds === "tab" ? settingsEntryIdsForTab(tab) : section.entryIds;
    return { section, entryIds, node: (
      <WebSettingsSection key={entryIds.join(",")} entryIds={entryIds}>
        {section.render()}
      </WebSettingsSection>
    ) };
  });
  const notice = machine && hiddenTitles.length > 0 ? (
    <MachineUnavailableNotice machine={machine} unavailableTitles={hiddenTitles} />
  ) : null;
  // A tab whose one section is the whole page lays itself out.
  if (items.length === 1 && TAB_SECTIONS[tab]!.length === 1 && !FLOW_TABS.has(tab)) {
    return (
      <>
        {items[0]!.node}
        {notice}
      </>
    );
  }
  // Otherwise the sections flow into a two-column grid on a wide page. A
  // `stack` section joins the previous cell, so a short pair can sit beside
  // one tall section and the row still lines up.
  const cells: { key: string; span?: "full"; nodes: React.ReactNode[] }[] = [];
  for (const { section, entryIds, node } of items) {
    const last = cells[cells.length - 1];
    if (section.stack && last) last.nodes.push(node);
    else cells.push({ key: entryIds.join(","), span: section.span, nodes: [node] });
  }
  return (
    <SettingsColumn wide>
      <div className="ade-settings-flow">
        {cells.map((cell) => (
          <div key={cell.key} className="ade-settings-flow-item" data-span={cell.span}>
            {cell.nodes}
          </div>
        ))}
      </div>
      {notice}
    </SettingsColumn>
  );
}

/** Matches for the current query that live on other tabs. */
function CrossTabResults({
  results,
  onPick,
}: {
  results: SettingEntry[];
  onPick: (entry: SettingEntry) => void;
}) {
  if (results.length === 0) return null;
  return (
    <div
      style={{
        padding: 12,
        marginBottom: 16,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 10,
      }}
    >
      <div style={{ ...LABEL_STYLE, fontFamily: SANS_FONT, marginBottom: 8 }}>ALSO IN OTHER TABS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {results.slice(0, 8).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              fontFamily: SANS_FONT,
              fontSize: 11,
              background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 999,
              cursor: "pointer",
            }}
          >
            <span style={{ color: COLORS.textPrimary }}>{entry.label}</span>
            <span style={{ color: COLORS.textDim }}>{settingsTabLabel(entry.tab)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One-shot highlight for the card a search or deep link just landed on.
 *
 * Static, so it lives at module scope rather than being rebuilt per render.
 */
const FLASH_STYLES = (
  <style>{`
    @keyframes ade-settings-flash {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 55%, transparent); }
      100% { box-shadow: 0 0 0 10px transparent; }
    }
    .ade-settings-flash {
      animation: ade-settings-flash 1.2s ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .ade-settings-flash {
        animation: none;
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }
    }
  `}</style>
);


export function SettingsPage({ active = true }: { active?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  // Read-only: every write to the settings URL goes through `navigate` so the
  // hash survives alongside the search params.
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  // Machines pages exist once per machine; `?machine=<id>` picks which. Absent
  // means This computer. The hosted web client has no "This computer", so it
  // keeps the single bound-machine view it always had.
  const machineParam = searchParams.get("machine");
  const machinesEnabled = !isWebClientMode();
  const { machines } = useProjectMachines(active && machinesEnabled);
  // With no `?machine=`, a link to a setting that only works on the tab's own
  // machine (GitHub, Linear, link opening) lands on that machine; anything else
  // lands on This computer. For a tab open on this computer the two agree.
  const linkedEntryId = location.hash ? resolveSettingsHash(decodeSettingsHash(location.hash))?.id ?? null : null;
  const defaultMachineId = linkedEntryId && BOUND_MACHINE_ENTRY_IDS.has(linkedEntryId)
    ? (machines.find((machine) => machine.isActiveBinding)?.machineId ?? THIS_MACHINE_ID)
    : THIS_MACHINE_ID;
  const selectedMachine: ProjectMachine | null = machinesEnabled
    ? (machines.find((machine) => machine.machineId === (machineParam ?? defaultMachineId)) ?? machines[0] ?? null)
    : null;
  // Machine-scoped settings write to the machine the active project tab is
  // bound to, so on web they exist only while one is open. The manifest is what
  // nav, search and the palette all consult, and it has no store of its own —
  // it reads this binding through the resolver, refreshed here because this is
  // the surface that re-renders when the binding changes.
  const machineBound = useAppStore((state) => state.projectBinding) != null;
  // Installed during render because `isSettingAvailable` is consulted mid-render
  // (nav, search, the palette) and an effect would install it a render too late.
  // The effect exists only to take it back down on unmount, and only if it is
  // still ours — the module global outlives this component otherwise.
  const machineBoundRef = useRef(false);
  machineBoundRef.current = machineBound;
  // One stable function identity for this component's whole life, so the
  // unmount cleanup can tell its own resolver from the other surface's.
  const resolverRef = useRef<() => boolean>();
  if (!resolverRef.current) resolverRef.current = () => machineBoundRef.current;
  setWebMachineBindingResolver(resolverRef.current);
  useEffect(() => {
    const installed = resolverRef.current!;
    return () => clearWebMachineBindingResolver(installed);
  }, []);
  const webMachineSectionsHidden = isWebClientMode() && !machineBound;
  // Tabs the web client cannot serve still resolve — a deeplink or palette
  // entry naming one should land somewhere real rather than on an empty page,
  // so it falls through to the first tab this renderer does serve.
  const tabs = useMemo(() => availableSettingsTabs(), [machineBound]);
  // Explicit, so reordering the sidebar cannot move where Settings opens.
  const defaultTab = tabs.some((tab) => tab.id === DEFAULT_SETTINGS_TAB)
    ? DEFAULT_SETTINGS_TAB
    : tabs[0]?.id ?? DEFAULT_SETTINGS_TAB;
  // A `#hash` names one specific setting, so it is strictly more precise than
  // the `?tab=` next to it. When the two disagree — an older link that still
  // says `?tab=general#github-connection` after GitHub moved to Integrations —
  // follow the hash, which is the tab that actually contains the card we were
  // asked to show. Without this the URL lands on the named tab and the scroll
  // effect below silently no-ops, which is exactly how the GitHub App banner
  // used to dump people on General.
  const hashEntryTab = useMemo(() => {
    if (!location.hash) return null;
    return resolveSettingsHash(decodeSettingsHash(location.hash))?.tab ?? null;
  }, [location.hash]);
  const requestedTab = hashEntryTab ?? resolveSettingsTab(tabParam);
  const resolvedTab = requestedTab && tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : requestedTab
      ? defaultTab
      : null;

  const [section, setSection] = useState<SettingsTabId>(resolvedTab ?? defaultTab);
  // The machine the open page is about. A page that describes this computer's
  // own screen (Appearance) is always This computer, whatever `?machine=` says.
  const pageMachine: ProjectMachine | null = isThisComputerOnlyTab(section)
    ? (machines.find((machine) => machine.machineId === THIS_MACHINE_ID) ?? selectedMachine)
    : selectedMachine;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Follow ?tab= when it changes underneath us (deeplinks, palette, tours).
  useEffect(() => {
    if (!active) return;
    if (resolvedTab && resolvedTab !== section) setSection(resolvedTab);
  }, [active, resolvedTab, section]);

  // Rewrite a legacy ?tab= to its canonical id, so the URL a user copies out
  // of the address bar is the one we would have generated.
  useEffect(() => {
    if (!active) return;
    if (!tabParam || !resolvedTab || tabParam === resolvedTab) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", resolvedTab);
    // Navigate rather than setSearchParams: the latter drops the hash, which
    // would throw away the very anchor that selected this tab and leave the
    // scroll effect below with nothing to scroll to.
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: location.hash },
      { replace: true },
    );
  }, [active, location.hash, location.pathname, navigate, resolvedTab, searchParams, tabParam]);

  // `?integration=github|linear|cli` predates the manifest.
  useEffect(() => {
    if (!active) return;
    const integration = searchParams.get("integration")?.trim().toLowerCase() ?? "";
    if (!integration) return;
    if (!["github", "linear", "cli"].includes(integration)) return;
    const entry = resolveSettingsHash(integration === "cli" ? "ade-cli" : integration);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", entry?.tab ?? "integrations");
    nextParams.delete("integration");
    navigate(
      {
        pathname: location.pathname,
        search: `?${nextParams.toString()}`,
        hash: entry ? `#${entry.anchor}` : "",
      },
      { replace: true },
    );
  }, [active, location.pathname, navigate, searchParams]);

  const navigateToTab = useCallback((next: SettingsTabId, hash?: string, machineId?: string) => {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    // The machine travels with Machines pages only. Account and Project pages
    // have no machine, and a stale one in the URL would mislead the next link.
    // Appearance describes this computer's own screen, so it never carries one.
    const targetMachine = isMachineSettingsTab(next) && !isThisComputerOnlyTab(next)
      ? (machineId ?? nextParams.get("machine"))
      : null;
    if (targetMachine && targetMachine !== THIS_MACHINE_ID) nextParams.set("machine", targetMachine);
    else nextParams.delete("machine");
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: hash ? `#${hash}` : "" },
      { replace: true },
    );
  }, [location.pathname, navigate, searchParams]);

  // Scroll a hash target into view once its tab is mounted. Resolving through
  // the manifest means a hash whose anchor has since moved still lands.
  useEffect(() => {
    if (!active || !location.hash) return;
    const entry = resolveSettingsHash(decodeSettingsHash(location.hash));
    if (!entry || entry.tab !== section) return;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(entry.anchor);
      if (!card) return;
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      // Scrolling to a card is not the same as pointing at it. On a page of
      // near-identical rows the user still has to find which one the search
      // meant, and on a short page nothing scrolls at all, so the result looks
      // like it did nothing. One flash answers both.
      card.classList.add("ade-settings-flash");
      flashTimer = setTimeout(() => card.classList.remove("ade-settings-flash"), 1_200);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [active, section, location.hash]);

  // A new tab should open at the top, not wherever the last one was scrolled.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const trimmedQuery = deferredQuery.trim();
  const { matchesThisTab, matchesOtherTabs } = useMemo(() => {
    if (!trimmedQuery) {
      return { matchesThisTab: null as SettingEntry[] | null, matchesOtherTabs: [] as SettingEntry[] };
    }
    const all = searchSettingsEntries(trimmedQuery);
    return {
      matchesThisTab: all.filter((entry) => entry.tab === section),
      matchesOtherTabs: all.filter((entry) => entry.tab !== section),
    };
  }, [trimmedQuery, section]);

  // Searching hides non-matching cards on this tab. Sections own their own
  // markup, so the filter runs over the `data-settings-anchor` ids the
  // manifest guarantees each card carries.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const cards = root.querySelectorAll<HTMLElement>("[data-settings-anchor]");
    const groups = root.querySelectorAll<HTMLElement>("[data-settings-group]");
    if (!trimmedQuery) {
      cards.forEach((card) => { card.style.display = ""; });
      groups.forEach((group) => { group.style.display = ""; });
      return;
    }
    const visible = new Set((matchesThisTab ?? []).map((entry) => entry.anchor));
    cards.forEach((card) => {
      card.style.display = visible.has(card.dataset.settingsAnchor ?? "") ? "" : "none";
    });
    // Some settings are intentionally nested inside a larger card (for
    // example, update preferences inside the ADE status card). Keep that
    // parent mounted when a child is the search result; otherwise the child
    // would be marked visible inside an ancestor that remains display:none.
    cards.forEach((card) => {
      if (card.style.display !== "none") return;
      const hasVisibleChild = [...card.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((child) => child !== card && visible.has(child.dataset.settingsAnchor ?? ""));
      if (hasVisibleChild) card.style.display = "";
    });
    // A group whose cards all filtered out would otherwise leave a heading
    // hanging over nothing.
    groups.forEach((group) => {
      const hasVisibleCard = [...group.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((card) => card.style.display !== "none");
      group.style.display = hasVisibleCard ? "" : "none";
    });
  }, [trimmedQuery, matchesThisTab, section]);

  const projectDisplayName = useAppStore((state) => state.project?.displayName);
  const hasOpenProject = Boolean(projectDisplayName);
  const repoGroupLabel = projectDisplayName ?? "This repository";
  const hasProjectSidebar = useHasProjectSidebar();

  const renderTabButton = (tab: SettingsTab, machine?: ProjectMachine) => {
    const Icon = TAB_ICONS[tab.id];
    const isActive = section === tab.id && (!machine || pageMachine?.machineId === machine.machineId);
    const hoverKey = machine ? `${machine.machineId}:${tab.id}` : tab.id;
    const isHovered = hoveredId === hoverKey;
    // Tour anchors stay on This computer's copy of each page.
    const tourId = !machine || machine.isThisMachine ? `settings.${TOUR_IDS[tab.id] ?? tab.id}` : undefined;
    return (
      <button
        key={hoverKey}
        type="button"
        data-tour={tourId}
        onClick={() => navigateToTab(tab.id, undefined, machine?.machineId)}
        onMouseEnter={() => setHoveredId(hoverKey)}
        onMouseLeave={() => setHoveredId(null)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 9,
          padding: machine ? "5px 10px 5px 30px" : "6px 10px",
          border: "none",
          background: isActive
            ? "var(--shell-sidebar-item-active-bg)"
            : isHovered
              ? "var(--shell-sidebar-item-hover-bg)"
              : "transparent",
          color: isActive
            ? "var(--shell-sidebar-item-active-fg)"
            : isHovered
              ? "var(--shell-sidebar-item-hover-fg)"
              : "var(--shell-sidebar-item-fg)",
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          fontWeight: isActive ? 600 : 500,
          letterSpacing: "-0.01em",
          cursor: "pointer",
          borderRadius: 7,
          textAlign: "left",
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        <Icon size={14} weight="regular" style={{ flexShrink: 0 }} />
        <span>{tab.label}</span>
      </button>
    );
  };

  const sidebarHeader = (
    <SettingsSidebarHeader onOpenAccount={() => navigateToTab("account")} />
  );

  // The machine a Machines page is about, as the section components see it.
  const machinePageScope = useSettingsMachinePage(
    pageMachine && isMachineSettingsTab(section) ? pageMachine : null,
  );

  const activeTab = tabs.find((tab) => tab.id === section)
    ?? tabs.find((tab) => tab.id === defaultTab)
    ?? tabs[0];
  // A provider detail (or Harnesses) is a sub-view of the Providers tab. The
  // shell header owns the back affordance so it sits on the title row rather
  // than floating below it.
  const subViewOpen = Boolean(searchParams.get("provider")?.trim()) || searchParams.get("harnesses") === "1";
  const closeSubView = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("provider");
    next.delete("harnesses");
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: "" }, { replace: true });
  };
  const tabEntryCount = settingsEntriesForTab(section).length;
  const noMatchesHere = trimmedQuery.length > 0 && (matchesThisTab?.length ?? 0) === 0;

  // Inside a project the section list lives in the project sidebar. Outside
  // one (the hosted web client, tests) the page keeps its own column.
  const renderMachineRow = (machine: ProjectMachine, machineTabs: SettingsTab[]) => {
    const onMachinePage = isMachineSettingsTab(section);
    const selected = pageMachine?.machineId === machine.machineId;
    // A row opens the page you are on when that machine has it, else its first.
    const landingTab = onMachinePage && machineTabs.some((tab) => tab.id === section)
      ? section
      : (machineTabs[0]?.id ?? DEFAULT_SETTINGS_TAB);
    return (
      <SettingsMachineNavRow
        key={machine.machineId}
        machine={machine}
        selected={selected}
        active={selected && onMachinePage}
        onOpen={() => navigateToTab(landingTab, undefined, machine.machineId)}
      >
        {machineTabs.map((tab) => renderTabButton(tab, machine))}
      </SettingsMachineNavRow>
    );
  };

  const sectionList = (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const groupTabs = tabs.filter((tab) => tab.group === group.id);
        // A group with nothing reachable in it is not rendered (the hosted web
        // client drops whole pages whose writes have nowhere to land).
        if (!groupTabs.length) return null;
        const label = group.label ?? THIS_MACHINE_NAME;
        const hint = group.id === "project" && hasOpenProject
          ? `${repoGroupLabel}. ${groupScopeHint(group.id)}`
          : groupScopeHint(group.id);
        if (group.id === "machines" && machinesEnabled && machines.length > 0) {
          return (
            <div key={group.id} style={{ marginBottom: 14 }}>
              <div
                style={{
                  ...LABEL_STYLE,
                  fontFamily: SANS_FONT,
                  paddingLeft: 10,
                  marginBottom: 6,
                  color: "var(--shell-sidebar-item-fg)",
                  opacity: 0.75,
                }}
                title={groupScopeHint(group.id)}
              >
                {group.label}
              </div>
              {machines.map((machine) => renderMachineRow(
                machine,
                // Appearance has one page, under This computer.
                machine.machineId === THIS_MACHINE_ID
                  ? groupTabs
                  : groupTabs.filter((tab) => !isThisComputerOnlyTab(tab.id)),
              ))}
            </div>
          );
        }
        return (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div
              style={{
                ...LABEL_STYLE,
                fontFamily: SANS_FONT,
                paddingLeft: 10,
                marginBottom: 6,
                // The group name is the scope, so it carries the weight the
                // per-row chips used to; muting it would hide the one thing
                // this reorganisation exists to say.
                color: "var(--shell-sidebar-item-fg)",
                opacity: 0.75,
              }}
              title={hint}
            >
              {label}
            </div>
            {groupTabs.map((tab) => renderTabButton(tab))}
          </div>
        );
      })}
    </>
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>
          {sidebarHeader}
          <nav
            aria-label="Settings sections"
            style={{ flex: 1, minHeight: 0, padding: "4px 8px 12px", overflowY: "auto" }}
          >
            {sectionList}
          </nav>
        </ProjectSidebarSlot>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 220,
            flexShrink: 0,
            background: "var(--shell-sidebar-bg)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderRight: "1px solid var(--shell-sidebar-border)",
          }}
        >
          {sidebarHeader}
          <nav aria-label="Settings sections" style={{ flex: 1, minHeight: 0, padding: "4px 8px 12px", overflowY: "auto" }}>
            {sectionList}
          </nav>
        </div>
      )}

      <div ref={contentRef} style={{ flex: 1, overflow: "auto", background: COLORS.pageBg, padding: 24 }}>
        {/* The remote banner contrasts a remote machine against this desktop.
            A browser has no "this one", and every section already states its
            own scope, so web gets the per-section lines instead. */}
        {FLASH_STYLES}
        {/* Machines pages name their own machine below; the remote banner is
            for Account and Project pages, which follow the tab's binding. */}
        {isWebClientMode() || machinePageScope ? null : <RemoteSettingsBanner />}
        {webMachineSectionsHidden && tabHasMachineSettings(section) ? <WebNoMachineNotice /> : null}

        {/* Pages built on the centred settings column get a page wrapper of the
            same measure, so the title and search line up with the content. */}
        <div className={CENTERED_COLUMN_TABS.has(section) ? "ade-settings-page--column" : undefined}>
        <header className="ade-settings-page-header" style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
              {subViewOpen ? (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={closeSubView}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer", flexShrink: 0, marginLeft: -6 }}
                >
                  <ArrowLeft size={18} weight="bold" />
                </button>
              ) : null}
              <div style={{ minWidth: 0 }}>
                {machinePageScope ? <SettingsMachineEyebrow page={machinePageScope} /> : null}
              <h1
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: COLORS.textPrimary,
                }}
              >
                {activeTab.label}
              </h1>
              {/* No scope badge and no caption. The sidebar already files each
                  page under where it saves, and a one-line restatement of the
                  page's own title is the kind of copy that reads as
                  scaffolding. The search box sits on this same row. */}
              {activeTab.description ? (
                <p style={{ margin: "4px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  {activeTab.description}
                </p>
              ) : null}
              </div>
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 32,
                padding: "0 10px",
                minWidth: 240,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                borderRadius: 8,
              }}
            >
              <MagnifyingGlass size={14} style={{ color: COLORS.textDim, flexShrink: 0 }} />
              <input
                type="search"
                value={query}
                placeholder="Search all settings"
                aria-label="Search all settings"
                onChange={(event) => setQuery(event.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  color: COLORS.textPrimary,
                }}
              />
              {trimmedQuery ? (
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
                  {matchesThisTab?.length ?? 0}/{tabEntryCount}
                </span>
              ) : null}
            </label>
          </div>
        </header>

        {trimmedQuery ? (
          <CrossTabResults
            results={matchesOtherTabs}
            onPick={(entry) => {
              setQuery("");
              navigateToTab(entry.tab, entry.anchor);
            }}
          />
        ) : null}

        {noMatchesHere ? (
          <div
            style={{
              padding: 16,
              marginBottom: 16,
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 10,
            }}
          >
            Nothing in {activeTab.label} matches “{trimmedQuery}”.
            {matchesOtherTabs.length > 0 ? " Try one of the results above." : ""}
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {machinePageScope ? (
            // Keyed by machine so nothing one machine loaded can linger into,
            // or be saved onto, the next machine's page.
            <SettingsMachineScopeProvider key={machinePageScope.machineId} scope={machinePageScope}>
              <TabContent tab={section} machine={machinePageScope} />
            </SettingsMachineScopeProvider>
          ) : (
            <TabContent tab={section} machine={null} />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
