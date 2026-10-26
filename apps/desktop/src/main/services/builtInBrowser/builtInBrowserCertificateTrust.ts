import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Certificate } from "electron";
import type {
  BuiltInBrowserCertificateProblem,
  BuiltInBrowserTrustedCertificate,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";

/**
 * "Trust this certificate" for a local HTTPS dev server, and nothing wider.
 *
 * A person running `https://localhost:5173` with a self-signed certificate hit
 * a white page with no way past it. Chromium offers no override of its own in
 * Electron, so this is the override, held to four rules:
 *
 * 1. Only local and private addresses can be trusted (see
 *    {@link isLocalCertificateHost}). A public host never gets an offer: a
 *    certificate error there is exactly the attack the error exists to stop.
 * 2. Only the errors a self-signed or hand-made dev certificate produces (see
 *    {@link OVERRIDABLE_CERTIFICATE_ERRORS}). A revoked or pinned certificate,
 *    or a broken one, stays refused.
 * 3. An approval names one profile, one host and port, one certificate
 *    fingerprint and one error. A new certificate, or the same one failing a
 *    different way (it expired), asks again.
 * 4. Only the person can approve, from the ADE renderer. Nothing here is on the
 *    desktop bridge or the agent dispatch, so an agent driving a tab can read
 *    that the page needs approval and say so, but cannot answer it.
 *
 * The shared profile's approvals are saved (it is the signed-in profile that
 * survives restarts). An isolated profile's live in memory and are dropped when
 * its sign-in is wiped, like the rest of that throwaway jar.
 */

const STORE_VERSION = 1;
const MAX_APPROVALS = 200;

/** Errors a dev certificate produces: unknown issuer, wrong name, expired or not yet valid. */
export const OVERRIDABLE_CERTIFICATE_ERRORS: ReadonlySet<string> = new Set([
  "net::ERR_CERT_AUTHORITY_INVALID",
  "net::ERR_CERT_COMMON_NAME_INVALID",
  "net::ERR_CERT_DATE_INVALID",
]);

type StoredApproval = Omit<BuiltInBrowserTrustedCertificate, "id" | "profile" | "remembered"> & {
  partition: string;
};

type StoreFile = {
  version: typeof STORE_VERSION;
  approvals: StoredApproval[];
};

/**
 * Is this host one a person can reasonably own a self-signed server on?
 *
 * - loopback: `localhost`, `*.localhost` (always loopback in Chromium),
 *   127.0.0.0/8, `::1`
 * - private networks: 10/8, 172.16/12, 192.168/16, IPv6 unique-local fc00::/7
 * - link-local: 169.254/16, fe80::/10
 * - 100.64/10: shared address space, which is where Tailscale puts every
 *   machine on a tailnet. ADE drives lanes on other machines over exactly that,
 *   and a dev server on the desktop reached from the laptop is the case this
 *   feature exists for. It is not routable on the public internet.
 * - names reserved for local networks: `.local` (mDNS), `.home.arpa`
 *   (RFC 8375) and `.internal` (reserved by ICANN for private use)
 *
 * Everything else, including single-label names that a search domain could
 * turn into a public host, gets no offer.
 */
export function isLocalCertificateHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  const family = isIP(host);
  if (family === 4) return isLocalIpv4(host);
  if (family === 6) return isLocalIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return host.endsWith(".local") || host.endsWith(".home.arpa") || host.endsWith(".internal");
}

function isLocalIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 127
    || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function isLocalIpv6(host: string): boolean {
  if (host === "::1") return true;
  // IPv4-mapped (`::ffff:192.168.1.2`) is the IPv4 address it carries.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isLocalIpv4(mapped[1]!);
  const first = host.split(":")[0] ?? "";
  if (!first) return false;
  const word = Number.parseInt(first, 16);
  if (!Number.isFinite(word)) return false;
  return (word & 0xfe00) === 0xfc00 || (word & 0xffc0) === 0xfe80;
}

/** `sha256/<base64>` as `AB:CD:…`, or null when it is not that shape. */
export function certificateFingerprintHex(fingerprint: string): string | null {
  const match = /^sha256\/([A-Za-z0-9+/=]+)$/.exec(fingerprint.trim());
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length !== 32) return null;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/**
 * What the trust prompt may offer for this failure, or null when it may offer
 * nothing (a public host, an error that is not a dev-certificate error, an
 * unparseable URL or fingerprint).
 */
export function certificateProblemFor(
  url: string,
  error: string,
  certificate: Pick<Certificate, "fingerprint"> & Partial<Pick<Certificate, "subjectName" | "issuerName" | "validExpiry">>,
): BuiltInBrowserCertificateProblem | null {
  if (!OVERRIDABLE_CERTIFICATE_ERRORS.has(error)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `wss:` is the dev server's hot-reload socket on the same endpoint.
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!isLocalCertificateHost(host)) return null;
  const fingerprint = typeof certificate.fingerprint === "string" ? certificate.fingerprint.trim() : "";
  const fingerprintHex = certificateFingerprintHex(fingerprint);
  if (!fingerprintHex) return null;
  const port = parsed.port ? Number(parsed.port) : 443;
  const expiry = typeof certificate.validExpiry === "number" && Number.isFinite(certificate.validExpiry)
    ? new Date(certificate.validExpiry * 1000).toISOString()
    : null;
  return {
    host,
    port,
    fingerprint,
    fingerprintHex,
    error,
    subjectName: nonEmpty(certificate.subjectName),
    issuerName: nonEmpty(certificate.issuerName),
    validUntil: expiry,
  };
}

export function createBuiltInBrowserCertificateTrust(args: {
  /** Where the shared profile's approvals are saved; null keeps them in memory. */
  filePath: string | null;
  /** The partition whose approvals are saved. Every other partition is memory-only. */
  persistentPartition: string;
  getLogger?: () => Logger | null;
}) {
  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };
  const approvals = new Map<string, StoredApproval>(
    (args.filePath ? loadApprovals(args.filePath, args.persistentPartition, logger()) : [])
      .map((approval) => [approvalKey(approval.partition, approval), approval]),
  );
  let writeChain = Promise.resolve();

  const persist = async (): Promise<void> => {
    if (!args.filePath) return;
    const state: StoreFile = {
      version: STORE_VERSION,
      approvals: [...approvals.values()]
        .filter((approval) => approval.partition === args.persistentPartition)
        .sort((left, right) => right.trustedAt.localeCompare(left.trustedAt))
        .slice(0, MAX_APPROVALS),
    };
    const filePath = args.filePath;
    writeChain = writeChain.then(
      () => writeJsonAtomically(filePath, state),
      () => writeJsonAtomically(filePath, state),
    );
    await writeChain;
  };

  const persistLogged = async (reason: string): Promise<void> => {
    try {
      await persist();
    } catch (error) {
      logger()?.warn("built_in_browser.certificate_trust_persist_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toPublic = (approval: StoredApproval): BuiltInBrowserTrustedCertificate => {
    const { partition, ...rest } = approval;
    const persistent = partition === args.persistentPartition;
    return {
      ...rest,
      id: approvalId(partition, approval),
      profile: persistent ? "shared" : "isolated",
      remembered: persistent && Boolean(args.filePath),
    };
  };

  return {
    /** Synchronous and in-memory: read on every certificate error. */
    isTrusted(partition: string, problem: BuiltInBrowserCertificateProblem): boolean {
      return approvals.has(approvalKey(partition, problem));
    },
    async trust(partition: string, problem: BuiltInBrowserCertificateProblem): Promise<void> {
      // Re-checked here, not only where the offer was made: this is the one
      // write path, so a caller that skipped the offer still cannot trust a
      // public host or an error that is not a dev-certificate error.
      if (!isLocalCertificateHost(problem.host) || !OVERRIDABLE_CERTIFICATE_ERRORS.has(problem.error)) {
        throw new Error("Only a local or private address's certificate can be trusted.");
      }
      const approval: StoredApproval = {
        ...problem,
        partition,
        trustedAt: new Date().toISOString(),
      };
      approvals.set(approvalKey(partition, problem), approval);
      trimApprovals(approvals);
      logger()?.info("built_in_browser.certificate_trusted", {
        host: problem.host,
        port: problem.port,
        error: problem.error,
        fingerprint: problem.fingerprint,
        remembered: partition === args.persistentPartition,
      });
      if (partition === args.persistentPartition) await persistLogged("trust");
    },
    list(): BuiltInBrowserTrustedCertificate[] {
      return [...approvals.values()]
        .sort((left, right) => right.trustedAt.localeCompare(left.trustedAt))
        .map(toPublic);
    },
    /** Revoke one approval by id, or all of them. Returns the partitions touched. */
    async revoke(id?: string | null): Promise<{ removed: number; partitions: string[] }> {
      const partitions = new Set<string>();
      let removed = 0;
      for (const [key, approval] of approvals) {
        if (id && approvalId(approval.partition, approval) !== id) continue;
        approvals.delete(key);
        partitions.add(approval.partition);
        removed += 1;
      }
      if (id && removed === 0) throw new Error("That certificate is no longer trusted.");
      logger()?.info("built_in_browser.certificate_trust_revoked", { removed, all: !id });
      if (partitions.has(args.persistentPartition)) await persistLogged("revoke");
      return { removed, partitions: [...partitions] };
    },
    /** An isolated sign-in was wiped: its approvals go with it. */
    forgetPartition(partition: string): void {
      if (partition === args.persistentPartition) return;
      for (const [key, approval] of approvals) {
        if (approval.partition === partition) approvals.delete(key);
      }
    },
    async flush(): Promise<void> {
      await writeChain;
    },
  };
}

export type BuiltInBrowserCertificateTrust = ReturnType<typeof createBuiltInBrowserCertificateTrust>;

function approvalKey(
  partition: string,
  problem: Pick<BuiltInBrowserCertificateProblem, "host" | "port" | "fingerprint" | "error">,
): string {
  return JSON.stringify([partition, problem.host, problem.port, problem.fingerprint, problem.error]);
}

function approvalId(
  partition: string,
  problem: Pick<BuiltInBrowserCertificateProblem, "host" | "port" | "fingerprint" | "error">,
): string {
  return createHash("sha256").update(approvalKey(partition, problem)).digest("hex").slice(0, 20);
}

function trimApprovals(approvals: Map<string, StoredApproval>): void {
  if (approvals.size <= MAX_APPROVALS) return;
  const oldest = [...approvals.entries()]
    .sort((left, right) => left[1].trustedAt.localeCompare(right[1].trustedAt))
    .slice(0, approvals.size - MAX_APPROVALS);
  for (const [key] of oldest) approvals.delete(key);
}

function loadApprovals(filePath: string, persistentPartition: string, logger: Logger | null): StoredApproval[] {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.approvals)) return [];
    return parsed.approvals
      .map((value) => normalizeStoredApproval(value, persistentPartition))
      .filter((approval): approval is StoredApproval => Boolean(approval))
      .slice(0, MAX_APPROVALS);
  } catch (error) {
    // No file yet is the normal start. Anything else means saved approvals are
    // being dropped, and the next save replaces the file.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger?.warn("built_in_browser.certificate_trust_load_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

/** A hand-edited file cannot widen trust: every rule the prompt applies is re-applied on load. */
function normalizeStoredApproval(value: unknown, persistentPartition: string): StoredApproval | null {
  if (!isRecord(value) || value.partition !== persistentPartition) return null;
  const host = nonEmpty(value.host)?.toLowerCase() ?? null;
  const port = typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port < 65_536
    ? value.port
    : null;
  const fingerprint = nonEmpty(value.fingerprint);
  const error = nonEmpty(value.error);
  const trustedAt = nonEmpty(value.trustedAt);
  if (!host || !port || !fingerprint || !error || !trustedAt) return null;
  if (!isLocalCertificateHost(host) || !OVERRIDABLE_CERTIFICATE_ERRORS.has(error)) return null;
  const fingerprintHex = certificateFingerprintHex(fingerprint);
  if (!fingerprintHex) return null;
  return {
    partition: persistentPartition,
    host,
    port,
    fingerprint,
    fingerprintHex,
    error,
    subjectName: nonEmpty(value.subjectName),
    issuerName: nonEmpty(value.issuerName),
    validUntil: nonEmpty(value.validUntil),
    trustedAt,
  };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
