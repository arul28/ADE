import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MODEL_PICKER_PROVIDER_ORDER, providerLabel } from "../../../../shared/modelCatalog";
import { getModelById, resolveProviderGroupForModel, type ProviderFamily } from "../../../../shared/modelRegistry";
import {
  pluginChatModelCapabilities,
  pluginChatProviderCapabilities,
} from "../../../../shared/plugins/chatCapabilities";
import {
  readPluginWebviewPickerRect,
  type PluginWebviewPickerAnchorRect,
} from "../../../../shared/plugins/webviewBridge";
import { useAppStore } from "../../../state/appStore";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { ModelPickerRail, type RailEntry, type RailSelection } from "../../shared/ModelPicker/ModelPickerRail";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import {
  PermissionModePicker,
  type PermissionModeIconKind,
  type PermissionModePickerOption,
  type PermissionModeTone,
} from "../../shared/PermissionModePicker";
import { LaneCombobox } from "../../terminals/LaneCombobox";
import {
  pluginWebviewPermissionField,
  resolvePluginWebviewPermissionFamily,
} from "./pluginWebviewPickerPolicy";
import {
  settlePluginWebviewPicker,
  usePluginWebviewPicker,
  type PluginWebviewPickerRequest,
} from "./pluginWebviewPickerStore";

/**
 * ADE's own pickers, drawn over the plugin page that asked.
 *
 * The five verbs share one host because a page may have only one standing
 * question, and because a client that can open the model list can open the
 * others. Null is dismissal. A missing provider or model is refused before
 * this mounts — see {@link refusePluginWebviewPicker}.
 *
 * ## Stacking
 *
 * The dimmer sits at z-50 so ADE's own portalled lists (the model picker at
 * 100, the lane combobox at 9999, the permission menu at 1500) stay clickable
 * above it. A z-1400 sheet would bury those lists the way a second picker
 * would, which is the thing this host exists not to invent.
 */

const PICKER_FAMILY_BY_GROUP: Record<(typeof MODEL_PICKER_PROVIDER_ORDER)[number], ProviderFamily> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  copilot: "github-copilot",
  grok: "xai",
  droid: "factory",
  kimi: "moonshot",
  qwen: "qwen",
  ollama: "ollama",
  lmstudio: "lmstudio",
};

function clampPickerAnchor(
  top: number,
  left: number,
  size?: { width?: number; height?: number },
): { top: number; left: number; width?: number; height?: number } {
  return {
    top: Math.min(Math.max(12, top), Math.max(12, window.innerHeight - 72)),
    left: Math.min(Math.max(12, left), Math.max(12, window.innerWidth - 280)),
    ...(size?.width && size.width > 0 ? { width: size.width } : {}),
    ...(size?.height && size.height > 0 ? { height: size.height } : {}),
  };
}

function guestBox(guestKey: string): DOMRect | null {
  const escaped = guestKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const node = document.querySelector(`[data-plugin-webview-guest="${escaped}"]`);
  const rect = node?.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

function pickerAnchor(request: PluginWebviewPickerRequest): {
  top: number;
  left: number;
  width?: number;
  height?: number;
} {
  const guest = guestBox(request.guestKey);
  const local = readPluginWebviewPickerRect(request.args.rect);
  const size: Pick<PluginWebviewPickerAnchorRect, "width" | "height"> | undefined = local
    ? { width: local.width, height: local.height }
    : undefined;
  if (guest && local) {
    return clampPickerAnchor(guest.top + local.top, guest.left + local.left, size);
  }
  if (!guest) {
    return clampPickerAnchor(
      Math.round(window.innerHeight / 2) - 24,
      Math.round(window.innerWidth / 2) - 140,
    );
  }
  // Center in the guest. Pinning to its top-left is why Linear/Review pickers
  // jumped to the corner of the page instead of the chip that asked.
  return clampPickerAnchor(
    guest.top + guest.height / 2 - 24,
    guest.left + guest.width / 2 - 140,
  );
}

function modelPickAnswer(modelId: string, fastMode: boolean): Record<string, unknown> {
  const descriptor = getModelById(modelId);
  const provider = descriptor ? resolveProviderGroupForModel(descriptor) : undefined;
  const modelCap = pluginChatModelCapabilities().find((entry) => entry.id === modelId);
  const family = resolvePluginWebviewPermissionFamily(provider ?? modelCap?.provider);
  const providerCap = family
    ? pluginChatProviderCapabilities().find((entry) => entry.provider === family)
    : undefined;
  const defaultPermissionMode = providerCap?.defaultPermissionMode;
  const defaultPermissionLabel = providerCap?.permissionModes
    .find((mode) => mode.value === defaultPermissionMode)?.label;
  const defaultReasoningEffort = modelCap?.defaultReasoningEffort ?? null;
  const defaultReasoningEffortLabel = defaultReasoningEffort
    ? modelCap?.reasoningEfforts.find((entry) => entry.effort === defaultReasoningEffort)?.label
      ?? defaultReasoningEffort
    : null;
  return {
    modelId,
    fastMode,
    ...(provider ? { provider } : {}),
    label: descriptor?.displayName ?? modelCap?.label ?? modelId,
    ...(defaultPermissionMode
      ? {
        defaultPermissionMode,
        defaultPermissionLabel: defaultPermissionLabel ?? defaultPermissionMode,
      }
      : {}),
    defaultReasoningEffort,
    ...(defaultReasoningEffortLabel ? { defaultReasoningEffortLabel } : {}),
  };
}

function AutoOpen({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = ref.current?.querySelector("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    button.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

function permissionPresentation(value: string): Pick<PermissionModePickerOption, "tone" | "icon" | "triggerLabel"> {
  switch (value) {
    case "default":
    case "read-only":
    case "ask":
      return { tone: "green", icon: "manual" };
    case "auto":
    case "auto-medium":
      return { tone: "amber", icon: "auto" };
    case "auto-low":
      return { tone: "green", icon: "edit" };
    case "acceptEdits":
      return { tone: "amber", icon: "edit", triggerLabel: "Edits" };
    case "edit":
      return { tone: "amber", icon: "edit", triggerLabel: "Edit" };
    case "plan":
      return { tone: "purple", icon: "plan", triggerLabel: "Plan" };
    case "bypassPermissions":
    case "full-auto":
    case "auto-high":
      return { tone: "red", icon: "full" };
    case "agent":
      return { tone: "blue", icon: "agent" };
    case "config-toml":
      return { tone: "slate", icon: "config" };
    case "agi":
      return { tone: "purple", icon: "agi", triggerLabel: "AGI" };
    default: {
      const tone: PermissionModeTone = "slate";
      const icon: PermissionModeIconKind = "manual";
      return { tone, icon };
    }
  }
}

function ModelPick({ request }: { request: PluginWebviewPickerRequest }) {
  const value = typeof request.args.value === "string" ? request.args.value : "";
  const available = Array.isArray(request.args.availableModelIds)
    ? request.args.availableModelIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const [fastMode, setFastMode] = useState(false);
  return (
    <ModelPicker
      value={value}
      surfaceKey={`plugin-webview:${request.guestKey}:${request.token}`}
      availableModelIds={available}
      constrainToAvailableModelIds={Boolean(available)}
      fastMode={fastMode}
      onFastModeChange={setFastMode}
      openRequestKey={request.token}
      onChange={(modelId, options) => {
        settlePluginWebviewPicker(
          modelPickAnswer(modelId, options?.fastMode === true || fastMode),
          request.token,
        );
      }}
    />
  );
}

function LanePick({ request }: { request: PluginWebviewPickerRequest }) {
  const lanes = useAppStore((state) => state.lanes);
  const value = typeof request.args.value === "string" ? request.args.value : "";
  return (
    <AutoOpen>
      <LaneCombobox
        lanes={lanes}
        value={value}
        compact
        aria-label="Select lane"
        onChange={(laneId) => {
          const lane = lanes.find((entry) => entry.id === laneId);
          settlePluginWebviewPicker(
            lane ? { laneId: lane.id, name: lane.name } : null,
            request.token,
          );
        }}
      />
    </AutoOpen>
  );
}

function PermissionPick({ request }: { request: PluginWebviewPickerRequest }) {
  const family = resolvePluginWebviewPermissionFamily(request.args.provider);
  const capability = family
    ? pluginChatProviderCapabilities().find((entry) => entry.provider === family)
    : null;
  const options = useMemo<PermissionModePickerOption[]>(
    () => (capability?.permissionModes ?? []).map((mode) => ({
      value: mode.value,
      label: mode.label,
      detail: mode.detail,
      ...permissionPresentation(mode.value),
    })),
    [capability],
  );
  const selected = typeof request.args.value === "string" && options.some((option) => option.value === request.args.value)
    ? request.args.value
    : (capability?.defaultPermissionMode ?? options[0]?.value ?? "");

  // Empty lists are refused before this mounts — see `refusePluginWebviewPicker`.
  if (!family || !capability || options.length === 0) return null;

  return (
    <AutoOpen>
      <PermissionModePicker
        ariaLabel="Permission mode"
        selectedValue={selected}
        options={options}
        menuLayerClassName="z-[1500]"
        onSelect={(value) => {
          const option = options.find((entry) => entry.value === value);
          settlePluginWebviewPicker(
            {
              provider: family,
              field: pluginWebviewPermissionField(family),
              value,
              label: option?.label ?? value,
            },
            request.token,
          );
        }}
      />
    </AutoOpen>
  );
}

function ReasoningPick({ request }: { request: PluginWebviewPickerRequest }) {
  const modelId = typeof request.args.model === "string" ? request.args.model.trim() : "";
  const value = request.args.value === null
    ? null
    : typeof request.args.value === "string" ? request.args.value : null;
  const holderRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!holderRef.current?.querySelector("button")) {
      settlePluginWebviewPicker(null, request.token);
      return;
    }
    const button = holderRef.current.querySelector("button");
    if (button instanceof HTMLButtonElement && !button.disabled) button.click();
  }, [modelId, request.token]);

  return (
    <div ref={holderRef}>
      <ReasoningEffortPicker
        modelId={modelId}
        reasoningEffort={value}
        onChange={(effort) => {
          const modelCap = pluginChatModelCapabilities().find((entry) => entry.id === modelId);
          const label = effort
            ? modelCap?.reasoningEfforts.find((entry) => entry.effort === effort)?.label ?? effort
            : "No reasoning";
          settlePluginWebviewPicker({ modelId, effort, label }, request.token);
        }}
      />
    </div>
  );
}

function ProviderPick({ request }: { request: PluginWebviewPickerRequest }) {
  const entries = useMemo<RailEntry[]>(
    () => MODEL_PICKER_PROVIDER_ORDER.map((group) => {
      const family = PICKER_FAMILY_BY_GROUP[group];
      return { kind: "provider", family, label: providerLabel(family) };
    }),
    [],
  );
  const requested = typeof request.args.value === "string" ? request.args.value.trim() : "";
  const selected: RailSelection = requested.startsWith("provider:")
    ? requested as RailSelection
    : requested
      ? `provider:${requested as ProviderFamily}`
      : `provider:${entries[0]?.kind === "provider" ? entries[0].family : "anthropic"}`;

  return (
    <div
      className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)]"
      data-plugin-webview-provider-rail
    >
      <ModelPickerRail
        entries={entries}
        selected={selected}
        onSelect={(selection) => {
          if (!selection.startsWith("provider:")) return;
          settlePluginWebviewPicker(
            { provider: selection.slice("provider:".length) },
            request.token,
          );
        }}
      />
    </div>
  );
}

function PickerBody({ request }: { request: PluginWebviewPickerRequest }) {
  switch (request.verb) {
    case "ui.pickModel":
      return <ModelPick request={request} />;
    case "ui.pickLane":
      return <LanePick request={request} />;
    case "ui.pickPermissionMode":
      return <PermissionPick request={request} />;
    case "ui.pickReasoningEffort":
      return <ReasoningPick request={request} />;
    case "ui.pickProvider":
      return <ProviderPick request={request} />;
    default: {
      const unknown: never = request.verb;
      return unknown;
    }
  }
}

export function PluginWebviewPickerHost() {
  const request = usePluginWebviewPicker();
  const token = request?.token ?? null;
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width?: number;
    height?: number;
  }>({ top: 24, left: 24 });

  useLayoutEffect(() => {
    if (!request) return;
    setAnchor(pickerAnchor(request));
  }, [request]);

  useEffect(() => {
    if (token === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settlePluginWebviewPicker(null, token);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token]);

  if (!request) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.35)",
      }}
      data-plugin-webview-picker={request.verb}
      onMouseDown={() => settlePluginWebviewPicker(null, request.token)}
    >
      <div
        style={{
          position: "absolute",
          top: anchor.top,
          left: anchor.left,
          ...(anchor.width ? { width: anchor.width } : {}),
          ...(anchor.height ? { minHeight: anchor.height } : {}),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PickerBody request={request} />
      </div>
    </div>
  );
}

export default PluginWebviewPickerHost;
