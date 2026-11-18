# The update gate (minimum ADE build)

The owner sets the oldest ADE build each kind of install may run. A build
below its minimum shows **"Update ADE to keep working"** with a button that
updates it, and nothing else in the app works until it updates. Work is never
lost: lanes, chats and saved work stay where they are.

Nothing moves the minimum except the owner's script. `/release` does not.

## Where it lives

- Server: `GET /client/minimum` on the account directory (public, no sign-in),
  one D1 row in `client_minimums` (migration 0045). Contract:
  `apps/account-directory/src/clientMinimumContract.ts`.
- The rule: `apps/desktop/src/shared/clientUpdateGate.ts`
  (`desktopUpdateRequirement`); iOS mirrors it in Swift.
- The script: `scripts/release-tools/client-minimum.mjs`.

## Who is blocked

A build is blocked only when all of these are true:

1. It is a released Stable or Beta desktop build, or an App Store, TestFlight
   or ADE Beta iPhone build. Alpha, dev and preview builds never are.
2. The owner set a minimum for its kind, and the build is below it.
3. An update that meets the minimum is published where that build updates
   from (its desktop track, the App Store, or TestFlight).
4. The app read the minimum in the last 12 hours. A failed read never blocks.

A user's other machines are judged by the same rule. A desktop or ADE Cloud
computer on an old ADE shows an "Update & restart" panel on every surface that
works on it (desktop, ADE Web, iPhone). A sleeping ADE Cloud computer is not
blocked; it updates itself when it wakes.

Builds released before the gate existed (v1.2.130 and older) do not have this
code. For them, only their own updater and the Sentry filter help.

## Set it

Run from the repository root:

```bash
ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID --env SENTRY_AUTH_TOKEN -- \
  node scripts/release-tools/client-minimum.mjs show

ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID --env SENTRY_AUTH_TOKEN -- \
  node scripts/release-tools/client-minimum.mjs set \
    --desktop-stable 1.2.131 --desktop-beta 1.2.131-beta.2 \
    --ios-app-store 1.1.11 --ios-testflight 10070 --ios-beta-app 10071 --dry-run
```

Drop `--dry-run` to apply it. Set only the values that are published: the
script refuses a minimum that no published build meets (a desktop version
newer than its track's newest release, an App Store version Apple does not
serve yet, a TestFlight build that is missing or still processing).

`set` also rewrites the Sentry release filters of `ade-desktop`, `ade-brain`
and `ade-ios`, so reports from builds below the minimum are dropped at
Sentry's edge. Other lines in those filters are kept. `--no-sentry` skips it.
Release filters need Sentry's Business plan. On a lower plan, Sentry refuses
("You do not have that feature enabled"), the script shows a WARNING, and it
exits 0 when the minimums are saved. A build that the gate blocks does not
send its own Sentry errors, logs or traces, so only builds older than the gate
still send reports.

Apps read the minimum at launch, when the window or app comes back to the
front after 30 minutes, and every 3 hours. The server caches it for a minute.

## Undo

```bash
ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID --env SENTRY_AUTH_TOKEN -- \
  node scripts/release-tools/client-minimum.mjs clear
```

Every app stops blocking on its next read (within a minute for a fresh read,
at most 3 hours). `clear` leaves the Sentry filters as they are.

## The iPhone

The App Store install compares its marketing version, and the App Store must
already serve that version (the iTunes lookup API). TestFlight installs of the
ADE app and the ADE Beta app compare build numbers. The update buttons open
the App Store page or the app's TestFlight public link.

Raise the iPhone minimums only after Apple approved the build and it is live,
or after the TestFlight build finished processing.
