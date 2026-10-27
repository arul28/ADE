// node … measure-brain.mjs cli … -- sync status --json | npx tsx ../../scripts/perf/net/rig-pair.mts --via 127.0.0.1:<proxy port> [--name "Rig Studio"]
//
// Prints the pairing link a desktop would scan from a measurement brain's pairing QR, built from the
// brain's own `sync status --json` (its pairingConnectInfo / localDevice) by the desktop's own encoder,
// with the address replaced by the slow proxy in front of it. The three-machine rig hands this link to
// the dev desktop's real pairing call (window.ade.remoteRuntime.pairWithMachine), so the desktop pairs,
// saves the target and connects exactly as after a user typed the PIN, and every byte goes through the proxy.
import fs from "node:fs";
import { buildPairingQrPayload, encodePairingQrUrl } from "../../../apps/desktop/src/shared/pairingQr";

const argv = process.argv.slice(2);
const read = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
};
const via = read("--via");
if (!via) throw new Error("--via host:port (the proxy in front of the brain) is required");
const [host, portText] = [via.slice(0, via.lastIndexOf(":")), via.slice(via.lastIndexOf(":") + 1)];
const port = Number(portText);
if (!host || !Number.isInteger(port) || port === 8787) throw new Error(`bad --via ${via}`);
const status = JSON.parse(fs.readFileSync(0, "utf8"));
const device = status.localDevice ?? {};
const info = status.pairingConnectInfo ?? {};
const hostIdentity = {
  ...(info.hostIdentity ?? { deviceId: device.deviceId, siteId: device.siteId, platform: device.platform, deviceType: device.deviceType }),
  name: read("--name") ?? info.hostIdentity?.name ?? device.name,
};
if (!hostIdentity.deviceId) throw new Error("sync status has no device identity");
const payload = buildPairingQrPayload({
  connectInfo: { ...info, hostIdentity, port, addressCandidates: [{ host, kind: "lan" }] },
  pinConfigured: true,
});
console.log(encodePairingQrUrl(payload));
