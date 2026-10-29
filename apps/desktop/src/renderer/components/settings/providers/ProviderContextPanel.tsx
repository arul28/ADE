/**
 * The breakdown of a new chat's first context window on the page's machine:
 * the provider's own prompt, ADE's text, the user's setup and the project's
 * files, each with its size. Read-only; a person changes their own setup.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Plugs,
  PuzzlePiece,
  Robot,
  Sparkle,
  Stack,
  UserCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type {
  ProviderContextInventory,
  ProviderContextItem,
  ProviderContextItemKind,
  ProviderContextOwner,
  ProviderContextTiming,
} from "../../../../shared/types/providerContext";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import { formatTokens, ipcErrorMessage } from "../../../lib/format";
import { isMacPlatform, isWindowsPlatform } from "../../../lib/platform";
import { settingsRouteFor, settingsEntryById } from "../settingsManifest";
import { showToast } from "../../app/toast/toastStore";

function revealLabel(): string {
  if (isMacPlatform()) return "Show in Finder";
  if (isWindowsPlatform()) return "Show in Explorer";
  return "Show in folder";
}

/** Small buttons at the end of a row: open its file, or the ADE page that manages it. */
function RowActions({ item, canReveal }: { item: ProviderContextItem; canReveal: boolean }) {
  const navigate = useNavigate();
  const entry = item.settingsEntry ? settingsEntryById(item.settingsEntry) : null;
  const reveal = window.ade.ai?.revealProviderContextPath;
  const path = canReveal && typeof reveal === "function" ? item.path ?? null : null;
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
          onClick={() => {
            void reveal?.(path).catch((error: unknown) => {
              showToast({ tone: "error", title: `Could not show ${item.label}`, message: ipcErrorMessage(error) });
            });
          }}
        >
          <FolderOpen size={12} />
        </button>
      ) : null}
    </span>
  );
}

const OWNER_ORDER: ProviderContextOwner[] = ["harness", "ade", "user", "project"];

const KIND_ICON: Record<ProviderContextItemKind, React.ReactNode> = {
  "system-prompt": <Cpu size={14} />,
  instructions: <FileText size={14} />,
  memory: <Brain size={14} />,
  skills: <Sparkle size={14} />,
  skill: <Sparkle size={13} />,
  "mcp-server": <Plugs size={14} />,
  plugin: <PuzzlePiece size={14} />,
  rule: <ListChecks size={14} />,
  agent: <Robot size={14} />,
  other: <Circle size={14} />,
};

const TIMING_LABEL: Record<ProviderContextTiming, string> = {
  "every-request": "Every request",
  "chat-start": "Chat start",
  "on-demand": "When used",
};

const COVERAGE_LABEL = { good: "Most items", basic: "ADE's items" } as const;

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
  // Only a measured size is a real token count; the rest are counted from text.
  return item.sizeKind === "measured" ? value : `≈${value}`;
}

function tokenTitle(item: Pick<ProviderContextItem, "sizeKind">): string {
  switch (item.sizeKind) {
    case "exact": return "Estimated from the exact text ADE sends, at about 4 characters per token";
    case "estimated": return "Estimated from the file or setting, at about 4 characters per token";
    case "measured": return "From real chats on this machine";
    default: return "Not known before a chat starts";
  }
}

/** What an item adds to the start of a chat: an on-demand item adds nothing until it is used. */
function itemTokens(item: ProviderContextItem): number {
  return item.timing === "on-demand" ? 0 : item.tokens ?? 0;
}

function ContextRow({ item, canReveal, child = false }: { item: ProviderContextItem; canReveal: boolean; child?: boolean }) {
  const [open, setOpen] = useState(false);
  const children = item.children ?? [];
  return (
    <>
      <div className="ade-pv-ctx-row" data-child={child ? "true" : undefined}>
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
            {children.length ? <span className="ade-pv-ctx-row-count kit-num">{children.length}</span> : null}
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
        <RowActions item={item} canReveal={canReveal} />
      </div>
      {open ? children.map((entry) => <ContextRow key={entry.id} item={entry} canReveal={canReveal} child />) : null}
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
  // undefined while loading; null when this machine's ADE has no such list.
  const [inventory, setInventory] = useState<ProviderContextInventory | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The page stays mounted when the user picks another provider, so a slow
  // answer for the last one must not replace the current one.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const read = window.ade.ai?.getProviderContextInventory;
    if (typeof read !== "function") {
      setInventory(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await read({ provider: providerId }, pin);
      if (request !== requestRef.current) return;
      // No answer (ADE Web while its machine is away): say so and offer a retry.
      if (next) setInventory(next);
      else setLoadError("The machine did not answer.");
    } catch (error) {
      if (request !== requestRef.current) return;
      // An older ADE on that machine has no such action; the card stays away.
      if (isUnsupportedAdeActionError(error)) setInventory(null);
      else setLoadError(ipcErrorMessage(error));
    } finally {
      if (request === requestRef.current) setLoading(false);
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

  if (inventory === null && !loadError) return null;

  const listed = inventory?.listedTokens ?? 0;
  const total = inventory?.measured?.firstTurnTokens ?? listed;
  // The bar's whole: the measured size, or the listed sum when it is larger.
  const whole = Math.max(total, listed);
  const itemCount = inventory?.items.length ?? 0;

  return (
    <section className="kit-card" aria-label="Initial context window breakdown">
      <header className="kit-card-head">
        <Stack size={14} />
        Initial context window
        {inventory ? <span className="kit-card-head-count">{itemCount}</span> : null}
        {inventory ? <span className="ade-pv-ctx-coverage kit-tag">{COVERAGE_LABEL[inventory.coverage]}</span> : null}
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

      {!inventory ? (
        loadError ? (
          <div className="kit-card-body ade-pv-ctx-error" role="alert">
            <WarningCircle size={14} weight="fill" />
            <span>Could not read the list. {loadError}</span>
            <button type="button" className="kit-btn" onClick={() => void load()} disabled={loading}>Try again</button>
          </div>
        ) : (
          <div className="kit-card-body">
            <div className="ade-pv-ctx-skeleton" data-size="title" />
            <div className="ade-pv-ctx-skeleton" />
            <div className="ade-pv-ctx-skeleton" data-size="short" />
          </div>
        )
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
                    data-owner={group.owner}
                    style={{ width: `${(group.tokens / whole) * 100}%` }}
                  />
                ) : null))}
              </div>
            ) : null}
            <div className="ade-pv-ctx-legend">
              {groups.map((group) => (
                <span key={group.owner} data-owner={group.owner}>
                  <i />
                  {ownerLabel(group.owner, providerLabel)}
                  <b>{group.tokens > 0 ? formatTokens(group.tokens) : "—"}</b>
                  {whole > 0 && group.tokens > 0 ? <em>{Math.round((group.tokens / whole) * 100)}%</em> : null}
                </span>
              ))}
            </div>
          </div>

          <div className="kit-card-body" data-flush="true">
            {groups.map((group) => (
              <div key={group.owner} className="ade-pv-ctx-group" data-owner={group.owner}>
                <div className="ade-pv-ctx-group-head">
                  <span className="ade-pv-ctx-group-icon"><OwnerIcon owner={group.owner} logo={providerLogo} /></span>
                  {ownerLabel(group.owner, providerLabel)}
                  <span className="ade-pv-ctx-group-count">{group.items.length}</span>
                  <b>{group.tokens > 0 ? formatTokens(group.tokens) : ""}</b>
                </div>
                {[...group.items]
                  .sort((a, b) => itemTokens(b) - itemTokens(a))
                  .map((item) => <ContextRow key={item.id} item={item} canReveal={canReveal} />)}
              </div>
            ))}
          </div>

          <div className="ade-pv-ctx-foot">
            {/* A failed "Check again" keeps the last list and says so. */}
            {loadError ? <div className="ade-pv-ctx-foot-error" role="alert">Could not check again. {loadError}</div> : null}
            {inventory.coverageNote}
            {" · "}
            <span className="kit-num">{inventory.cwd}</span>
          </div>
        </>
      )}
    </section>
  );
}
