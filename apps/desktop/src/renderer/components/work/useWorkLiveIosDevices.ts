import { useCallback, useEffect, useRef, useState } from "react";
import type { IosSimulatorSession, IosSimulatorStatus, OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import type { WorkLiveIosDevice } from "./workLiveCard";

/**
 * Every Apple device the corner card can picture.
 *
 * `status({laneId})` is the 2A surface: device, session, stream, and — when
 * the recording half has landed it — an active recording. Preload `getStatus`
 * still takes a pin rather than a scope object, so the current lane is read
 * from there and every other lane is asked via `deviceList({laneId})` /
 * `recordList({laneId})`. Cards are keyed by udid, so two lanes that happen
 * to share a simulator still collapse to one card.
 */

const POLL_MS = 4_000;

type RecordingRow = { endedAt: string | null; udid?: string | null };

function recordingFromStatus(status: IosSimulatorStatus | null | undefined): unknown {
  if (!status || typeof status !== "object") return null;
  const extra = status as IosSimulatorStatus & { recording?: unknown };
  return extra.recording ?? null;
}

function pickRecording(args: {
  udid: string;
  fromStatus: unknown;
  rows: readonly RecordingRow[];
}): unknown {
  if (args.fromStatus) return args.fromStatus;
  return args.rows.find((row) => row.endedAt == null && (!row.udid || row.udid === args.udid))
    ?? args.rows.find((row) => row.endedAt == null)
    ?? null;
}

function activityStamp(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function useWorkLiveIosDevices(args: {
  laneId: string | null;
  iosSession: IosSimulatorSession | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
  /** Most recent `ios` activity clock from the card's feed handler. */
  activityAt: number;
}): WorkLiveIosDevice[] {
  const { laneId, iosSession, runtimePin, enabled, activityAt } = args;
  const lanes = useAppStore((state) => state.lanes);
  const [devices, setDevices] = useState<WorkLiveIosDevice[]>([]);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const sessionRef = useRef(iosSession);
  sessionRef.current = iosSession;
  const activityRef = useRef(activityAt);
  activityRef.current = activityAt;

  const refresh = useCallback(async (cancelled: () => boolean) => {
    const api = window.ade?.iosSimulator;
    if (!api) {
      if (!cancelled()) setDevices([]);
      return;
    }
    const pin = pinRef.current;
    const seen = new Map<string, WorkLiveIosDevice>();
    const remember = (device: WorkLiveIosDevice) => {
      const existing = seen.get(device.udid);
      if (!existing || device.lastActivityAt >= existing.lastActivityAt) {
        seen.set(device.udid, device);
      }
    };

    const current = sessionRef.current;
    const fallbackActivity = Math.max(activityRef.current, 1);
    if (current?.deviceUdid) {
      remember({
        udid: current.deviceUdid,
        laneId: current.laneId ?? laneId ?? "",
        name: current.deviceName?.trim() || "Simulator",
        appName: current.appName ?? null,
        chatSessionId: current.chatSessionId ?? null,
        recording: null,
        lastActivityAt: Math.max(fallbackActivity, activityStamp(current.startedAt, fallbackActivity)),
      });
    }

    const applyStatus = async (statusLaneId: string | null, status: IosSimulatorStatus | null) => {
      if (!status) return;
      const rows = statusLaneId && api.recordList
        ? await api.recordList({ laneId: statusLaneId }, pin).catch(() => [] as RecordingRow[])
        : [] as RecordingRow[];
      const fromStatus = recordingFromStatus(status);
      const session = status.activeSession;
      const laneDevice = status.laneDevice ?? null;
      const udid = session?.deviceUdid ?? laneDevice?.udid ?? null;
      if (!udid) return;
      remember({
        udid,
        laneId: session?.laneId ?? laneDevice?.laneId ?? statusLaneId ?? "",
        name: session?.deviceName?.trim() || laneDevice?.name?.trim() || "Simulator",
        appName: session?.appName ?? null,
        chatSessionId: session?.chatSessionId ?? null,
        recording: pickRecording({ udid, fromStatus, rows }),
        lastActivityAt: Math.max(
          fallbackActivity,
          activityStamp(session?.startedAt, 0),
          activityStamp(laneDevice?.createdAt, 0),
        ),
      });
    };

    const status = await api.getStatus(pin).catch(() => null);
    if (cancelled()) return;
    await applyStatus(status?.laneId ?? laneId, status);
    if (cancelled()) return;

    const otherLaneIds = lanes
      .map((lane) => lane.id)
      .filter((id) => id && id !== laneId && id !== status?.laneId);
    for (const otherId of otherLaneIds) {
      const listed = await api.deviceList?.({ laneId: otherId }, pin).catch(() => null);
      if (cancelled()) return;
      const laneDevice = listed?.lane ?? null;
      if (!laneDevice) continue;
      const rows = api.recordList
        ? await api.recordList({ laneId: otherId }, pin).catch(() => [] as RecordingRow[])
        : [] as RecordingRow[];
      if (cancelled()) return;
      remember({
        udid: laneDevice.udid,
        laneId: laneDevice.laneId || otherId,
        name: laneDevice.name.trim() || "Simulator",
        appName: null,
        chatSessionId: null,
        recording: pickRecording({ udid: laneDevice.udid, fromStatus: null, rows }),
        lastActivityAt: Math.max(1, activityStamp(laneDevice.createdAt, 1)),
      });
    }

    if (!cancelled()) setDevices([...seen.values()]);
  }, [laneId, lanes]);

  useEffect(() => {
    if (!enabled) {
      setDevices([]);
      return undefined;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    void refresh(isCancelled);
    const timer = window.setInterval(() => {
      void refresh(isCancelled);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, iosSession?.deviceUdid, iosSession?.chatSessionId, refresh]);

  return devices;
}
