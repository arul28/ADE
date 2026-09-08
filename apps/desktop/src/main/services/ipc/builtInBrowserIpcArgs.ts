/**
 * Payload validation for every `ade.builtInBrowser.*` IPC channel.
 *
 * Extracted from `registerIpc.ts` (ADE's largest file) because none of this is
 * wiring: each parser is a pure function of `(value, channel)` whose only tie to
 * the registry was the logger it warns through. Living here they can be unit
 * tested directly — with no `ipcMain`, no Electron and no registration — which
 * is the point: these are the boundary checks between an untrusted renderer
 * payload and the browser service.
 *
 * @module ipc/builtInBrowserIpcArgs
 */
import type {
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserClaimArgs,
  BuiltInBrowserClearPermissionsArgs,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserExportHarArgs,
  BuiltInBrowserFindInPageArgs,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserSetDevToolsArgs,
  BuiltInBrowserSetEmulationArgs,
  BuiltInBrowserSetNetworkLoggingArgs,
  BuiltInBrowserSetZoomArgs,
  BuiltInBrowserStartPreviewStreamArgs,
  BuiltInBrowserStartRecordingArgs,
  BuiltInBrowserStopFindInPageArgs,
  BuiltInBrowserStopPreviewStreamArgs,
  BuiltInBrowserTabArgs,
  BuiltInBrowserTabTargetArgs,
} from "../../../shared/types/builtInBrowser";
// The shared one, not a tenth copy. The two bodies agreed on every input, which
// is exactly how a divergence goes unnoticed later. `agentObservationNormalizers`
// is dependency-free by design, so importing it here adds nothing to the module.
import { isRecord } from "../../../shared/agentObservationNormalizers";

/**
 * Spread helper for "include this key only when the parse produced a value".
 * Replaces the `...(parse(x) === undefined ? {} : { k: parse(x) })` shape, which
 * ran every parse twice so the spread could be conditional.
 */
function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export type BuiltInBrowserIpcArgParsers = ReturnType<typeof createBuiltInBrowserIpcArgParsers>;

export function createBuiltInBrowserIpcArgParsers(args: {
  /** Called before the throw so the registry can log the rejection. */
  onInvalid: (channel: string, reason: string) => void;
}) {
  const onInvalid = args.onInvalid;

  const invalidBuiltInBrowserArg = (channel: string, reason: string): never => {
    onInvalid(channel, reason);
    throw new Error(`Invalid built-in browser payload: ${reason}`);
  };

  const builtInBrowserRecord = (value: unknown, channel: string, required = false): Record<string, unknown> => {
    if (value == null) {
      if (required) invalidBuiltInBrowserArg(channel, "payload object is required");
      return {};
    }
    if (!isRecord(value)) invalidBuiltInBrowserArg(channel, "payload must be an object");
    return value as Record<string, unknown>;
  };

  const builtInBrowserNumber = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { min?: number; max?: number } = {},
  ): number => {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalidBuiltInBrowserArg(channel, `${field} must be a finite number`);
    }
    const numberValue = value as number;
    if (options.min != null && numberValue < options.min) invalidBuiltInBrowserArg(channel, `${field} is below the minimum`);
    if (options.max != null && numberValue > options.max) invalidBuiltInBrowserArg(channel, `${field} is above the maximum`);
    return numberValue;
  };

  const parseBuiltInBrowserBoundsArgs = (value: unknown, channel: string): BuiltInBrowserBoundsArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const visibleValue = record.visible;
    if (typeof visibleValue !== "boolean") invalidBuiltInBrowserArg(channel, "visible must be a boolean");
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      x: builtInBrowserNumber(record, "x", channel, { min: 0, max: 100_000 }),
      y: builtInBrowserNumber(record, "y", channel, { min: 0, max: 100_000 }),
      width: builtInBrowserNumber(record, "width", channel, { min: 0, max: 100_000 }),
      height: builtInBrowserNumber(record, "height", channel, { min: 0, max: 100_000 }),
      visible: visibleValue as boolean,
      ...(record.scale === undefined || record.scale === null
        ? {}
        : { scale: builtInBrowserNumber(record, "scale", channel, { min: 0.05, max: 1 }) }),
    };
  };

  const parseBuiltInBrowserNavigateArgs = (value: unknown, channel: string): BuiltInBrowserNavigateArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const urlValue = record.url;
    if (typeof urlValue !== "string" || !urlValue.trim()) {
      invalidBuiltInBrowserArg(channel, "url must be a non-empty string");
    }
    const url = urlValue as string;
    if (url.length > 4096 || url.includes("\0")) {
      invalidBuiltInBrowserArg(channel, "url is invalid");
    }
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    const newTab = record.newTab === true ? true : undefined;
    const openPanel = optionalBoolean(record.openPanel);
    return { url, tabId, newTab, openPanel, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  function optionalBuiltInBrowserString(
    record: Record<string, unknown>,
    field: string,
    channel: string,
    maxLength: number,
  ): string | null | undefined {
    const value = record[field];
    if (value == null) return undefined;
    if (typeof value !== "string") return invalidBuiltInBrowserArg(channel, `${field} must be a string`);
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    if (trimmed.length > maxLength || trimmed.includes("\0")) return invalidBuiltInBrowserArg(channel, `${field} is invalid`);
    return trimmed;
  }

  function optionalBoolean(value: unknown): boolean | undefined {
    if (value === true) return true;
    if (value === false) return false;
    return undefined;
  }

  function optionalBuiltInBrowserNumber(
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { min?: number; max?: number } = {},
  ): number | undefined {
    if (record[field] == null) return undefined;
    return builtInBrowserNumber(record, field, channel, options);
  }

  const parseBuiltInBrowserProjectScopeArgs = (
    record: Record<string, unknown>,
    channel: string,
  ): BuiltInBrowserProjectScopeArgs => {
    const projectRoot = optionalBuiltInBrowserString(record, "projectRoot", channel, 4096);
    const tabCollection = optionalBuiltInBrowserString(record, "tabCollection", channel, 16);
    if (tabCollection && tabCollection !== "personal") {
      return invalidBuiltInBrowserArg(channel, "tabCollection is invalid");
    }
    if (tabCollection === "personal" && projectRoot) {
      return invalidBuiltInBrowserArg(channel, "tabCollection and projectRoot cannot both be set");
    }
    return {
      ...(projectRoot ? { projectRoot } : {}),
      ...(tabCollection === "personal" ? { tabCollection } : {}),
    };
  };

  const parseBuiltInBrowserProjectScopeInput = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserProjectScopeArgs =>
    parseBuiltInBrowserProjectScopeArgs(builtInBrowserRecord(value, channel, false), channel);

  const parseBuiltInBrowserClearPermissionsArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserClearPermissionsArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const origin = optionalBuiltInBrowserString(record, "origin", channel, 2048);
    const permission = optionalBuiltInBrowserString(record, "permission", channel, 128);
    return {
      ...(origin ? { origin } : {}),
      ...(permission ? { permission } : {}),
    };
  };

  const parseBuiltInBrowserClaimArgs = (record: Record<string, unknown>, channel: string): BuiltInBrowserClaimArgs => {
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    const laneId = optionalBuiltInBrowserString(record, "laneId", channel, 128);
    const chatSessionId = optionalBuiltInBrowserString(record, "chatSessionId", channel, 128);
    const force = optionalBoolean(record.force);
    const leaseTtlMs = optionalBuiltInBrowserNumber(record, "leaseTtlMs", channel, {
      min: 1_000,
      max: 60 * 60_000,
    });
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      ...(tabId ? { tabId } : {}),
      ...(laneId ? { laneId } : {}),
      ...(chatSessionId ? { chatSessionId } : {}),
      ...(force !== undefined ? { force } : {}),
      ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
    };
  };

  const parseBuiltInBrowserTabTargetRecord = (
    record: Record<string, unknown>,
    channel: string,
  ): BuiltInBrowserTabTargetArgs => {
    const sessionId = optionalBuiltInBrowserString(record, "sessionId", channel, 128);
    return {
      ...parseBuiltInBrowserClaimArgs(record, channel),
      ...(sessionId ? { sessionId } : {}),
    };
  };

  const parseBuiltInBrowserTabTargetArgs = (value: unknown, channel: string): BuiltInBrowserTabTargetArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    return parseBuiltInBrowserTabTargetRecord(record, channel);
  };

  const parseBuiltInBrowserTabArgs = (value: unknown, channel: string): BuiltInBrowserTabArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    if (!tabId) return invalidBuiltInBrowserArg(channel, "tabId must be a non-empty string");
    const openPanel = optionalBoolean(record.openPanel);
    return { ...parseBuiltInBrowserClaimArgs(record, channel), tabId, openPanel };
  };

  const parseBuiltInBrowserCreateTabArgs = (value: unknown, channel: string): BuiltInBrowserCreateTabArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const activate = record.activate === false ? false : undefined;
    const openPanel = optionalBoolean(record.openPanel);
    return { url, activate, openPanel, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  const parseBuiltInBrowserOpenPanelArgs = (value: unknown, channel: string): BuiltInBrowserOpenPanelArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    return { url, tabId, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  const parseBuiltInBrowserSelectPointArgs = (value: unknown, channel: string): BuiltInBrowserSelectPointArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const includeScreenshot = record.includeScreenshot === false ? false : undefined;
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      x: builtInBrowserNumber(record, "x", channel, { min: 0, max: 100_000 }),
      y: builtInBrowserNumber(record, "y", channel, { min: 0, max: 100_000 }),
      includeScreenshot,
    };
  };

  const parseBuiltInBrowserSetEmulationArgs = (value: unknown, channel: string): BuiltInBrowserSetEmulationArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const preset = record.preset === null
      ? null
      : optionalBuiltInBrowserString(record, "preset", channel, 64);
    const userAgent = optionalBuiltInBrowserString(record, "userAgent", channel, 512);
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(preset === undefined ? {} : { preset }),
      ...(record.width == null ? {} : { width: builtInBrowserNumber(record, "width", channel, { min: 1, max: 20_000 }) }),
      ...(record.height == null ? {} : { height: builtInBrowserNumber(record, "height", channel, { min: 1, max: 20_000 }) }),
      ...(record.deviceScaleFactor == null
        ? {}
        : { deviceScaleFactor: builtInBrowserNumber(record, "deviceScaleFactor", channel, { min: 0.1, max: 10 }) }),
      ...optionalField("mobile", optionalBoolean(record.mobile)),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
  };

  const parseBuiltInBrowserSetZoomArgs = (value: unknown, channel: string): BuiltInBrowserSetZoomArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(record.factor == null ? {} : { factor: builtInBrowserNumber(record, "factor", channel, { min: 0.05, max: 20 }) }),
      ...optionalField("reset", optionalBoolean(record.reset)),
    };
  };

  const parseBuiltInBrowserFindInPageArgs = (value: unknown, channel: string): BuiltInBrowserFindInPageArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const text = optionalBuiltInBrowserString(record, "text", channel, 2048);
    if (!text) return invalidBuiltInBrowserArg(channel, "text must be a non-empty string");
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      text,
      ...optionalField("forward", optionalBoolean(record.forward)),
      ...optionalField("matchCase", optionalBoolean(record.matchCase)),
      ...optionalField("findNext", optionalBoolean(record.findNext)),
      ...(record.timeoutMs == null
        ? {}
        : { timeoutMs: builtInBrowserNumber(record, "timeoutMs", channel, { min: 250, max: 30_000 }) }),
    };
  };

  const parseBuiltInBrowserStopFindInPageArgs = (value: unknown, channel: string): BuiltInBrowserStopFindInPageArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const action = optionalBuiltInBrowserString(record, "action", channel, 32);
    if (action && action !== "clearSelection" && action !== "keepSelection" && action !== "activateSelection") {
      return invalidBuiltInBrowserArg(channel, "action is invalid");
    }
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(action ? { action: action as BuiltInBrowserStopFindInPageArgs["action"] } : {}),
    };
  };

  const parseBuiltInBrowserSetDevToolsArgs = (value: unknown, channel: string): BuiltInBrowserSetDevToolsArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const open = optionalBoolean(record.open);
    if (open === undefined) return invalidBuiltInBrowserArg(channel, "open must be a boolean");
    const mode = optionalBuiltInBrowserString(record, "mode", channel, 16);
    if (mode && mode !== "right" && mode !== "bottom" && mode !== "detach") {
      return invalidBuiltInBrowserArg(channel, "mode is invalid");
    }
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      open,
      ...(mode ? { mode: mode as BuiltInBrowserSetDevToolsArgs["mode"] } : {}),
    };
  };

  const parseBuiltInBrowserSetNetworkLoggingArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserSetNetworkLoggingArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const enabled = optionalBoolean(record.enabled);
    if (enabled === undefined) return invalidBuiltInBrowserArg(channel, "enabled must be a boolean");
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      enabled,
      ...optionalField("clear", optionalBoolean(record.clear)),
    };
  };

  const parseBuiltInBrowserNetworkLogArgs = (value: unknown, channel: string): BuiltInBrowserNetworkLogArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const filter = optionalBuiltInBrowserString(record, "filter", channel, 512);
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(record.limit == null ? {} : { limit: builtInBrowserNumber(record, "limit", channel, { min: 1, max: 500 }) }),
      ...(filter ? { filter } : {}),
      ...optionalField("failedOnly", optionalBoolean(record.failedOnly)),
    };
  };

  const parseBuiltInBrowserExportHarArgs = (value: unknown, channel: string): BuiltInBrowserExportHarArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const filter = optionalBuiltInBrowserString(record, "filter", channel, 512);
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(filter ? { filter } : {}),
      ...optionalField("failedOnly", optionalBoolean(record.failedOnly)),
    };
  };

  const parseBuiltInBrowserStartPreviewStreamArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserStartPreviewStreamArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      ...(tabId ? { tabId } : {}),
      ...(record.fps == null ? {} : { fps: builtInBrowserNumber(record, "fps", channel, { min: 1, max: 24 }) }),
      ...(record.maxWidth == null
        ? {}
        : { maxWidth: builtInBrowserNumber(record, "maxWidth", channel, { min: 80, max: 1_280 }) }),
    };
  };

  const parseBuiltInBrowserStopPreviewStreamArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserStopPreviewStreamArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      ...(tabId ? { tabId } : {}),
    };
  };

  const parseBuiltInBrowserStartRecordingArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserStartRecordingArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const caption = optionalBuiltInBrowserString(record, "caption", channel, 500);
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      ...(record.fps == null ? {} : { fps: builtInBrowserNumber(record, "fps", channel, { min: 30, max: 60 }) }),
      ...(caption ? { caption } : {}),
    };
  };


  return {
    invalidBuiltInBrowserArg,
    builtInBrowserRecord,
    builtInBrowserNumber,
    parseBuiltInBrowserBoundsArgs,
    parseBuiltInBrowserNavigateArgs,
    optionalBuiltInBrowserString,
    optionalBoolean,
    optionalBuiltInBrowserNumber,
    parseBuiltInBrowserProjectScopeArgs,
    parseBuiltInBrowserProjectScopeInput,
    parseBuiltInBrowserClearPermissionsArgs,
    parseBuiltInBrowserClaimArgs,
    parseBuiltInBrowserTabTargetRecord,
    parseBuiltInBrowserTabTargetArgs,
    parseBuiltInBrowserTabArgs,
    parseBuiltInBrowserCreateTabArgs,
    parseBuiltInBrowserOpenPanelArgs,
    parseBuiltInBrowserSelectPointArgs,
    parseBuiltInBrowserSetEmulationArgs,
    parseBuiltInBrowserSetZoomArgs,
    parseBuiltInBrowserFindInPageArgs,
    parseBuiltInBrowserStopFindInPageArgs,
    parseBuiltInBrowserSetDevToolsArgs,
    parseBuiltInBrowserSetNetworkLoggingArgs,
    parseBuiltInBrowserNetworkLogArgs,
    parseBuiltInBrowserExportHarArgs,
    parseBuiltInBrowserStartPreviewStreamArgs,
    parseBuiltInBrowserStopPreviewStreamArgs,
    parseBuiltInBrowserStartRecordingArgs,
  };
}
