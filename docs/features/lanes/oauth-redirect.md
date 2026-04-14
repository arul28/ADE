# OAuth redirect service

`apps/desktop/src/main/services/lanes/oauthRedirectService.ts` routes
OAuth callbacks back to the correct lane when many lanes share an
OAuth provider configuration. This is a fragile subsystem: it sits
inline on the proxy request path, owns three state machines, and has
recently been hardened in ways tests now pin directly. Treat it with
care.

> **This branch touches this service heavily.** The current branch
> changes include direct modifications to `oauthRedirectService.ts`
> and its test file (`oauthRedirectService.test.ts`) — including a
> new `http.request` mock strategy for testing `defaultRequestUpstream`.
> Before editing, read the section on `http.request` mocking below.

## Why ADE needs this

Classical OAuth requires registering exact redirect URIs with the
provider. With many parallel lanes, registering one URI per lane is
either impractical (Google, GitHub) or outright unsupported by the
provider. ADE works around this in two complementary ways:

1. **State-parameter routing (default)** — ADE encodes the
   originating lane id into the `state` query parameter of the OAuth
   flow. A single stable callback URL handles every lane.
2. **Hostname-based routing (opt-in)** — if the provider supports
   wildcard redirect URIs (e.g. `*.localhost`), each lane's unique
   `<slug>.localhost` hostname routes callbacks naturally.

## High-level flow (state-parameter mode)

```
1. User starts sign-in on the lane preview URL (feat-auth.localhost:8080/auth/login)
2. App redirects to provider (Location: https://accounts.google.com/...?state=raw&redirect_uri=feat-auth.localhost:8080/oauth/callback)
3. ADE proxy intercepts the 302 from the lane app
   - Parses the Location header
   - Computes encodedState = ade:<hmac>:<base64(laneId)>:<originalState>
   - Replaces state with encodedState
   - Replaces redirect_uri with the stable http://localhost:<proxyPort>/oauth/callback
   - Stores a PendingOAuthStartSession keyed by encodedState
4. Browser follows rewritten URL to provider
5. Provider redirects back to http://localhost:<proxyPort>/oauth/callback?code=…&state=encodedState
6. ADE proxy intercepts the callback
   - decodeState(encodedState) → { laneId, originalState }
   - Looks up PendingOAuthStartSession
   - Forwards to the correct lane's app with state restored to originalState
   - Captures the app's response as a PendingFinalizeSession
7. ADE replies to the browser with a 302 to http://<lane-host>:<proxyPort>/__ade/oauth/finalize?token=…
8. Browser follows to /__ade/oauth/finalize
   - This hits the proxy on the correct lane hostname
   - ADE replays the captured lane-app response on the lane's own hostname
   - Cookies that the lane app set are now scoped to the lane hostname, as expected
```

The indirection in steps 6–8 exists specifically so the browser
receives cookies on the lane's hostname, not on
`localhost:<proxyPort>`. This is what makes isolation actually work.

## State parameter encoding

```
ade:<signature>:<base64url(laneId)>:<originalState>
```

- Prefix: `STATE_PREFIX = "ade"`, separator: `STATE_SEP = ":"`.
- `signature`: HMAC-SHA256 of `laneId + "\0" + originalState`, keyed
  with a per-service-instance `stateSecret` (32 random bytes,
  regenerated on every service restart).
- `laneId` is base64url-encoded so that laneIds containing
  separators or non-ASCII characters survive round-trip.
- `originalState` is copied verbatim as the trailing segment.

`decodeState`:

1. Strip the `ade:` prefix.
2. Locate the two separators.
3. Recover `signature` (raw) and `laneId` (base64url-decoded).
4. Recompute the expected signature with the current `stateSecret`.
5. Compare with `timingSafeEqual`. On mismatch, log and return null.

Key consequence: a restart invalidates all in-flight OAuth state.
Pending sessions that span an ADE restart will fail validation and
log `oauth_redirect.signature_mismatch`. This is by design.

## Three state machines

### 1. `pendingStarts: Map<encodedState, PendingOAuthStartSession>`

Recorded when the proxy intercepts the provider redirect at step 3.
Captures:

- `encodedState`, `laneId`, `laneHostname`, `targetPort`
- `originalState`, `originalCallbackPath`
- `cookiePairs` — merged from the incoming request's Cookie header
  and the lane app's Set-Cookie response (so the callback replay
  has the same cookie jar the app started with)
- `createdAtMs`, `provider`, `sessionId`

Removed when either:

- The callback arrives and is forwarded (`handleManagedCallback`
  deletes from `pendingStarts` and inserts into `pendingFinalize`).
- TTL expires (`OAUTH_SESSION_TTL_MS = 10 * 60 * 1000` = 10 min) via
  `removeExpiredPendingSessions`, which runs on every incoming
  request.

### 2. `pendingFinalize: Map<finalizeToken, PendingFinalizeSession>`

Recorded when `handleManagedCallback` finishes forwarding to the lane
app and captures the app's response. Token is
`oauth-finalize-<randomUUID()>`. The service replies to the browser
with a 302 to `/__ade/oauth/finalize?token=<token>` on the lane
hostname.

Removed when either:

- `/__ade/oauth/finalize?token=…` is hit and the captured response
  is replayed.
- TTL expires (same 10 min cutoff).

### 3. `sessions: Map<sessionId, OAuthSession>`

Live audit state visible via `listSessions()` IPC. Status
transitions: `pending → active → completed | failed`. UI consumers
filter for `pending | active` when rendering activity.

Emitted events on status change:

- `oauth-session-started` (created)
- `oauth-callback-routed` (pending → active when callback is being
  handled)
- `oauth-session-completed` (finalize replayed successfully)
- `oauth-session-failed` (error at any stage, TTL expiry, client
  abort, upstream error)

## Request entry point

`handleRequest(req, res)` is registered as a `ProxyRequestInterceptor`
on the `laneProxyService`. It returns `true` when it has handled the
request, preventing fall-through to the default proxy logic.

Routing order in `handleRequest`:

1. If disabled (`cfg.enabled === false`) → return false.
2. Run `removeExpiredPendingSessions()` to age out TTL-expired
   pending state.
3. If path is `FINALIZE_CALLBACK_PATH` (`/__ade/oauth/finalize`) →
   `handleFinalizeRequest`.
4. Extract the state parameter; if present and decodeable to a known
   `pendingStarts` entry → `handleManagedCallback`.
5. If the request targets a lane hostname and is a GET/HEAD to an
   `AUTH_START_PATH_PREFIXES` path
   (`/api/auth/`, `/auth/`, `/oauth/`) → `handleAuthStartRequest`
   (the redirect-inspection path).
6. Otherwise return false (let the default proxy handle it).

## `defaultRequestUpstream`

Internal helper that wraps `http.request` for upstream forwarding.
Responsibilities:

- Build headers (merge original req.headers with lane-scoped
  overrides — Host, X-Forwarded-*, optional Cookie).
- Open an outbound request with a 30 s timeout via
  `AbortController` + a Node `setTimeout`.
- For non-GET/HEAD requests, buffer request body chunks into
  `bodyChunks: Buffer[]` and call `upstreamReq.end(Buffer.concat(…))`
  only after the client emits `end`. For GET/HEAD, call
  `upstreamReq.end()` immediately with no body.
- Listen for client `aborted`, `close`, `error` events to reject the
  outbound promise and abort the upstream.
- On upstream response: collect chunks, resolve with
  `{ statusCode, headers, body: Buffer }`.
- Clean up timeout + listeners on every settlement path via
  `cleanup()`.

The service accepts an optional injectable `requestUpstream` so most
tests never touch `http.request`. The tests added on this branch
exercise `defaultRequestUpstream` directly by omitting that injection
and mocking `node:http`.

### `http.request` mocking strategy

```ts
// apps/desktop/src/main/services/lanes/oauthRedirectService.test.ts (top of file)
const httpRequestMock = vi.fn();
vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    default: {
      ...actual,
      request: (...args: unknown[]) => httpRequestMock(...args),
    },
    request: (...args: unknown[]) => httpRequestMock(...args),
  };
});
```

This replaces `http.request` for the module under test. Tests that
inject `requestUpstream` never hit this path. Tests that drive
`defaultRequestUpstream` deliberately omit the injection — those
tests must reset `httpRequestMock` in `beforeEach` and manually
supply a fake upstream via `mockImplementation` / `mockImplementationOnce`.

The test helper `makeFakeUpstream()` returns an EventEmitter that
behaves like a `ClientRequest`, plus helpers:

- `setCallback(cb)` — capture the callback the service passes to
  `http.request` so the test can later call it with a fake response.
- `emitResponse(statusCode, headers, body)` — build a fake
  `IncomingMessage` EventEmitter, invoke the captured callback,
  then emit data/end.
- `emitError(err)` — emit an `error` event on the fake request.

The `primePendingStart(laneId, targetPort)` helper is used to walk a
test through step 3 (auth-start redirect rewriting) before testing
the callback path. It returns the encoded state that the callback
simulation needs.

### Behaviors pinned by the defaultRequestUpstream tests

- **GET bypasses body buffering** — `upstreamReq.end()` is called
  with no args immediately after `http.request` returns.
- **AbortSignal is wired** — the `options.signal` passed to
  `http.request` is an `AbortSignal` and starts unaborted.
- **30 s timeout** — after advancing fake timers by 30 s, the
  AbortController signal must be aborted with a `TimeoutError` and
  the proxy must have written a 502 error page.
- **Late timer is a no-op after success** — after an upstream
  response has already settled, subsequent fake-timer ticks must not
  produce additional `writeHead` calls (the settled flag gates the
  timeout path).
- **POST buffers chunks** — the service must not call
  `upstreamReq.end()` until the client emits `end`, and the final
  `end(Buffer)` must contain concatenated chunks.
- **Client aborted** — emitting `aborted` on the incoming request
  must abort the AbortController with an `AbortError` and write a
  502.
- **Client close before complete** — emitting `close` while
  `req.complete === false` must also reject and abort.
- **Client close after success** — no writeHead should fire on a
  late close event.

If you change the buffering/cleanup logic, these tests will tell you.

## Redirect URI generation

`generateRedirectUris(provider?)` returns user-facing instructions
for registering URIs with the provider:

```
stable:    http://localhost:<proxyPort>/oauth/callback
per-lane:  http://<slug>.localhost:<proxyPort>/oauth/callback
            (listed for every currently active route)
```

The `ProxyAndPreviewSection` settings panel surfaces these via
"Copy Redirect URIs" buttons so the user can paste them into the
provider's console.

## HMAC validation hardening

State signature validation uses `timingSafeEqual`. Short-circuit
bypasses would open the service to lane-id spoofing (a malicious
client could submit `ade:<bogus-sig>:<someone-elses-laneId>:…` and
route the callback into a different lane's cookie jar). Keep this
check constant-time.

## IPC channels

| Channel | Description |
|---------|-------------|
| `ade.lanes.oauth.getStatus` | Config + active sessions snapshot |
| `ade.lanes.oauth.updateConfig` | Mutate `OAuthRedirectConfig` |
| `ade.lanes.oauth.generateRedirectUris` | Suggested URIs for provider setup |
| `ade.lanes.oauth.encodeState` | Manually encode for test/debug paths |
| `ade.lanes.oauth.decodeState` | Manually decode for test/debug paths |
| `ade.lanes.oauth.listSessions` | Live + historical sessions |
| `ade.lanes.oauth.event` | Stream of `OAuthRedirectEvent` |

`OAuthRedirectEvent` kinds:

- `oauth-callback-routed`
- `oauth-session-started`
- `oauth-session-completed`
- `oauth-session-failed`
- `oauth-config-changed`

## Gotchas

- **Never log `originalState` in plaintext beyond debug.** It may
  contain the provider's CSRF nonce. The existing `oauth_redirect.*`
  logs intentionally limit fields to `laneId`, `error`, and
  `reason`.
- **Session TTL is short on purpose.** 10 minutes matches typical
  user-attention timeframes for an OAuth consent screen. Do not
  extend silently — an orphaned pending state is a security risk.
- **Encoded state is stable across a single service lifetime only.**
  Restarting ADE rotates `stateSecret`, so any in-flight OAuth flow
  must be restarted. The error page references this so users don't
  think the provider is broken.
- **Error pages HTML-escape user input.** Lane ids, provider
  responses, and error messages are escaped via `esc()` inside
  `errorPage` / `proxyErrorPage`. Do not emit unescaped values;
  state-parameter strings can contain attacker-controlled bytes.
- **The finalize step is not optional.** Completing the flow at the
  stable callback hostname (`localhost:<proxyPort>`) rather than the
  lane hostname would lose cookie isolation. Tests (`test.ts` §7-ish)
  explicitly verify that the browser is redirected to the lane host
  finalize URL.
- **http.request mock scope.** The module mock at the top of the
  test file applies to the whole file; both tests that inject
  `requestUpstream` and tests that don't run under the mocked
  module. Tests that inject simply never trigger the mock. Do not
  remove the mock thinking it's unused — the native-path tests
  depend on it.
- **Provider detection is by hostname.** `detectProvider(location)`
  matches `google.`, `github.com`, `auth0.com`. Adding new providers
  means adding cases here; downstream UI uses the detected value
  for session labeling only.
