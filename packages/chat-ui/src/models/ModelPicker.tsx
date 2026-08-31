/**
 * Model picker: a provider rail on the left, a searchable model list on the
 * right.
 *
 * PROVENANCE: the rail/search/list structure follows
 * `apps/desktop/src/renderer/components/shared/ModelPicker/` (ModelPickerRail,
 * ModelPickerContent, ModelListRow) — including the vertical rail with
 * per-provider status dots and arrow-key roving focus. The data layer is
 * rewritten against `AdeChatClient` rather than ADE's runtime catalog cache,
 * and ADE-only affordances (favourites, recents, reasoning-effort, per-surface
 * defaults, cloud launch) are out of scope for this package.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdeProviders } from "../context/AdeChatContext";
import type { AdeChatClient, ModelDescriptor, ProviderStatus } from "../sdkTypes";
import {
  groupModelsByProvider,
  isModelSelectable,
  type ProviderModelGroup,
} from "./modelSearch";

export type ModelPickerProps = {
  /** Selected model id. */
  value?: string | null;
  onChange: (model: ModelDescriptor) => void;
  /** Supply data directly; omit to read from the client/context. */
  models?: readonly ModelDescriptor[];
  providers?: readonly ProviderStatus[];
  /** Used only when `models`/`providers` are omitted. */
  client?: AdeChatClient;
  /** Hide the search field. */
  searchable?: boolean;
  /** Rendered under a provider group that cannot be selected from. */
  renderProviderNotice?: (status: ProviderStatus | null, providerId: string) => React.ReactNode;
  className?: string;
};

type ProviderStatusDot = "ok" | "unauthed" | "missing";

function statusDot(status: ProviderStatus | null): ProviderStatusDot {
  if (!status || !status.installed) return "missing";
  return status.authenticated ? "ok" : "unauthed";
}

export function ModelPicker(props: ModelPickerProps) {
  const usesContext = props.models === undefined || props.providers === undefined;
  return usesContext ? <ConnectedModelPicker {...props} /> : <ModelPickerView {...props} />;
}

function ConnectedModelPicker(props: ModelPickerProps) {
  const { statuses, models, loading, error } = useAdeProviders(props.client);
  if (error) {
    return <div className="adechat-modelpicker-empty">Could not load models: {error.message}</div>;
  }
  if (loading && models.length === 0) {
    return <div className="adechat-modelpicker-empty">Loading models…</div>;
  }
  return (
    <ModelPickerView
      {...props}
      models={props.models ?? models}
      providers={props.providers ?? statuses}
    />
  );
}

function ModelPickerView({
  value,
  onChange,
  models = [],
  providers = [],
  searchable = true,
  renderProviderNotice,
  className,
}: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const railRefs = useRef(new Map<string, HTMLButtonElement>());

  const groups = useMemo(
    () => groupModelsByProvider({ models, statuses: providers, query }),
    [models, providers, query],
  );

  // The rail selection follows the selected model on first paint, then the
  // first available group if that provider disappears from the results.
  const activeProvider = useMemo(() => {
    if (selectedProvider && groups.some((group) => group.providerId === selectedProvider)) {
      return selectedProvider;
    }
    const selectedModel = models.find((model) => model.id === value);
    if (selectedModel && groups.some((group) => group.providerId === selectedModel.providerId)) {
      return selectedModel.providerId;
    }
    return groups[0]?.providerId ?? null;
  }, [groups, models, selectedProvider, value]);

  // A search that filters the active provider away must not strand the list.
  useEffect(() => {
    if (selectedProvider && !groups.some((group) => group.providerId === selectedProvider)) {
      setSelectedProvider(null);
    }
  }, [groups, selectedProvider]);

  const handleRailKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const last = Math.max(0, groups.length - 1);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : Math.min(Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)), last);
      const next = groups[nextIndex];
      if (!next) return;
      setSelectedProvider(next.providerId);
      railRefs.current.get(next.providerId)?.focus();
    },
    [groups],
  );

  const activeGroup = groups.find((group) => group.providerId === activeProvider) ?? null;

  return (
    <div className={["adechat-modelpicker", className].filter(Boolean).join(" ")}>
      <div className="adechat-modelpicker-rail" role="tablist" aria-orientation="vertical">
        {groups.map((group, index) => (
          <button
            key={group.providerId}
            ref={(node) => {
              if (node) railRefs.current.set(group.providerId, node);
              else railRefs.current.delete(group.providerId);
            }}
            type="button"
            role="tab"
            className="adechat-modelpicker-railbutton"
            aria-selected={group.providerId === activeProvider}
            tabIndex={group.providerId === activeProvider ? 0 : -1}
            onClick={() => setSelectedProvider(group.providerId)}
            onKeyDown={(event) => handleRailKeyDown(event, index)}
          >
            <span
              className="adechat-status-dot"
              data-status={statusDot(group.status)}
              aria-hidden="true"
            />
            <span className="adechat-modelpicker-raillabel">{group.providerLabel}</span>
          </button>
        ))}
        {groups.length === 0 ? (
          <div className="adechat-modelpicker-empty">No providers</div>
        ) : null}
      </div>

      <div className="adechat-modelpicker-main">
        {searchable ? (
          <input
            className="adechat-modelpicker-search"
            type="search"
            value={query}
            placeholder="Search models"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search models"
          />
        ) : null}
        <ul className="adechat-modelpicker-list" role="listbox" aria-label="Models">
          {activeGroup ? (
            <ModelGroupRows
              group={activeGroup}
              selectedId={value ?? null}
              onChange={onChange}
              {...(renderProviderNotice ? { renderProviderNotice } : {})}
            />
          ) : (
            <li className="adechat-modelpicker-empty">
              {query ? `No models match “${query}”.` : "No models available."}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function ModelGroupRows({
  group,
  selectedId,
  onChange,
  renderProviderNotice,
}: {
  group: ProviderModelGroup;
  selectedId: string | null;
  onChange: (model: ModelDescriptor) => void;
  renderProviderNotice?: (status: ProviderStatus | null, providerId: string) => React.ReactNode;
}) {
  const notice = !group.enabled ? renderProviderNotice?.(group.status, group.providerId) : null;
  return (
    <>
      <li className="adechat-modelpicker-group" aria-hidden="true">
        {group.providerLabel}
      </li>
      {notice ? <li>{notice}</li> : null}
      {group.models.map((model) => {
        const selectable = isModelSelectable(model, group.status);
        return (
          <li key={model.id}>
            <button
              type="button"
              role="option"
              className="adechat-modelpicker-row"
              aria-selected={model.id === selectedId}
              disabled={!selectable}
              title={
                selectable
                  ? model.description
                  : `${group.providerLabel} is not ready — sign in to use this model.`
              }
              onClick={() => onChange(model)}
            >
              <span className="adechat-modelpicker-rowname">{model.displayName}</span>
              {model.subProvider ? (
                <span className="adechat-modelpicker-rowmeta">{model.subProvider}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </>
  );
}
