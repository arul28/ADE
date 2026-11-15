/**
 * Passkeys for ADE's built-in browser: the pure software authenticator core.
 *
 * `navigator.credentials.create/get` is intercepted in Electron main. Main
 * reads the origin from the frame itself (never from the page's arguments),
 * checks `rpIdAllowedForOrigin`, asks the person for consent and user
 * verification (Touch ID / Windows Hello), and only then calls into this
 * module. The returned `StoredPasskey` is sealed in ADE Passwords; the
 * returned response bytes go straight back to the page's WebAuthn call.
 *
 * The rules that make that safe live at the top of `webauthnAuthenticator.ts`:
 * the origin is the frame's, the RP ID must belong to it, `crossOrigin` is
 * always false, user verification is a caller decision, and the private key
 * never leaves this layer unsealed.
 */
export * from "./cbor";
export * from "./webauthnAuthenticator";
