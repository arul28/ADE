/**
 * Passkeys in ADE's browser: the tab preload's request to desktop main, and
 * main's answer. Byte fields travel as base64url.
 *
 * Main takes the origin from the frame that asked (never from these fields),
 * checks the RP ID against it, asks the person (Touch ID / Windows Hello),
 * and signs with a passkey saved in ADE Passwords. `fallback` tells the page
 * to use Chromium's own WebAuthn instead (no saved passkey, Passwords off, a
 * conditional request).
 */
export const BUILT_IN_BROWSER_WEBAUTHN_CHANNEL = "ade:built-in-browser:webauthn" as const;

export type WebAuthnPageRequest =
  | {
      kind: "create";
      rpId: string | null;
      rpName: string | null;
      userId: string;
      userName: string;
      userDisplayName: string;
      challenge: string;
      excludeCredentialIds: string[];
      algorithms: number[];
      userVerification: "required" | "preferred" | "discouraged";
      wantsCredProps: boolean;
    }
  | {
      kind: "get";
      rpId: string | null;
      challenge: string;
      allowCredentialIds: string[];
      userVerification: "required" | "preferred" | "discouraged";
      mediation: string | null;
    };

export type WebAuthnPageAnswer =
  | { fallback: true }
  | { error: "NotAllowedError" | "InvalidStateError" | "SecurityError" | "NotSupportedError"; message: string }
  | {
      kind: "create";
      credentialId: string;
      clientDataJSON: string;
      attestationObject: string;
      authenticatorData: string;
      publicKey: string;
      publicKeyAlgorithm: number;
      transports: string[];
      credProps: boolean;
    }
  | {
      kind: "get";
      credentialId: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle: string;
    };
