import { AdeExpectedError } from "../../../shared/expectedError";
import { parsePairingQrText } from "../../../shared/pairingQr";
import type {
  RemoteRuntimeParsedPairingInput,
} from "../../../shared/types/remoteRuntime";
import {
  buildPairedEndpointCandidates,
  syncEndpointForHost,
} from "./pairedRuntimeRoutes";

export function parseRemoteRuntimePairingInput(
  text: string,
): RemoteRuntimeParsedPairingInput {
  const payload = parsePairingQrText(text);
  if (!payload) {
    // A pasted link or code that is not one: the person checks it and tries again.
    throw new AdeExpectedError("Invalid ADE pairing link or code.", "user");
  }

  const directEndpoints = payload.addressCandidates.flatMap((candidate) => {
    try {
      return [syncEndpointForHost(candidate.host, payload.port)];
    } catch {
      return [];
    }
  });
  const ordered = buildPairedEndpointCandidates({
    endpoints: directEndpoints,
    relayUrl: payload.relayUrl,
  });
  if (ordered.length === 0) {
    throw new Error("The ADE pairing link does not contain a reachable endpoint.");
  }
  const relayUrl = ordered.find((candidate) => candidate.kind === "relay")?.endpoint;

  return {
    hostIdentity: payload.hostIdentity,
    ...(payload.hostIdentity.name ? { machineName: payload.hostIdentity.name } : {}),
    endpoints: ordered.map((candidate) => candidate.endpoint),
    ...(relayUrl ? { relayUrl } : {}),
    ...(payload.runtimeHostGrant ? { runtimeHostGrant: payload.runtimeHostGrant } : {}),
    requiresPin: true,
  };
}
