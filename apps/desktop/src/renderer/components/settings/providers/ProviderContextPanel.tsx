/**
 * The breakdown of a new chat's first context window on the page's machine:
 * the provider's own prompt, ADE's text, the user's setup and the project's
 * files, each with its size. Read-only; a person changes their own setup.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsClockwise,
  Brain,
  CaretDown,
  CaretRight,
  Circle,
  Cpu,
  FileText,
  FolderOpen,
  FolderSimple,
  GearSix,
  Hexagon,
  ListChecks,
  NotePencil,
  Plugs,
  PuzzlePiece,
  Robot,
  Sparkle,
  Stack,
  UserCircle,
  Wrench,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type {
  ProviderContextInventory,
  ProviderContextItem,
  ProviderContextItemKind,
  ProviderContextOwner,
  ProviderContextTiming,
} from "../../../../shared/types/providerContext";
import { formatTokens } from "../../../lib/format";
import { isMacPlatform, isWindowsPlatform } from "../../../lib/platform";
import { settingsRouteFor, settingsEntryById } from "../settingsManifest";

/** Whether this window can open the inventory's files: only on the computer that built it. */
const RevealContext = createContext(false);

function revealLabel(): string {
  if (isMacPlatform()) return "Show in Finder";
  if (isWindowsPlatform()) return "Show in Explorer";
  return "Show in folder";
}

/** Small buttons at the end of a row: open its file, or the ADE page that manages it. */
function RowActions({ item }: { item: ProviderContextItem }) {
  const canReveal = useContext(RevealContext);
  const navigate = useNavigate();
  const entry = item.settingsEntry ? settingsEntryById(item.settingsEntry) : null;
  const path = canReveal ? item.path ?? null : null;
  if (!path && !entry) return <span />;
  return (
    <span className="ade-pv-ctx-actions">
      {entry ? (
        <button
          type="button"
          className="ade-pv-ctx-action"
          title={`Open ${entry.label} in ADE Settings`}
          aria-label={`Open ${entry.label} in ADE Settings`}
          onClick={() => navigate(settingsRouteFor(entry.id))}
        >
          <GearSix size={12} />
        </button>
      ) : null}
      {path ? (
        <button
          type="button"
          className="ade-pv-ctx-action"
          title={`${revealLabel()}: ${item.setIn ?? item.source ?? path}`}
          aria-label={`${revealLabel()}: ${item.label}`}
          onClick={() => void window.ade.app.revealPath(path).catch(() => {})}
        >
          <FolderOpen size={12} />
        </button>
      ) : null}
    </span>
  );
}

const OWNER_ORDER: ProviderContextOwner[] = ["harness", "ade", "user", "project"];

/**
 * One color per owner. The provider's own part wears its brand; ADE, the
 * user's setup and the project each keep a fixed color on every page, so the
 * same part reads the same on Claude and on Codex.
 */
const OWNER_COLOR: Record<ProviderContextOwner, string> = {
  harness: "var(--provider-accent)",
  ade: "#2DD4BF",
  user: "#F472B6",
  project: "#FBBF24",
};

const KIND_ICON: Record<ProviderContextItemKind, React.ReactNode> = {
  "system-prompt": <Cpu size={14} />,
  instructions: <FileText size={14} />,
  memory: <Brain size={14} />,
  skills: <Sparkle size={14} />,
  skill: <Sparkle size={13} />,
  "mcp-server": <Plugs size={14} />,
  tools: <Wrench size={14} />,
  plugin: <PuzzlePiece size={14} />,
  rule: <ListChecks size={14} />,
  agent: <Robot size={14} />,
  notes: <NotePencil size={14} />,
  other: <Circle size={14} />,
};

const TIMING_LABEL: Record<ProviderContextTiming, string> = {
  "every-request": "Every request",
  "chat-start": "Chat start",
  "on-demand": "When used",
};

const COVERAGE_LABEL = { full: "Full list", good: "Most items", basic: "ADE's items" } as const;

function OwnerIcon({ owner, logo }: { owner: ProviderContextOwner; logo: React.ReactNode }) {
  switch (owner) {
    case "harness": return <>{logo}</>;
    case "ade": return <Hexagon size={13} weight="fill" />;
    case "user": return <UserCircle size={14} weight="fill" />;
    case "project": return <FolderSimple size={14} weight="fill" />;
  }
}

function ownerLabel(owner: ProviderContextOwner, providerLabel: string): string {
  switch (owner) {
    case "harness": return `${providerLabel} itself`;
    case "ade": return "ADE";
    case "user": return "Your setup";
    case "project": return "This project";
  }
}

function tokenText(item: Pick<ProviderContextItem, "tokens" | "sizeKind">): string {
  if (item.tokens == null || item.sizeKind === "unknown") return "—";
  const value = formatTokens(item.tokens);
  return item.sizeKind === "exact" ? value : `≈${value}`;
}

function tokenTitle(item: Pick<ProviderContextItem, "sizeKind">): string {
  switch (item.sizeKind) {
    case "exact": return "Counted from the exact text ADE sends";
    case "estimated": return "Estimated from the file or setting";
    case "measured": return "From real chats on this machine";
    default: return "Not known before a chat starts";
  }
}

function itemTokens(item: ProviderContextItem): number {
  return item.tokens ?? 0;
}

function ContextRow({ item, color, child = false }: { item: ProviderContextItem; color: string; child?: boolean }) {
  const [open, setOpen] = useState(false);
  const children = item.children ?? [];
  return (
    <>
      <div className="ade-pv-ctx-row" data-child={child ? "true" : undefined} style={{ ["--owner" as string]: color }}>
        <span className="ade-pv-ctx-row-icon">
          {children.length ? (
            <button
              type="button"
              className="ade-pv-ctx-toggle"
              aria-expanded={open}
              aria-label={open ? `Hide the items in ${item.label}` : `Show the items in ${item.label}`}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
            </button>
          ) : KIND_ICON[item.kind]}
        </span>
        <div className="ade-pv-ctx-row-main">
          <div className="ade-pv-ctx-row-label">
            <span title={item.label}>{item.label}</span>
            {children.length ? <span className="kit-num" style={{ fontSize: 10.5, opacity: 0.6 }}>{children.length}</span> : null}
          </div>
          {item.source ? <div className="ade-pv-ctx-row-source" title={item.source}>{item.source}</div> : null}
          {item.setIn ? (
            <div className="ade-pv-ctx-row-setin" title={item.setIn}>
              <GearSix size={10} />
              <span>Set in <b>{item.setIn}</b></span>
            </div>
          ) : null}
          {item.detail ? <div className="ade-pv-ctx-row-detail">{item.detail}</div> : null}
        </div>
        {/* Most items ride every request; only the exceptions say when. */}
        {child || item.timing === "every-request" ? <span /> : (
          <span className="ade-pv-ctx-timing" data-timing={item.timing}>{TIMING_LABEL[item.timing]}</span>
        )}
        <span className="ade-pv-ctx-tokens" data-kind={item.sizeKind} title={tokenTitle(item)}>{tokenText(item)}</span>
        <RowActions item={item} />
      </div>
      {open ? children.map((entry) => <ContextRow key={entry.id} item={entry} color={color} child />) : null}
    </>
  );
}

export function ProviderContextPanel({
  providerId,
  providerLabel,
  providerLogo,
  pin,
  canReveal,
}: {
  providerId: string;
  providerLabel: string;
  /** The provider's small mark, for its own part of the breakdown. */
  providerLogo: React.ReactNode;
  pin: OpenProjectBinding | null;
  /** True when the page shows this computer, so its files can be opened here. */
  canReveal: boolean;
}) {
  const [inventory, setInventory] = useState<ProviderContextInventory | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const read = window.ade.ai?.getProviderContextInventory;
    if (typeof read !== "function") {
      setInventory(null);
      return;
    }
    setLoading(true);
    try {
      setInventory((await read({ provider: providerId }, pin)) ?? null);
    } catch {
      // An older brain has no such action; the card stays away.
      setInventory(null);
    } finally {
      setLoading(false);
    }
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, pin?.key]);

  useEffect(() => {
    setInventory(undefined);
    void load();
  }, [load]);

  const groups = useMemo(() => {
    if (!inventory) return [];
    return OWNER_ORDER
      .map((owner) => {
        const items = inventory.items.filter((item) => item.owner === owner);
        return { owner, items, tokens: items.reduce((sum, item) => sum + itemTokens(item), 0) };
      })
      .filter((group) => group.items.length > 0);
  }, [inventory]);

  if (inventory === null) return null;

  const listed = groups.reduce((sum, group) => sum + group.tokens, 0);
  const total = inventory?.measured?.firstTurnTokens ?? listed;
  const itemCount = inventory?.items.length ?? 0;

  return (
    <section className="kit-card" aria-label="Initial context window breakdown">
      <header className="kit-card-head">
        <Stack size={14} />
        Initial context window
        {inventory ? <span className="kit-card-head-count">{itemCount}</span> : null}
        {inventory ? <span className="kit-tag" style={{ marginLeft: 8 }}>{COVERAGE_LABEL[inventory.coverage]}</span> : null}
        <button
          type="button"
          className="kit-card-head-action"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Check again"
          title="Check again"
        >
          <ArrowsClockwise size={13} />
        </button>
      </header>

      {inventory === undefined ? (
        <div className="kit-card-body">
          <div className="ade-pv-ctx-skeleton" style={{ width: "40%", height: 22 }} />
          <div className="ade-pv-ctx-skeleton" />
          <div className="ade-pv-ctx-skeleton" style={{ width: "70%" }} />
        </div>
      ) : (
        <>
          <div className="kit-card-body">
            <div className="ade-pv-ctx-total">
              <div>
                <b className="kit-num">{inventory.measured ? formatTokens(total) : `≈${formatTokens(total)}`}</b>
                <small>
                  {inventory.measured
                    ? `tokens before your first message · median of ${inventory.measured.sampleCount} chats ${inventory.measured.scope === "project" ? "in this project" : "on this machine"}`
                    : "tokens listed before your first message · no chats measured here yet"}
                </small>
              </div>
            </div>
            {total > 0 ? (
              <div className="ade-pv-ctx-bar" role="img" aria-label="Share of the initial context window by owner">
                {groups.map((group) => (group.tokens > 0 ? (
                  <i
                    key={group.owner}
                    title={`${ownerLabel(group.owner, providerLabel)}: ${formatTokens(group.tokens)}`}
                    style={{ width: `${(group.tokens / Math.max(total, listed)) * 100}%`, ["--owner" as string]: OWNER_COLOR[group.owner] }}
                  />
                ) : null))}
              </div>
            ) : null}
            <div className="ade-pv-ctx-legend">
              {groups.map((group) => (
                <span key={group.owner} style={{ ["--owner" as string]: OWNER_COLOR[group.owner] }}>
                  <i />
                  {ownerLabel(group.owner, providerLabel)}
                  <b>{group.tokens > 0 ? formatTokens(group.tokens) : "—"}</b>
                  {total > 0 && group.tokens > 0 ? <em>{Math.round((group.tokens / Math.max(total, listed)) * 100)}%</em> : null}
                </span>
              ))}
            </div>
          </div>

          <RevealContext.Provider value={canReveal}>
          <div className="kit-card-body" data-flush="true">
            {groups.map((group) => (
              <div key={group.owner} className="ade-pv-ctx-group" style={{ ["--owner" as string]: OWNER_COLOR[group.owner] }}>
                <div className="ade-pv-ctx-group-head">
                  <span className="ade-pv-ctx-group-icon"><OwnerIcon owner={group.owner} logo={providerLogo} /></span>
                  {ownerLabel(group.owner, providerLabel)}
                  <span className="ade-pv-ctx-group-count">{group.items.length}</span>
                  <b>{group.tokens > 0 ? formatTokens(group.tokens) : ""}</b>
                </div>
                {[...group.items]
                  .sort((a, b) => itemTokens(b) - itemTokens(a))
                  .map((item) => <ContextRow key={item.id} item={item} color={OWNER_COLOR[group.owner]} />)}
              </div>
            ))}
          </div>
          </RevealContext.Provider>

          <div className="ade-pv-ctx-foot">
            {inventory.coverageNote}
            {inventory.cwd ? <> · <span className="kit-num">{inventory.cwd}</span></> : null}
          </div>
        </>
      )}
    </section>
  );
}
