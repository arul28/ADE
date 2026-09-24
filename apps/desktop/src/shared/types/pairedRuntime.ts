import type {
  SyncHelloOkPayload,
  SyncPairingHostIdentity,
} from "./sync";

export type PairedRuntimeRpcOpenPayload = {
  channelId: string;
};

export type PairedRuntimeRpcDataPayload = {
  channelId: string;
  /** Base64-encoded bytes from the newline-delimited JSON-RPC stream. */
  data: string;
};

/**
 * The host closed an RPC channel because a reply would pass its send budget.
 * The host is alive and the next call opens a new channel, so a client must
 * not report the machine as unreachable for it.
 */
export const PAIRED_RUNTIME_RPC_OVER_BUDGET_CODE = "rpc_over_budget";

/**
 * The reason the host sends with that close. Hosts from before the code send
 * only this sentence, and it is the only close they send for that cause, so a
 * client reads it the same way.
 */
export const PAIRED_RUNTIME_RPC_OVER_BUDGET_REASON = "Runtime RPC channel fell behind the sync connection.";

/**
 * The host closes an older connection from the same device when a newer one
 * authenticates. Code and reason travel together because the tunnel relay also
 * uses 4000, for "partner closed", which means something else.
 */
export const PAIRED_RUNTIME_SUPERSEDED_CLOSE_CODE = 4000;
export const PAIRED_RUNTIME_SUPERSEDED_CLOSE_REASON = "Superseded by a newer connection for this device";

export type PairedRuntimeRpcClosePayload = {
  channelId: string;
  reason?: string | null;
  /** Machine-readable cause. Absent on hosts older than the code. */
  code?: typeof PAIRED_RUNTIME_RPC_OVER_BUDGET_CODE | null;
};

export type PairedRuntimeForwardOpenPayload = {
  forwardId: string;
  host: string;
  port: number;
};

export type PairedRuntimeForwardDataPayload = {
  forwardId: string;
  /** Base64-encoded TCP stream bytes. */
  data: string;
};

export type PairedRuntimeForwardClosePayload = {
  forwardId: string;
  reason?: string | null;
};

/** Ask the peer to stop reading its TCP socket until `fwd_resume`. */
export type PairedRuntimeForwardPausePayload = {
  forwardId: string;
};

type PairedRuntimeEnvelopeBase<TType extends string> = {
  version: 1;
  type: TType;
  projectId?: string | null;
  requestId?: string | null;
};

type PairedRuntimeEnvelopeWithPayload<TType extends string, TPayload> =
  | (PairedRuntimeEnvelopeBase<TType> & {
      compression: "none";
      payloadEncoding: "json";
      payload: TPayload;
    })
  | (PairedRuntimeEnvelopeBase<TType> & {
      compression: "gzip";
      payloadEncoding: "base64";
      payload: string;
      uncompressedBytes: number;
    });

export type PairedRuntimeRpcOpenEnvelope = PairedRuntimeEnvelopeWithPayload<
  "rpc_open",
  PairedRuntimeRpcOpenPayload
>;
export type PairedRuntimeRpcDataEnvelope = PairedRuntimeEnvelopeWithPayload<
  "rpc_data",
  PairedRuntimeRpcDataPayload
>;
export type PairedRuntimeRpcCloseEnvelope = PairedRuntimeEnvelopeWithPayload<
  "rpc_close",
  PairedRuntimeRpcClosePayload
>;
export type PairedRuntimeForwardOpenEnvelope = PairedRuntimeEnvelopeWithPayload<
  "fwd_open",
  PairedRuntimeForwardOpenPayload
>;
export type PairedRuntimeForwardDataEnvelope = PairedRuntimeEnvelopeWithPayload<
  "fwd_data",
  PairedRuntimeForwardDataPayload
>;
export type PairedRuntimeForwardCloseEnvelope = PairedRuntimeEnvelopeWithPayload<
  "fwd_close",
  PairedRuntimeForwardClosePayload
>;
export type PairedRuntimeForwardPauseEnvelope = PairedRuntimeEnvelopeWithPayload<
  "fwd_pause",
  PairedRuntimeForwardPausePayload
>;
export type PairedRuntimeForwardResumeEnvelope = PairedRuntimeEnvelopeWithPayload<
  "fwd_resume",
  PairedRuntimeForwardPausePayload
>;

export type PairedRuntimeSyncEnvelope =
  | PairedRuntimeRpcOpenEnvelope
  | PairedRuntimeRpcDataEnvelope
  | PairedRuntimeRpcCloseEnvelope
  | PairedRuntimeForwardOpenEnvelope
  | PairedRuntimeForwardDataEnvelope
  | PairedRuntimeForwardCloseEnvelope
  | PairedRuntimeForwardPauseEnvelope
  | PairedRuntimeForwardResumeEnvelope;

export type PairedRuntimeFeatureFlags = {
  /**
   * Full newline-delimited runtime JSON-RPC over rpc_* envelopes. Advertised
   * `true` only to peers with a server-issued runtime-host grant; device type
   * metadata alone is never authorization.
   */
  rpcChannel: boolean;
  /** Loopback-only host TCP forwarding over fwd_* envelopes. Grant-gated, as above. */
  portForward: boolean;
};

export type PairedRuntimeHelloOkPayload = Omit<SyncHelloOkPayload, "features"> & {
  features: SyncHelloOkPayload["features"] & PairedRuntimeFeatureFlags;
};

export type DesktopPairedMachineCredentials = {
  version: 1;
  hostIdentity: SyncPairingHostIdentity;
  /** Optional tunnel-relay machine key parsed from a saved relay endpoint. */
  machineKey?: string | null;
  /** Account that created this credential. Missing/null means user-paired. */
  accountOwnerUserId?: string | null;
  /** Device id registered in the host's pairing store. */
  deviceId: string;
  /** Stable local site id used in the sync hello metadata. */
  siteId: string;
  deviceName: string;
  secret: string;
  /** Base64 DER PKCS#8 P-256 private key. */
  dpopPrivateKey: string;
  /** Base64 X9.63 uncompressed P-256 public key. */
  dpopPublicKey: string;
  endpoints: string[];
  /** Relay endpoint advertised by the host, when one is available. */
  relayUrl?: string | null;
  /** Per-endpoint route history used to prefer recently successful routes. */
  endpointStates?: DesktopPairedMachineEndpointState[];
  createdAt: string;
  updatedAt: string;
};

export type DesktopPairedMachineEndpointState = {
  endpoint: string;
  lastSucceededAt: number | null;
  /** Recent consecutive dial failures demote, but never remove, this route. */
  lastFailedAt?: number | null;
  consecutiveFailures?: number;
  /** Fresh discovery wins within a route kind before historical success. */
  lastDiscoveredAt?: number | null;
};

export type DesktopPairedMachinesFile = {
  version: 1;
  machines: DesktopPairedMachineCredentials[];
};

export type PairedRuntimePortForward = {
  remoteHost: string;
  remotePort: number;
  localHost: "127.0.0.1";
  localPort: number;
  localUrl: string;
  createdAt: number;
  lastUsedAt: number;
};
