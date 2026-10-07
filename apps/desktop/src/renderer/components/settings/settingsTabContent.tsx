import React, { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Desktop,
  FolderOpen,
  GitBranch,
  GithubLogo,
  HardDrives,
  Info,
  ShieldCheck,
  Stack,
  Timer,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import { AccountPage } from "../account/AccountPage";
import { AppearanceSection } from "./AppearanceSection";
import { AppleDevicesSection } from "./AppleDevicesSection";
import { ModernPage, SettingsColumn, SettingsSectionRail, type SettingsTone } from "./primitives";
import { ChatSection } from "./ChatSection";
import { BudgetCapSettings } from "./BudgetCapEditor";
import { AboutSection } from "./AboutSection";
import { AdeCliSection } from "./AdeCliSection";
import { AdeUsageSection } from "./AdeUsageSection";
import { GitHubIntegrationSection } from "./GitHubIntegrationSection";
import { LinearMark } from "../lanes/linearBrand";
import { KeepAwakeSection } from "./KeepAwakeSection";
import { CaptureGestureSection } from "./CaptureGestureSection";
import { LaneBehaviorSection } from "./LaneBehaviorSection";
import { LaneTemplatesSection } from "./LaneTemplatesSection";
import { LinearIntegrationSection } from "./LinearIntegrationSection";
import { NotificationsSection } from "./NotificationsSection";
import { PrChatTranscriptsSection } from "./PrChatTranscriptsSection";
import { BrowserLinksSection } from "./BrowserLinksSection";
import { BrowserAgentAccessSection } from "./BrowserAgentAccessSection";
import { ProductAnalyticsSection } from "./ProductAnalyticsSection";
import { DiagnosticsSharingSection } from "./DiagnosticsSharingSection";
import { ResetAdeSection } from "./ResetAdeSection";
import { ProjectSection } from "./ProjectSection";
import { ProvidersSection } from "./ProvidersSection";
import { ProviderAccountsPanel } from "./providers/accounts/ProviderAccountsPanel";
import { SettingsManagerPage } from "./primitives/SettingsManagerPage";
import { SettingsSection } from "./primitives/SettingsRows";
import { providerDescriptor } from "./providers/descriptors";
import { SecretsSection } from "./SecretsSection";
import { SessionLifecycleSection } from "./SessionLifecycleSection";
import { StorageSection } from "./StorageSection";
import { ArchiveSection } from "./ArchiveSection";
import {
  MachineUnavailableNotice,
  machineSectionAvailable,
  type MachineSectionKind,
  type SettingsMachinePage,
} from "./SettingsMachinesNav";
import { WebSettingsSection } from "./WebScopePill";
import {
  SETTINGS_ENTRIES,
  SETTINGS_TAB_IDS,
  sectionHasAvailableEntries,
  type SettingsTabId,
} from "./settingsManifest";
import { isWebClientMode } from "../../lib/webClientMode";

/**
 * What each Settings tab renders: its sections as data (`TAB_SECTIONS`), the
 * Providers sub-view router, and `TabContent`, which lays a tab out for one
 * machine. The page around it (`app/SettingsPage.tsx`) owns the nav, search,
 * routing and the machine scope; this file decides nothing about them.
 */

/**
 * Tabs laid out as a list of sections with the in-page rail, even when only
 * one of their sections is left (the rest unavailable on this machine).
 */
const SECTION_LIST_TABS: ReadonlySet<SettingsTabId> = new Set<SettingsTabId>([
  "general",
  "lanes-git",
  "integrations",
  "storage",
]);

/**
 * Every setting on a tab, unreachable ones included. `WebSettingsSection` needs
 * the full list to tell "this section has nowhere to write" apart from "this
 * section was handed no ids".
 */
function settingsEntryIdsForTab(tab: SettingsTabId): string[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab).map((entry) => entry.id);
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
export function decodeSettingsHash(hash: string): string {
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
    <ModernPage>
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
    </ModernPage>
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
      {([["claude", "Claude"], ["codex", "Codex"]] as const).map(([provider, label]) => (
        <SettingsSection key={provider} title={label}>
          <ProviderAccountsPanel provider={provider} providerLabel={label} />
        </SettingsSection>
      ))}
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
  /**
   * A link to this section with no `?machine=` opens the tab's machine rather
   * than This computer: it is about the project tab's own connection (a banner
   * or a PR reporting that machine's GitHub, say). Implied by `bound`.
   */
  linksToTabMachine?: true;
  /** How the section is named in "not available here" notes. */
  title?: string;
  /** The block it sits in on a section-list page (`TAB_GROUPS`). */
  group?: TabGroupId;
};

/**
 * The blocks a section-list page is organised into: a handful per page, each
 * with a title, an icon and one line, and the rail lists these, not the cards.
 * Ten loose cards on General read as a wall; four or five named blocks read
 * as a page.
 */
type TabGroup = {
  title: string;
  description: string;
  icon: React.ReactNode;
  tone: SettingsTone;
};

const TAB_GROUPS = {
  ade: {
    title: "ADE",
    description: "The app and its background service, updates, and the ade command.",
    icon: <Info size={15} weight="duotone" />,
    tone: "blue",
  },
  project: {
    title: "This project",
    description: "The .ade folder in this repository.",
    icon: <FolderOpen size={15} weight="duotone" />,
    tone: "green",
  },
  computer: {
    title: "This computer",
    description: "Sleep, screen capture, the ADE browser, and where links open.",
    icon: <Desktop size={15} weight="duotone" />,
    tone: "violet",
  },
  privacy: {
    title: "Privacy",
    description: "What ADE may send, and when.",
    icon: <ShieldCheck size={15} weight="duotone" />,
    tone: "teal",
  },
  danger: {
    title: "Danger zone",
    description: "Can't be undone. Read what it removes before you go on.",
    icon: <Warning size={15} weight="duotone" />,
    tone: "red",
  },
  lanes: {
    title: "How lanes behave",
    description: "Where new lanes start, staying current with the base, and PR transcripts.",
    icon: <GitBranch size={15} weight="duotone" />,
    tone: "accent",
  },
  templates: {
    title: "Templates",
    description: "Setups a new lane can start from.",
    icon: <Stack size={15} weight="duotone" />,
    tone: "amber",
  },
  github: {
    title: "GitHub",
    description: "Pull requests, checks and reviews.",
    icon: <GithubLogo size={15} weight="duotone" />,
    tone: "slate",
  },
  linear: {
    title: "Linear",
    description: "Issues, and the agent that works them.",
    icon: <LinearMark size={15} />,
    tone: "violet",
  },
  disk: {
    title: "Disk",
    description: "What ADE keeps on this machine, and what you can clear.",
    icon: <HardDrives size={15} weight="duotone" />,
    tone: "orange",
  },
  sessions: {
    title: "Sessions",
    description: "When finished chats and terminals are put away.",
    icon: <Timer size={15} weight="duotone" />,
    tone: "pink",
  },
} satisfies Record<string, TabGroup>;

type TabGroupId = keyof typeof TAB_GROUPS;

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
      group: "ade",
    },
    { entryIds: ["general.ade-cli"], render: () => <AdeCliSection />, machine: "local", title: "ADE command line", group: "ade" },
    { entryIds: ["general.project"], render: () => <ProjectSection />, machine: "routed", title: "Project health", group: "project" },
    { entryIds: ["general.keep-awake"], render: () => <KeepAwakeSection />, machine: "local", title: "Keep awake", group: "computer" },
    { entryIds: ["general.capture-gesture"], render: () => <CaptureGestureSection />, machine: "local", title: "Capture gesture", group: "computer" },
    {
      entryIds: ["general.browser-agent-access"],
      render: () => <BrowserAgentAccessSection />,
      machine: "local",
      title: "ADE browser access",
      group: "computer",
    },
    // `.ade/local.yaml`, read by the link router of the window bound to that
    // checkout, so it has an effect only on the tab's own machine.
    { entryIds: ["general.link-open-mode"], render: () => <BrowserLinksSection />, machine: "bound", title: "Open links", group: "computer" },
    // Consent files in this install's ADE home (`~/.ade`), not the account.
    { entryIds: ["general.analytics"], render: () => <ProductAnalyticsSection />, machine: "local", title: "Product analytics", group: "privacy" },
    {
      entryIds: ["general.diagnostics-sharing"],
      render: () => <DiagnosticsSharingSection />,
      machine: "local",
      title: "Diagnostics sharing",
      group: "privacy",
    },
    // Last on purpose: the hard reset is its own section at the very bottom of
    // General, never a routine control beside About.
    {
      entryIds: ["general.reset"],
      render: () => <ResetAdeSection />,
      machine: "local",
      title: "Reset ADE",
      group: "danger",
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
      group: "lanes",
    },
    {
      entryIds: ["lanes-git.pr-chat-transcripts"],
      render: () => <PrChatTranscriptsSection />,
      machine: "routed",
      title: "PR chat transcripts",
      group: "lanes",
    },
    // The template manager sits under the two behaviour sections.
    { entryIds: ["lanes-git.lane-templates"], render: () => <LaneTemplatesSection />, machine: "routed", title: "Lane templates", group: "templates" },
  ],
  // Connections live in the machine's credential store and are read by its
  // runtime. Every call takes the machine's pin, so each machine's page shows
  // and changes that machine's own GitHub and Linear connections. Browser
  // steps (device codes, OAuth pages) still open on This computer.
  integrations: [
    { entryIds: ["integrations.github"], render: () => <GitHubIntegrationSection />, machine: "routed", linksToTabMachine: true, title: "GitHub", group: "github" },
    { entryIds: ["integrations.linear"], render: () => <LinearIntegrationSection />, machine: "routed", linksToTabMachine: true, title: "Linear", group: "linear" },
  ],
  notifications: [{ entryIds: "tab", render: () => <NotificationsSection /> }],
  secrets: [{ entryIds: ["secrets.secrets"], render: () => <SecretsSection /> }],
  storage: [
    {
      entryIds: ["storage.usage", "storage.lane-rules", "storage.diagnostics"],
      render: () => <StorageSection />,
      machine: "routed",
      title: "Disk usage and cleanup",
      group: "disk",
    },
    {
      entryIds: ["storage.session-lifecycle"],
      render: () => <SessionLifecycleSection />,
      machine: "routed",
      title: "Session lifecycle",
      group: "sessions",
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

/**
 * The tabs that still have something to show with no project open.
 *
 * Standalone Settings (the new-project screen's own entry) can reach only the
 * sections that talk straight to this desktop — `machine: "local"`. A tab whose
 * sections all need a project binding (`routed` / `bound`) would render nothing
 * but a "not available here" notice, so it is left out of the nav entirely.
 * Account-style pages carry no machine kind and always render.
 */
export const STANDALONE_TAB_IDS: ReadonlySet<SettingsTabId> = new Set(
  SETTINGS_TAB_IDS.filter((tab) => {
    const sections = TAB_SECTIONS[tab];
    // Providers is a sub-view router, not a section list; it is routed.
    if (!sections) return tab !== "agents";
    if (sections.every((section) => section.machine === undefined)) return true;
    return sections.some((section) => section.machine === "local");
  }),
);

/** Manifest entries whose links open the tab's own machine page. */
export const BOUND_MACHINE_ENTRY_IDS: ReadonlySet<string> = new Set(
  Object.values(TAB_SECTIONS).flatMap((sections) =>
    (sections ?? []).filter((section) => section.machine === "bound" || section.linksToTabMachine)
      .flatMap((section) => (section.entryIds === "tab" ? [] : [...section.entryIds]))),
);

export function TabContent({
  tab,
  machine,
  standalone = false,
}: {
  tab: SettingsTabId;
  /** The machine a Machines page is for. Null for Account and Project pages. */
  machine: SettingsMachinePage | null;
  /** Standalone Settings (no project) also drops sections with nothing to show. */
  standalone?: boolean;
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
  const shown = (machine
    ? sections.filter((section) => !section.machine || machineSectionAvailable(section.machine, machine))
    : sections
  // Standalone Settings has no project, so a section whose settings are all
  // project-scoped would render an empty card that never loads. Drop it.
  ).filter((section) => !standalone || sectionHasAvailableEntries(
    section.entryIds === "tab" ? settingsEntryIdsForTab(tab) : section.entryIds,
  ));
  const hiddenTitles = machine
    ? sections.filter((section) => !shown.includes(section)).map((section) => section.title ?? "")
      .filter(Boolean)
    : [];
  const items = shown.map((section) => {
    const entryIds = section.entryIds === "tab" ? settingsEntryIdsForTab(tab) : section.entryIds;
    return {
      section,
      entryIds,
      node: (
        <WebSettingsSection key={entryIds.join(",")} entryIds={entryIds}>
          {section.render()}
        </WebSettingsSection>
      ),
    };
  });
  const notice = machine && hiddenTitles.length > 0 ? (
    <MachineUnavailableNotice machine={machine} unavailableTitles={hiddenTitles} />
  ) : null;
  // A tab whose one section is the whole page lays itself out.
  if (items.length === 1 && TAB_SECTIONS[tab]!.length === 1 && !SECTION_LIST_TABS.has(tab)) {
    return (
      <>
        {items[0]!.node}
        {notice}
      </>
    );
  }
  // Otherwise the sections are gathered into their named blocks, in the order
  // each block first appears, and the blocks run top to bottom. A sticky rail
  // beside them names each block and scrolls to it.
  const blocks: { id: string; group: TabGroup | null; items: typeof items }[] = [];
  for (const item of items) {
    const groupId = item.section.group ?? null;
    const existing = groupId ? blocks.find((block) => block.id === `settings-group-${groupId}`) : undefined;
    if (existing) {
      existing.items.push(item);
      continue;
    }
    blocks.push({
      // The rail's anchor: named after the block, so it stays put when a
      // section is hidden on another machine.
      id: groupId ? `settings-group-${groupId}` : `settings-section-${item.entryIds[0] ?? tab}`,
      group: groupId ? TAB_GROUPS[groupId] : null,
      items: [item],
    });
  }
  const railEntries = blocks.flatMap((block) => {
    const title = block.group?.title ?? block.items[0]?.section.title;
    return title ? [{ id: block.id, title, icon: block.group?.icon }] : [];
  });
  const list = (
    <div className="ade-settings-flow">
      {blocks.map((block) => (
        <section
          key={block.id}
          id={block.id}
          className="ade-settings-group-block"
          // The settings search hides a block whose cards all filtered out.
          data-settings-group={block.group?.title ?? block.id}
          data-tone={block.group?.tone}
        >
          {block.group ? (
            // A quiet mono label on a hairline: the sections under it carry
            // their own headings, so the block only needs to name the group.
            <header className="ade-settings-group-head" title={block.group.description}>
              <h2 className="ade-settings-group-title">{block.group.title}</h2>
            </header>
          ) : null}
          {block.items.map((item) => (
            <div key={item.entryIds.join(",")} className="ade-settings-flow-item">
              {item.node}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
  return (
    <SettingsColumn wide>
      {/* A rail of one is noise, and without one the grid would squeeze the
          list into the rail's column. */}
      {railEntries.length >= 2 ? (
        <div className="ade-settings-layout">
          <SettingsSectionRail entries={railEntries} />
          {list}
        </div>
      ) : list}
      {notice}
    </SettingsColumn>
  );
}

