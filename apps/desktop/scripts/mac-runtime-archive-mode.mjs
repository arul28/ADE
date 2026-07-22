export const PRE_SIGNED_RUNTIME_ARCHIVES_ENV = "ADE_RUNTIME_ARCHIVES_PRE_SIGNED";

export function nativeArchiveAction(env = process.env) {
  return env[PRE_SIGNED_RUNTIME_ARCHIVES_ENV] === "1" ? "verify" : "sign";
}

export function nativeArchiveNotarizeArgs(binaryPath, action) {
  if (action === "verify") {
    return [`--binary=${binaryPath}`, "--verify-native-only"];
  }
  if (action === "sign") {
    return [`--binary=${binaryPath}`, "--sign-native-only"];
  }
  throw new Error(`Unsupported native archive action: ${action}`);
}
