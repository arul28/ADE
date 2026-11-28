# OAuth redirect service

Routes OAuth callbacks back to the right lane when many lanes share one OAuth
provider setup. It runs on the machine that holds the lane proxy, inline on the
proxy's request path. It owns three state machines and signed state; treat it
with care.

Source: `apps/desktop/src/main/services/lanes/oauthRedirectService.ts` and its
test file. The brain and the unbound desktop path both use it.

## Why

Providers want exact redirect URIs, and one per lane is impractical or
unsupported. DAEX offers:

1. **State-parameter routing (default):** the lane id is encoded into the
   OAuth `state`, so one stable callback URL serves every lane.
2. **Hostname routing (opt-in):** if the provider accepts wildcard redirect
   URIs (`*.localhost`), each lane's `<slug>.localhost` routes naturally.

## Flow (state-parameter mode)

```
1. Sign-in starts on the lane preview URL (feat-auth.localhost:8080/auth/login)
2. The app redirects to the provider with state=raw and redirect_uri on the lane host
3. The proxy intercepts the 302:
   - encodedState = ade:<hmac>:<base64url(laneId)>:<originalState>
   - redirect_uri → http://localhost:<proxyPort>/oauth/callback
   - stores a PendingOAuthStartSession keyed by encodedState
4. The browser goes to the provider
5. The provider calls back http://localhost:<proxyPort>/oauth/callback?code=…&state=encodedState
6. The proxy decodes the state, finds the pending start, forwards to the lane's
   app with the original state, and captures the response (PendingFinalizeSession)
7. The proxy answers 302 → http://<lane-host>:<proxyPort>/__ade/oauth/finalize?token=…
8. The finalize request replays the captured response on the lane's hostname
```

Steps 6–8 exist so cookies land on the lane's hostname, not on
`localhost:<proxyPort>`. That is what makes isolation work.

## State encoding

`ade:<signature>:<base64url(laneId)>:<originalState>` (`STATE_PREFIX = "ade"`,
a wire format kept as is). The signature is HMAC-SHA256 of `laneId + "\0" +
originalState`, keyed by a per-instance `stateSecret` (32 random bytes, new on
every service start). `decodeState` strips the prefix, splits, recomputes the
signature and compares with `timingSafeEqual`; a mismatch logs
`oauth_redirect.signature_mismatch` and returns null. A restart therefore
invalidates every in-flight flow, by design.

## Three state machines

1. **`pendingStarts`** (`encodedState` → `PendingOAuthStartSession`): lane id,
   hostname, target port, original state and callback path, `cookiePairs`
   (incoming Cookie plus the app's Set-Cookie, so the callback has the same
   jar), provider, session id. Moved to `pendingFinalize` by
   `handleManagedCallback`, or expired after `OAUTH_SESSION_TTL_MS` (10
   minutes) by `removeExpiredPendingSessions`, which runs on every request.
2. **`pendingFinalize`** (`oauth-finalize-<uuid>` → captured response):
   removed when `/__ade/oauth/finalize?token=…` replays it, or after 10 minutes.
3. **`sessions`** (`OAuthSession`, via `listSessions()`): `pending → active →
   completed | failed`, with events `oauth-session-started`,
   `oauth-callback-routed`, `oauth-session-completed`, `oauth-session-failed`
   (plus `oauth-config-changed`).

## Request entry point

`handleRequest(req, res)` is a `ProxyRequestInterceptor` on
`laneProxyService`; `true` means handled. Order:

1. Disabled → false.
2. `removeExpiredPendingSessions()`.
3. `FINALIZE_CALLBACK_PATH` (`/__ade/oauth/finalize`) → `handleFinalizeRequest`.
4. A state that decodes to a known pending start → `handleManagedCallback`.
5. GET/HEAD on a lane hostname under `AUTH_START_PATH_PREFIXES` (`/api/auth/`,
   `/auth/`, `/oauth/`) → `handleAuthStartRequest` (inspects the redirect).
6. Otherwise false.

`defaultRequestUpstream` wraps `http.request`: lane-scoped headers (Host,
X-Forwarded-*, optional Cookie), a 30 s timeout through `AbortController`,
bodies buffered for non-GET/HEAD and sent after the client's `end`, client
`aborted`/`close`/`error` abort the upstream, and `cleanup()` on every
settlement. The service accepts an injected `requestUpstream` for most tests.

## Redirect URIs and IPC

`generateRedirectUris(provider?)` returns the stable
`http://localhost:<proxyPort>/oauth/callback` and a per-lane
`http://<slug>.localhost:<proxyPort>/oauth/callback` for each active route.
No settings panel shows them; they are reachable through IPC.

| Channel | Description |
|---------|-------------|
| `ade.lanes.oauth.getStatus` | Config and active sessions |
| `ade.lanes.oauth.updateConfig` | Change `OAuthRedirectConfig` |
| `ade.lanes.oauth.generateRedirectUris` | URIs to register with the provider |
| `ade.lanes.oauth.encodeState` / `.decodeState` | Debug helpers |
| `ade.lanes.oauth.listSessions` | Live and past sessions |
| `ade.lanes.oauth.event` | `OAuthRedirectEvent` stream |

## Gotchas

- **Keep the signature check constant-time.** A shortcut lets a client route a
  callback into another lane's cookie jar.
- **The finalize step is not optional.** Finishing at `localhost:<proxyPort>`
  loses cookie isolation.
- **Never log `originalState`** beyond debug; it may hold the provider's CSRF
  nonce. `oauth_redirect.*` logs carry only `laneId`, `error`, `reason`.
- **The 10-minute TTL is deliberate.** Orphaned pending state is a risk.
- **Error pages escape everything** through `esc()` in `errorPage` /
  `proxyErrorPage`; state strings can carry attacker bytes.
- **Tests mock `node:http` for the whole file.** Tests that drive
  `defaultRequestUpstream` omit the injection and use `httpRequestMock`,
  `makeFakeUpstream()` and `primePendingStart()`. Do not remove the mock as
  unused. Those tests pin GET with no body buffering, the 30 s timeout (502),
  POST chunk buffering, client abort/close, and no late writes after success.
- **Provider detection is by hostname** (`detectProvider`: Google, GitHub,
  Auth0), used for session labels only.
