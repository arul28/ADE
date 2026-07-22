export function assertVerifiedMachOPayloads(verified, archivePath) {
  if (!Number.isInteger(verified) || verified < 1) {
    throw new Error(`No Mach-O payloads were verified in pre-signed native archive: ${archivePath}`);
  }
  return verified;
}
