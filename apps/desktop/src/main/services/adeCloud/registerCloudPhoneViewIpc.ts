/**
 * The IPC for the ADE Cloud iPhone's live view (`cloudPhoneViewHost.ts`).
 *
 * Desktop-only: the offscreen page that draws the phone lives in this main
 * process, so there is no runtime action and no pin. The renderer that opened
 * a view is the only one frames are sent to; every handler refuses a sender
 * that is not ADE's own renderer.
 */

import { ipcMain } from "electron";

import { IPC } from "../../../shared/ipc";
import type {
  CloudPhoneViewInputArgs,
  CloudPhoneViewInputPhase,
  CloudPhoneViewKeyArgs,
  CloudPhoneViewOpenArgs,
  CloudPhoneViewOpenResult,
  CloudPhoneViewScrollArgs,
} from "../../../shared/types/cloudPhoneView";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { createCloudPhoneViewHost, type CloudPhoneViewHost } from "./cloudPhoneViewHost";
import { BRAND } from "../../../shared/brand";

let host: CloudPhoneViewHost | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readViewId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : "";
}

function isInputPhase(value: unknown): value is CloudPhoneViewInputPhase {
  return value === "begin" || value === "move" || value === "end";
}

function readOpenArgs(value: unknown): CloudPhoneViewOpenArgs {
  if (!isRecord(value)) throw new Error("A phone view needs its link and its device type.");
  const url = typeof value.url === "string" ? value.url : "";
  const deviceFamily = value.deviceFamily;
  if (!url || (deviceFamily !== "iphone" && deviceFamily !== "ipad")) {
    throw new Error("A phone view needs its link and its device type.");
  }
  const points = isRecord(value.pointSize) ? value.pointSize : null;
  const pointSize = points && typeof points.width === "number" && typeof points.height === "number"
    ? { width: points.width, height: points.height }
    : undefined;
  return { url, deviceFamily, ...(pointSize ? { pointSize } : {}) };
}

function readInputArgs(value: unknown): CloudPhoneViewInputArgs | null {
  if (!isRecord(value)) return null;
  const viewId = readViewId(value.viewId);
  const phase = value.phase;
  const x = value.x;
  const y = value.y;
  if (!viewId || !isInputPhase(phase) || typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { viewId, phase, x, y };
}

function readScrollArgs(value: unknown): CloudPhoneViewScrollArgs | null {
  if (!isRecord(value)) return null;
  const viewId = readViewId(value.viewId);
  const { x, y, deltaX, deltaY } = value;
  if (!viewId) return null;
  if (typeof x !== "number" || typeof y !== "number" || typeof deltaX !== "number" || typeof deltaY !== "number") {
    return null;
  }
  if (![x, y, deltaX, deltaY].every((number) => Number.isFinite(number))) return null;
  return { viewId, x, y, deltaX, deltaY };
}

/** App quit (`main.ts`): an offscreen page does not close with the window that asked for it. */
export function closeAllCloudPhoneViews(): void {
  host?.closeAll();
}

export function registerCloudPhoneViewIpc(args: { logger: Logger }): void {
  const { logger } = args;
  const viewHost = (host ??= createCloudPhoneViewHost({ logger }));

  ipcMain.handle(IPC.cloudPhoneViewOpen, (event, raw: unknown): CloudPhoneViewOpenResult => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewOpen)) {
      throw new Error(`${BRAND.NAME} can't do that from here.`);
    }
    return viewHost.open({ ...readOpenArgs(raw), sender: event.sender });
  });

  ipcMain.handle(IPC.cloudPhoneViewClose, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewClose)) return;
    const viewId = isRecord(raw) ? readViewId(raw.viewId) : "";
    if (viewId) viewHost.close({ viewId });
  });

  ipcMain.handle(IPC.cloudPhoneViewInput, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewInput)) return;
    const input = readInputArgs(raw);
    if (input) viewHost.input(input);
  });

  ipcMain.handle(IPC.cloudPhoneViewScroll, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewScroll)) return;
    const scroll = readScrollArgs(raw);
    if (scroll) viewHost.scroll(scroll);
  });

  ipcMain.handle(IPC.cloudPhoneViewKey, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewKey)) return;
    if (!isRecord(raw)) return;
    const viewId = readViewId(raw.viewId);
    const key = typeof raw.key === "string" && raw.key.length <= 32 ? raw.key : "";
    if (!viewId || !key) return;
    const keyArgs: CloudPhoneViewKeyArgs = { viewId, key };
    viewHost.key(keyArgs);
  });

  ipcMain.handle(IPC.cloudPhoneViewHome, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewHome)) return;
    const viewId = isRecord(raw) ? readViewId(raw.viewId) : "";
    if (viewId) viewHost.home({ viewId });
  });

  ipcMain.handle(IPC.cloudPhoneViewSetHidden, (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPhoneViewSetHidden)) return;
    if (!isRecord(raw)) return;
    const viewId = readViewId(raw.viewId);
    if (!viewId || typeof raw.hidden !== "boolean") return;
    viewHost.setHidden({ viewId, hidden: raw.hidden });
  });
}
