import type { AuthType, ProviderFamily } from "../../../../shared/modelRegistry";
import type { AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";
import type { AuthStatus, RailSelection } from "./ModelPickerRail";
import { ProviderEmptyState } from "./providerEmptyState";

export type ModelPickerEmptyStateProps = {
  selection: RailSelection;
  searchActive: boolean;
  opencodeBinaryInstalled: boolean;
  opencodeBinaryKnown: boolean;
  refreshingProvider?: AgentChatModelCatalogRefreshProvider | null;
  refreshErrorProvider?: AgentChatModelCatalogRefreshProvider | null;
  onRetryRefresh?: () => void;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onOpenSignIn?: (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void;
  getProviderLabel: (provider: AgentChatModelCatalogRefreshProvider) => string;
  isProviderReady: (status: AuthStatus | undefined) => boolean;
};

export function ModelPickerEmptyState({
  selection,
  searchActive,
  opencodeBinaryInstalled,
  opencodeBinaryKnown,
  refreshingProvider,
  refreshErrorProvider,
  onRetryRefresh,
  providerAuthStatus,
  onOpenSignIn,
  getProviderLabel,
  isProviderReady,
}: ModelPickerEmptyStateProps) {
  if (!searchActive && selection !== "favorites" && selection !== "recents") {
    const family = selection.slice("provider:".length) as ProviderFamily;
    if (refreshErrorProvider) {
      return (
        <ProviderRefreshError
          provider={refreshErrorProvider}
          onRetry={onRetryRefresh}
          getProviderLabel={getProviderLabel}
        />
      );
    }
    if (
      opencodeBinaryKnown
      && !opencodeBinaryInstalled
      && (family === "opencode" || family === "ollama" || family === "lmstudio")
    ) {
      return (
        <ProviderEmptyState
          mode="opencode-required"
          family={family}
          {...(onOpenSignIn ? { onOpenSignIn } : {})}
        />
      );
    }
    if (refreshingProvider) {
      const label = getProviderLabel(refreshingProvider);
      return (
        <div
          data-empty-state-mode="runtime-loading"
          data-refresh-provider={refreshingProvider}
          role="status"
          aria-live="polite"
          className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1.5 px-4 py-6 text-center"
        >
          <span className="text-[12px] font-semibold text-fg/80">Checking {label}</span>
          <span className="max-w-[260px] text-[11px] leading-relaxed text-muted-fg/60">
            Loading the cached catalog and refreshing it in the background.
          </span>
        </div>
      );
    }
    return (
      <ProviderEmptyState
        family={family}
        mode={isProviderReady(providerAuthStatus?.[family]) ? "discovery-empty" : "default"}
        {...(onOpenSignIn ? { onOpenSignIn } : {})}
      />
    );
  }

  let body = "No models match this view.";
  if (searchActive) body = "No models match your search.";
  else if (selection === "favorites") body = "Star a model to pin it here.";
  else if (selection === "recents") body = "Models you use will appear here.";
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <span className="text-[11px] font-medium text-muted-fg/65">{body}</span>
    </div>
  );
}

export function ProviderRefreshError({
  provider,
  onRetry,
  getProviderLabel,
}: {
  provider: AgentChatModelCatalogRefreshProvider;
  onRetry?: () => void;
  getProviderLabel: (provider: AgentChatModelCatalogRefreshProvider) => string;
}) {
  const label = getProviderLabel(provider);
  return (
    <div
      data-empty-state-mode="runtime-error"
      data-refresh-provider={provider}
      role="alert"
      aria-live="assertive"
      className="mx-0.5 mb-1 flex items-center justify-between gap-2 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-2 py-1.5 text-[10px]"
    >
      <span className="min-w-0 truncate text-amber-100/80">Couldn’t refresh {label} models; cached results may be stale.</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-amber-300/25 px-1.5 py-0.5 font-semibold text-amber-100/90 hover:bg-amber-300/[0.10]"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
