import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Broom,
  Gauge,
  HardDrives,
  Heartbeat,
  Timer,
} from "@phosphor-icons/react";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { SessionLifecycleSection } from "../SessionLifecycleSection";
import { ProjectSection } from "../ProjectSection";
import { resolveSettingsHash } from "../settingsManifest";
import { useSettingsSearchAnchors } from "../settingsSearchContext";
import { HEALTH_TABS, healthTabForAnchor, isHealthTabId, issuesNeedingAttention, type HealthTabId } from "./healthModel";
import { useHealthData } from "./useHealthData";
import { HealthOverview } from "./HealthOverview";
import { HealthSpace } from "./HealthSpace";
import { HealthCleanups } from "./HealthCleanups";
import { HealthService } from "./HealthService";
import "../machineSettings.css";
import "./health.css";

const TAB_ICONS: Record<HealthTabId, React.ReactNode> = {
  overview: <Heartbeat size={14} weight="duotone" />,
  space: <HardDrives size={14} weight="duotone" />,
  cleanups: <Broom size={14} weight="duotone" />,
  sessions: <Timer size={14} weight="duotone" />,
  service: <Gauge size={14} weight="duotone" />,
};

/** `?health=<tab>`: which inner tab is open, so a reload or a link keeps it. */
const HEALTH_PARAM = "health";

function decodeHash(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The inner tab a URL asks for: a card's `#anchor` wins over `?health=`. */
function requestedTab(search: string, hash: string): HealthTabId | null {
  if (hash) {
    const entry = resolveSettingsHash(decodeHash(hash));
    const fromAnchor = healthTabForAnchor(entry?.anchor ?? decodeHash(hash));
    if (fromAnchor) return fromAnchor;
  }
  const param = new URLSearchParams(search).get(HEALTH_PARAM);
  return isHealthTabId(param) ? param : null;
}

/**
 * Settings → Health: one page for project issues, disk space, cleanups,
 * sessions and the background service, with real tabs down the left (only the
 * open tab is mounted). It replaces Settings → Diagnostics and keeps its tab
 * id, `storage`, so old links and `#storage` / `#diagnostics` /
 * `#lane-storage-rules` / `#session-lifecycle` hashes land on the right tab.
 *
 * The data is read once when the page opens (storage snapshot, project
 * report, and on this computer the service diagnostics) and again on demand.
 * Every runtime call carries the Settings machine's pin.
 */
export function HealthPage() {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const location = useLocation();
  const navigate = useNavigate();
  const data = useHealthData(pin, isThisMachine);
  const [tab, setTab] = React.useState<HealthTabId>(() => requestedTab(location.search, location.hash) ?? "overview");

  // A link that names a card (a search result, a banner, the top bar) opens
  // the tab that holds it.
  React.useEffect(() => {
    const next = requestedTab(location.search, location.hash);
    if (next) setTab(next);
  }, [location.hash, location.search]);

  // Searching settings hides the cards that don't match. When the open tab
  // holds no match, open the tab that does instead of showing a blank one.
  const searchAnchors = useSettingsSearchAnchors();
  React.useEffect(() => {
    if (!searchAnchors || searchAnchors.length === 0) return;
    const withMatch = searchAnchors.map((anchor) => healthTabForAnchor(anchor)).filter((id): id is HealthTabId => id != null);
    setTab((current) => (withMatch.length === 0 || withMatch.includes(current) ? current : withMatch[0]!));
  }, [searchAnchors]);

  const openTab = React.useCallback((next: HealthTabId) => {
    setTab(next);
    const params = new URLSearchParams(location.search);
    params.set(HEALTH_PARAM, next);
    // Drop the card hash: it would pull the page back to the tab it names.
    navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const attention = issuesNeedingAttention(data.report.report).length;

  return (
    <div className="ade-health-layout">
      <nav className="ade-health-tabs" aria-label="Health" role="tablist" aria-orientation="vertical">
        {HEALTH_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`health-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls="health-tab-panel"
            className="ade-health-tab"
            onClick={() => openTab(entry.id)}
          >
            <span aria-hidden className="ade-health-tab-icon">{TAB_ICONS[entry.id]}</span>
            <span className="ade-health-tab-label">{entry.label}</span>
            {entry.id === "overview" && attention > 0 ? (
              <span className="ade-health-tab-count kit-num" aria-label={`${attention} need attention`}>{attention}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="ade-health-panel" role="tabpanel" id="health-tab-panel" aria-labelledby={`health-tab-${tab}`}>
        {tab === "overview" ? <HealthOverview data={data} onOpenTab={openTab} /> : null}
        {tab === "space" ? <HealthSpace data={data} /> : null}
        {tab === "cleanups" ? <HealthCleanups data={data} /> : null}
        {tab === "sessions" ? (
          <div className="ade-modern-sections">
            <SessionLifecycleSection />
            <ProjectSection />
          </div>
        ) : null}
        {tab === "service" ? <HealthService data={data} /> : null}
      </div>
    </div>
  );
}
