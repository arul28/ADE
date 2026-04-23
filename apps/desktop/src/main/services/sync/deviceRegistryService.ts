import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  SyncBrainStatusPayload,
  SyncClusterState,
  SyncDeviceRecord,
  SyncPeerConnectionState,
  SyncPeerDeviceType,
  SyncPeerMetadata,
  SyncPeerPlatform,
} from "../../../shared/types";
import { normalizeNotificationPreferences, type NotificationPreferences } from "../../../shared/types/sync";
import type { Logger } from "../logging/logger";
import { mapPlatform } from "./syncProtocol";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse, toOptionalString, uniqueStrings, writeTextAtomic } from "../shared/utils";

type DeviceRegistryServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  localDeviceIdPath?: string;
};

type DeviceRow = {
  device_id: string;
  site_id: string;
  name: string;
  platform: string;
  device_type: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  last_host: string | null;
  last_port: number | null;
  tailscale_ip: string | null;
  ip_addresses_json: string | null;
  metadata_json: string | null;
};

type ClusterStateRow = {
  cluster_id: string;
  brain_device_id: string;
  brain_epoch: number;
  updated_at: string;
  updated_by_device_id: string;
};

const DEVICE_ID_FILE = "sync-device-id";
export const DEFAULT_SYNC_CLUSTER_ID = "default";
const WORKSPACE_ACTIVITY_ID = "workspace";

function normalizeDeviceType(value: unknown): SyncPeerDeviceType {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "desktop" || raw === "phone" || raw === "vps") return raw;
  return "unknown";
}

function normalizePlatform(value: unknown): SyncPeerPlatform {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "macOS" || raw === "linux" || raw === "windows" || raw === "iOS") return raw;
  return "unknown";
}

function readJsonArray(raw: string | null | undefined): string[] {
  return safeJsonParse<string[]>(raw, []).filter((value) => typeof value === "string" && value.trim().length > 0);
}

function mapDeviceRow(row: DeviceRow | null): SyncDeviceRecord | null {
  if (!row) return null;
  return {
    deviceId: String(row.device_id),
    siteId: String(row.site_id),
    name: String(row.name),
    platform: normalizePlatform(row.platform),
    deviceType: normalizeDeviceType(row.device_type),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    lastHost: row.last_host ? String(row.last_host) : null,
    lastPort: row.last_port == null ? null : Number(row.last_port),
    tailscaleIp: row.tailscale_ip ? String(row.tailscale_ip) : null,
    ipAddresses: readJsonArray(row.ip_addresses_json),
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function mapClusterStateRow(row: ClusterStateRow | null): SyncClusterState | null {
  if (!row) return null;
  return {
    clusterId: String(row.cluster_id),
    brainDeviceId: String(row.brain_device_id),
    brainEpoch: Number(row.brain_epoch ?? 0),
    updatedAt: String(row.updated_at),
    updatedByDeviceId: String(row.updated_by_device_id),
  };
}

type LocalNetworkMetadata = {
  lanIpAddresses: string[];
  tailscaleIp: string | null;
};

function isTailscaleAddress(ipAddress: string): boolean {
  const parts = ipAddress.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function readLocalNetworkMetadata(): LocalNetworkMetadata {
  const interfaces = os.networkInterfaces();
  const lan: string[] = [];
  const tailscale: string[] = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    const isLikelyTailscaleInterface = /tailscale|utun|tun/i.test(interfaceName);
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      if (isLikelyTailscaleInterface || isTailscaleAddress(entry.address)) {
        tailscale.push(entry.address);
      } else {
        lan.push(entry.address);
      }
    }
  }
  return {
    lanIpAddresses: uniqueStrings(lan),
    tailscaleIp: uniqueStrings(tailscale)[0] ?? null,
  };
}

function firstPreferredHost(ipAddresses: string[]): string {
  return ipAddresses[0] ?? os.hostname();
}

export function createDeviceRegistryService(args: DeviceRegistryServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const deviceIdPath = args.localDeviceIdPath ?? path.join(layout.secretsDir, DEVICE_ID_FILE);
  const legacyProjectDeviceIdPath = path.join(layout.secretsDir, DEVICE_ID_FILE);
  fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });

  const readOrCreateLocalDeviceId = (): string => {
    // One desktop, one device id: the shared file is authoritative across
    // projects so each project's `sync_cluster_state.brain_device_id` agrees
    // on the same local identity. If the shared file is empty, seed it from
    // the first legacy per-project id we happen to see (one-time migration),
    // otherwise mint a fresh id. `O_EXCL` on the seed write keeps two
    // concurrent project contexts from racing to mint different ids.
    const shared = fs.existsSync(deviceIdPath) ? fs.readFileSync(deviceIdPath, "utf8").trim() : "";
    if (shared.length > 0) return shared;

    const legacy = deviceIdPath !== legacyProjectDeviceIdPath && fs.existsSync(legacyProjectDeviceIdPath)
      ? fs.readFileSync(legacyProjectDeviceIdPath, "utf8").trim()
      : "";
    const candidate = legacy.length > 0 ? legacy : randomUUID();
    try {
      fs.writeFileSync(deviceIdPath, `${candidate}\n`, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another context won the race; use whatever they wrote.
      return fs.readFileSync(deviceIdPath, "utf8").trim();
    }
  };

  const localDeviceId = readOrCreateLocalDeviceId();
  const localSiteId = args.db.sync.getSiteId();

  const getLocalDefaults = () => {
    const network = readLocalNetworkMetadata();
    return {
      name: os.hostname(),
      platform: mapPlatform(process.platform),
      deviceType: "desktop" as SyncPeerDeviceType,
      ipAddresses: network.lanIpAddresses,
      tailscaleIp: network.tailscaleIp,
      lastHost: firstPreferredHost(network.lanIpAddresses),
    };
  };

  const upsertDeviceRecord = (record: {
    deviceId: string;
    siteId: string;
    name: string;
    platform: SyncPeerPlatform;
    deviceType: SyncPeerDeviceType;
    createdAt?: string;
    updatedAt?: string;
    lastSeenAt?: string | null;
    lastHost?: string | null;
    lastPort?: number | null;
    tailscaleIp?: string | null;
    ipAddresses?: string[];
    metadata?: Record<string, unknown>;
  }): SyncDeviceRecord => {
    const now = nowIso();
    const existing = mapDeviceRow(args.db.get<DeviceRow>("select * from devices where device_id = ? limit 1", [record.deviceId]));
    const nextCreatedAt = record.createdAt ?? existing?.createdAt ?? now;
    const nextUpdatedAt = record.updatedAt ?? now;
    const nextIpAddresses = uniqueStrings(record.ipAddresses ?? existing?.ipAddresses ?? []);
    const nextMetadata = {
      ...(existing?.metadata ?? {}),
      ...(record.metadata ?? {}),
    };
    args.db.run(
      `
        insert into devices(
          device_id, site_id, name, platform, device_type,
          created_at, updated_at, last_seen_at, last_host, last_port,
          tailscale_ip, ip_addresses_json, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(device_id) do update set
          site_id = excluded.site_id,
          name = excluded.name,
          platform = excluded.platform,
          device_type = excluded.device_type,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at,
          last_host = excluded.last_host,
          last_port = excluded.last_port,
          tailscale_ip = excluded.tailscale_ip,
          ip_addresses_json = excluded.ip_addresses_json,
          metadata_json = excluded.metadata_json
      `,
      [
        record.deviceId,
        record.siteId,
        record.name,
        record.platform,
        record.deviceType,
        nextCreatedAt,
        nextUpdatedAt,
        record.lastSeenAt ?? existing?.lastSeenAt ?? null,
        record.lastHost ?? existing?.lastHost ?? null,
        record.lastPort ?? existing?.lastPort ?? null,
        record.tailscaleIp ?? existing?.tailscaleIp ?? null,
        JSON.stringify(nextIpAddresses),
        JSON.stringify(nextMetadata),
      ],
    );
    return mapDeviceRow(args.db.get<DeviceRow>("select * from devices where device_id = ? limit 1", [record.deviceId]))!;
  };

  const ensureLocalDevice = (): SyncDeviceRecord => {
    const existing = mapDeviceRow(args.db.get<DeviceRow>("select * from devices where device_id = ? limit 1", [localDeviceId]));
    const defaults = getLocalDefaults();
    return upsertDeviceRecord({
      deviceId: localDeviceId,
      siteId: localSiteId,
      name: existing?.name ?? defaults.name,
      platform: existing?.platform ?? defaults.platform,
      deviceType: existing?.deviceType ?? defaults.deviceType,
      lastSeenAt: nowIso(),
      lastHost: defaults.lastHost ?? existing?.lastHost ?? null,
      lastPort: existing?.lastPort ?? null,
      tailscaleIp: defaults.tailscaleIp ?? existing?.tailscaleIp ?? null,
      ipAddresses: defaults.ipAddresses.length > 0 ? defaults.ipAddresses : (existing?.ipAddresses ?? []),
      metadata: {
        ...(existing?.metadata ?? {}),
        hostname: os.hostname(),
      },
    });
  };

  const listDevices = (): SyncDeviceRecord[] => {
    return args.db
      .all<DeviceRow>("select * from devices order by case when device_id = ? then 0 else 1 end, name collate nocase asc", [localDeviceId])
      .map((row) => mapDeviceRow(row))
      .filter((row): row is SyncDeviceRecord => row != null);
  };

  const getDevice = (deviceId: string): SyncDeviceRecord | null => {
    const normalized = deviceId.trim();
    if (!normalized) return null;
    return mapDeviceRow(args.db.get<DeviceRow>("select * from devices where device_id = ? limit 1", [normalized]));
  };

  const getClusterState = (): SyncClusterState | null => {
    return mapClusterStateRow(
      args.db.get<ClusterStateRow>("select * from sync_cluster_state where cluster_id = ? limit 1", [DEFAULT_SYNC_CLUSTER_ID]),
    );
  };

  const setClusterState = (argsIn: {
    brainDeviceId: string;
    brainEpoch: number;
    updatedByDeviceId?: string;
  }): SyncClusterState => {
    const now = nowIso();
    args.db.run(
      `
        insert into sync_cluster_state(cluster_id, brain_device_id, brain_epoch, updated_at, updated_by_device_id)
        values (?, ?, ?, ?, ?)
        on conflict(cluster_id) do update set
          brain_device_id = excluded.brain_device_id,
          brain_epoch = excluded.brain_epoch,
          updated_at = excluded.updated_at,
          updated_by_device_id = excluded.updated_by_device_id
      `,
      [
        DEFAULT_SYNC_CLUSTER_ID,
        argsIn.brainDeviceId,
        argsIn.brainEpoch,
        now,
        argsIn.updatedByDeviceId ?? localDeviceId,
      ],
    );
    return getClusterState()!;
  };

  const bootstrapLocalBrainIfNeeded = (): SyncClusterState => {
    const existing = getClusterState();
    if (existing) return existing;
    ensureLocalDevice();
    return setClusterState({
      brainDeviceId: localDeviceId,
      brainEpoch: 1,
      updatedByDeviceId: localDeviceId,
    });
  };

  const updateLocalDevice = (updates: {
    name?: string;
    deviceType?: SyncPeerDeviceType;
  }): SyncDeviceRecord => {
    const current = ensureLocalDevice();
    return upsertDeviceRecord({
      deviceId: localDeviceId,
      siteId: localSiteId,
      name: toOptionalString(updates.name) ?? current.name,
      platform: current.platform,
      deviceType: updates.deviceType ?? current.deviceType,
      lastSeenAt: nowIso(),
      lastHost: current.lastHost,
      lastPort: current.lastPort,
      tailscaleIp: current.tailscaleIp,
      ipAddresses: current.ipAddresses,
      metadata: current.metadata,
    });
  };

  const touchLocalDevice = (argsIn: {
    lastSeenAt?: string | null;
    lastHost?: string | null;
    lastPort?: number | null;
    metadata?: Record<string, unknown>;
  } = {}): SyncDeviceRecord => {
    const current = ensureLocalDevice();
    const network = readLocalNetworkMetadata();
    return upsertDeviceRecord({
      deviceId: current.deviceId,
      siteId: current.siteId,
      name: current.name,
      platform: current.platform,
      deviceType: current.deviceType,
      lastSeenAt: argsIn.lastSeenAt ?? nowIso(),
      lastHost: argsIn.lastHost ?? current.lastHost ?? firstPreferredHost(network.lanIpAddresses),
      lastPort: argsIn.lastPort ?? current.lastPort,
      tailscaleIp: network.tailscaleIp ?? current.tailscaleIp,
      ipAddresses: network.lanIpAddresses.length > 0 ? network.lanIpAddresses : current.ipAddresses,
      metadata: {
        ...current.metadata,
        ...(argsIn.metadata ?? {}),
      },
    });
  };

  const upsertPeerMetadata = (
    peer: SyncPeerMetadata | SyncPeerConnectionState,
    extras: {
      lastSeenAt?: string | null;
      lastHost?: string | null;
      lastPort?: number | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): SyncDeviceRecord => {
    return upsertDeviceRecord({
      deviceId: peer.deviceId,
      siteId: peer.siteId,
      name: peer.deviceName,
      platform: peer.platform,
      deviceType: peer.deviceType,
      lastSeenAt: extras.lastSeenAt ?? ("lastSeenAt" in peer ? peer.lastSeenAt : nowIso()),
      lastHost: extras.lastHost ?? ("remoteAddress" in peer ? peer.remoteAddress : null),
      lastPort: extras.lastPort ?? ("remotePort" in peer ? peer.remotePort : null),
      metadata: {
        dbVersion: peer.dbVersion,
        ...(extras.metadata ?? {}),
      },
    });
  };

  type ApnsTokenKind = "alert" | "activity-start" | "activity-update";

  const apnsMetaKey = (kind: ApnsTokenKind): string => {
    if (kind === "alert") return "apnsAlertToken";
    if (kind === "activity-start") return "apnsActivityStartToken";
    return "apnsActivityUpdateTokens";
  };

  const setApnsToken = (
    deviceId: string,
    token: string,
    kind: ApnsTokenKind,
    env: "sandbox" | "production",
    extras: { bundleId?: string; activityId?: string } = {},
  ): SyncDeviceRecord | null => {
    const device = getDevice(deviceId);
    if (!device) return null;
    const nextMetadata: Record<string, unknown> = {
      ...device.metadata,
      apnsEnv: env,
      apnsTokenUpdatedAt: nowIso(),
    };
    if (extras.bundleId) nextMetadata.apnsBundleId = extras.bundleId;
    if (kind === "activity-update") {
      const existing = (device.metadata.apnsActivityUpdateTokens as Record<string, string> | undefined) ?? {};
      const activityId = extras.activityId?.trim() || WORKSPACE_ACTIVITY_ID;
      nextMetadata.apnsActivityUpdateTokens = { ...existing, [activityId]: token };
    } else {
      nextMetadata[apnsMetaKey(kind)] = token;
    }
    return upsertDeviceRecord({
      deviceId: device.deviceId,
      siteId: device.siteId,
      name: device.name,
      platform: device.platform,
      deviceType: device.deviceType,
      lastSeenAt: device.lastSeenAt,
      lastHost: device.lastHost,
      lastPort: device.lastPort,
      tailscaleIp: device.tailscaleIp,
      ipAddresses: device.ipAddresses,
      metadata: nextMetadata,
    });
  };

  const getApnsTokenForDevice = (
    deviceId: string,
    kind: ApnsTokenKind,
    activityId?: string,
  ): string | null => {
    const device = getDevice(deviceId);
    if (!device) return null;
    if (kind === "activity-update") {
      const map = (device.metadata.apnsActivityUpdateTokens as Record<string, string> | undefined) ?? {};
      return map[activityId?.trim() || WORKSPACE_ACTIVITY_ID] ?? null;
    }
    const raw = device.metadata[apnsMetaKey(kind)];
    return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  };

  const setNotificationPreferences = (
    deviceId: string,
    prefs: NotificationPreferences,
  ): SyncDeviceRecord | null => {
    const device = getDevice(deviceId);
    if (!device) return null;
    const normalizedPrefs = normalizeNotificationPreferences(prefs);
    return upsertDeviceRecord({
      deviceId: device.deviceId,
      siteId: device.siteId,
      name: device.name,
      platform: device.platform,
      deviceType: device.deviceType,
      lastSeenAt: device.lastSeenAt,
      lastHost: device.lastHost,
      lastPort: device.lastPort,
      tailscaleIp: device.tailscaleIp,
      ipAddresses: device.ipAddresses,
      metadata: {
        ...device.metadata,
        notificationPreferences: normalizedPrefs,
        notificationPreferencesUpdatedAt: nowIso(),
      },
    });
  };

  const getNotificationPreferences = (deviceId: string): NotificationPreferences | null => {
    const prefs = getDevice(deviceId)?.metadata.notificationPreferences;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return null;
    return normalizeNotificationPreferences(prefs);
  };

  const invalidateApnsToken = (deviceToken: string): void => {
    const token = deviceToken.trim();
    if (!token) return;
    const device = findDeviceByApnsToken(token);
    if (!device) return;
    const nextMetadata = { ...device.metadata };
    if (nextMetadata.apnsAlertToken === token) {
      delete nextMetadata.apnsAlertToken;
    }
    if (nextMetadata.apnsActivityStartToken === token) {
      delete nextMetadata.apnsActivityStartToken;
    }
    const updates = nextMetadata.apnsActivityUpdateTokens;
    if (updates && typeof updates === "object" && !Array.isArray(updates)) {
      const nextUpdates = { ...(updates as Record<string, string>) };
      for (const [activityId, value] of Object.entries(nextUpdates)) {
        if (value === token) delete nextUpdates[activityId];
      }
      if (Object.keys(nextUpdates).length > 0) {
        nextMetadata.apnsActivityUpdateTokens = nextUpdates;
      } else {
        delete nextMetadata.apnsActivityUpdateTokens;
      }
    }
    upsertDeviceRecord({
      deviceId: device.deviceId,
      siteId: device.siteId,
      name: device.name,
      platform: device.platform,
      deviceType: device.deviceType,
      lastSeenAt: device.lastSeenAt,
      lastHost: device.lastHost,
      lastPort: device.lastPort,
      tailscaleIp: device.tailscaleIp,
      ipAddresses: device.ipAddresses,
      metadata: nextMetadata,
    });
  };

  const invalidateApnsTokensForDevice = (deviceId: string): void => {
    const device = getDevice(deviceId);
    if (!device) return;
    const nextMetadata = { ...device.metadata };
    delete nextMetadata.apnsAlertToken;
    delete nextMetadata.apnsActivityStartToken;
    delete nextMetadata.apnsActivityUpdateTokens;
    upsertDeviceRecord({
      deviceId: device.deviceId,
      siteId: device.siteId,
      name: device.name,
      platform: device.platform,
      deviceType: device.deviceType,
      lastSeenAt: device.lastSeenAt,
      lastHost: device.lastHost,
      lastPort: device.lastPort,
      tailscaleIp: device.tailscaleIp,
      ipAddresses: device.ipAddresses,
      metadata: nextMetadata,
    });
  };

  const findDeviceByApnsToken = (token: string): SyncDeviceRecord | null => {
    for (const device of listDevices()) {
      const alert = device.metadata.apnsAlertToken;
      const activity = device.metadata.apnsActivityStartToken;
      if (alert === token || activity === token) return device;
      const updates = device.metadata.apnsActivityUpdateTokens;
      if (updates && typeof updates === "object") {
        for (const value of Object.values(updates as Record<string, unknown>)) {
          if (value === token) return device;
        }
      }
    }
    return null;
  };

  const applyBrainStatus = (payload: SyncBrainStatusPayload): void => {
    upsertPeerMetadata(payload.brain, { lastSeenAt: nowIso() });
    for (const peer of payload.connectedPeers) {
      upsertPeerMetadata(peer, {
        lastSeenAt: peer.lastSeenAt,
        lastHost: peer.remoteAddress,
        lastPort: peer.remotePort,
      });
    }
  };

  const clearClusterRegistryForViewerJoin = (): void => {
    args.logger.info("sync.device_registry.clear_for_viewer_join", {
      projectRoot: args.projectRoot,
      localDeviceId,
    });
    args.db.run("delete from sync_cluster_state");
    args.db.run("delete from devices");
  };

  const forgetDevice = (deviceId: string): void => {
    const normalized = deviceId.trim();
    if (!normalized || normalized === localDeviceId) return;
    args.db.run("delete from devices where device_id = ?", [normalized]);
  };

  ensureLocalDevice();

  return {
    getLocalDeviceId(): string {
      return localDeviceId;
    },

    getLocalSiteId(): string {
      return localSiteId;
    },

    ensureLocalDevice,
    touchLocalDevice,
    updateLocalDevice,
    listDevices,
    getDevice,
    getClusterState,
    setClusterState,
    bootstrapLocalBrainIfNeeded,
    upsertPeerMetadata,
    applyBrainStatus,
    clearClusterRegistryForViewerJoin,
    forgetDevice,
    setApnsToken,
    getApnsTokenForDevice,
    setNotificationPreferences,
    getNotificationPreferences,
    invalidateApnsToken,
    invalidateApnsTokensForDevice,
    findDeviceByApnsToken,
  };
}

export type DeviceRegistryService = ReturnType<typeof createDeviceRegistryService>;
