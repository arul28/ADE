# ADE Cloud machine template

The image ADE creates ADE Cloud boxes and VMs from ("New ADE Cloud machine" in
Add a computer, and ready machines). It is Debian 12 whose main process is
the ADE brain.

- `template/Dockerfile`: `node:24-bookworm-slim`, git/gawk/tini, the Linux
  Desktop lane screen packages (xvfb, openbox, dbus, at-spi2-core, ffmpeg,
  chromium), one app for each of the lane screen's "Browser", "Terminal" and
  "Files" buttons (chromium, xterm, thunar), fonts for pages and emoji
  (fonts-liberation, fonts-noto-color-emoji; DejaVu comes with fontconfig) and
  GTK's SVG icon loader (librsvg2-common). Those extras add about 30 MB
  installed: xterm 2.7, thunar 14.7, fonts-liberation 2.0,
  fonts-noto-color-emoji 10.5, librsvg2-common 0.1 (Debian 12 sizes, computed
  from the package index with `--no-install-recommends`). Then the **released**
  ADE installed under `/opt/ade` with
  `ade-app.dev/install.sh`. `ADE_HOME` is `/home/node/.ade`, on the box's
  persistent disk (ADE Cloud masks `/home/node` with it, so nothing of ADE's own
  is baked there).
- `template/ade-entrypoint.sh`: keeps `ade --role cto serve` running, with
  backoff. Being the entrypoint is what lets the brain survive an ADE Cloud
  sleep. It sets `ADE_HOST_INSTANCE_ID=cloud:<hostname>` (the hostname is the
  instance id), so a forked box starts signed out as a new machine.
- Docker (`docker-ce`, compose, buildx) for VMs. The entrypoint starts
  dockerd as root through a single sudoers rule (`ade-entrypoint.sh
  --root-setup`), after loading the netfilter modules the VM kernel ships
  unloaded; a sandboxed box (gVisor) skips it. It also sets `IS_SANDBOX=1`
  and `ADE_SUSPEND_GAP_TICK_MS=1000`, and runs a ready machine's setup job
  (`$ADE_HOME/ready/job.sh`) inside its own process tree so what the setup
  starts survives sleep. The root step also keeps Supabase's ports
  (54320-54329) out of the kernel's range for outgoing connections: a busy
  setup used to take one as an outgoing port right before Docker bound it.
- The Android SDK for the Android tool on a VM (`/opt/android-sdk`:
  platform-tools, emulator, cmdline-tools, the API 34 x86_64 image). The
  entrypoint sets `ANDROID_HOME`, and the root step gives `/dev/kvm` to group
  `node`. A box has no `/dev/kvm` and never uses it.
- The agents the baked ADE pins, read-only in `/opt/ade-tools` (the tools
  cache's own layout), installed by that ADE's `ade tools ensure`: by default
  `codex claude-code opencode` (build arg `ADE_BAKED_TOOLS`, or the
  `ADE_BAKED_TOOLS` env of `build-template.sh`). Each installs alone first; one
  that would take the image's files past `ADE_IMAGE_MAX_BYTES` (7.5 GB, under
  the 8 GB image cap) or fails to download is left out with a line in the
  build log, and downloads on first use instead. The brain uses a baked copy
  only while its version is the pin (`ADE_TOOLS_BAKED_ROOTS`).
- `/var/cache/ade` (owned by `node`) on the system layer for what ADE can
  rebuild: agents downloaded later (`ADE_SYSTEM_CACHE_ROOT`, about 7 GB
  budget `ADE_SYSTEM_CACHE_BUDGET_BYTES`, least recently used out first,
  overflow to `/home/node/.ade/tools`) and the npm, pip and yarn caches
  (`npm_config_cache`, `PIP_CACHE_DIR`, `YARN_CACHE_FOLDER`).
  `ADE_TOOLS_PREFETCH=used` keeps the brain's startup fetch to agents this
  computer ran. An image update resets the folder to empty, and each agent
  downloads again on its first use, so there is no `post-image-update.sh`.
- A move to another machine pauses the brain while its home is copied: the
  entrypoint's loop waits while `$ADE_HOME/brain.paused` exists.
- The entrypoint's loop is the brain's supervisor (the box has no systemd).
  It exports `ADE_BRAIN_SUPERVISOR=entrypoint` and starts the newer of
  `/opt/ade/bin/ade` and the `~/.ade/bin/ade` that `ade brain update`
  installs, so an update takes effect when the brain restarts. With
  `ADE_MIN_VERSION` set (the create flow sets it), the first boot installs
  that release first when the image's ADE is older.
- `/etc/machine-id` and `/var/lib/dbus/machine-id` are deleted in the image.
  ADE's hardware anchor hashes them; one baked value would make the account
  directory merge every box into one row.

Nothing is signed in inside the image. A new box signs in after it starts:
the ADE that made it runs `ade login --headless` on it over the provider's exec and
approves the code with its own account (see
`apps/desktop/src/main/services/adeCloud/cloudMachineCreator.ts`).

## Build and publish

This folder is where the provider's name is allowed: the template is built on
Agent 37 with its cloud build (`npx agent37 templates build`), into the
workspace the key belongs to. No local Docker is needed.

```sh
AGENT37_API_KEY=sk_live_... infra/ade-cloud/build-template.sh            # template "ade", latest ADE
AGENT37_API_KEY=sk_live_... infra/ade-cloud/build-template.sh ade-a1-test # a trial template
AGENT37_API_KEY=sk_live_... infra/ade-cloud/build-template.sh ade 1.2.128 # pin an ADE release
```

The build takes about 13.5 minutes (2026-11-06: 2.5 for the steps, 11 for
the provider to save and ingest the image). Building an existing name publishes a
new revision; boxes already made keep their image, and `ade brain update`
updates their ADE.

ADE's server creates from the exact template version pinned in `cloud_settings`
for the computer's update channel (`template_version_stable` or
`template_version_beta`, like `ade@8`; `template_version` is the older single
setting and the fallback). Bare `ade` means newest and is never sent.

## Every release builds it

`.github/workflows/cloud-template.yml` builds the template named `ade` from a
release's tag once that release's files are public: on stable publish (the
`release` trigger, when the release skill undrafts it) and from `beta.yml`
beside the feed job. Previews do not build one. Each build gets the next build
number, `ade@N`, written to the run's summary.

A second job, `promote-template`, then tests that build with
`promote-template.mjs` (below) and, only on a pass, moves the image of the
tag's channel: a tag with `-` (beta, alpha, rc) moves Beta, any other tag moves
Stable. Stable never moves to a prerelease. It also checks that the computer
runs exactly the tag's ADE. A failed test moves nothing. Both jobs are allowed
to fail and nothing waits on them. The build needs the secret
`AGENT37_API_KEY`, and the test also `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` (for `wrangler d1 execute`); without them the job skips
with a warning. Rerun it by hand from the Actions tab (it takes a tag).

Once a channel's image moves, the computers on that channel update themselves
the next time they are idle or asleep (`apps/account-directory/src/cloud/updates.ts`,
and "Updates" in `docs/features/ade-cloud/README.md`).

## Testing a build and moving the version

`infra/ade-cloud/promote-template.mjs` tests one build on a real computer: it
creates one from `ade@N` (tagged `created_by: ade-template-check`), checks ADE is there and
its version (with `--expect-version`, exactly that release), that a command
runs and that ADE's brain answers, that a real repository (a tiny public one,
cloned) opens as a project, its lanes list, a new lane appears in that list and
a terminal runs a command (`ade@9` passed without a project check and could not
open a project), that a file in `/home/node` survives sleep and wake and then
stop and start, and deletes the computer in a `finally` (Ctrl-C included). The
whole test gives up after 20 minutes, and deletes the computer then too. It
prints first-start timings.

```sh
AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9                       # test only
AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9 --move --channel beta --expect-version v1.2.130-beta.1 --env production
AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs --move-back 8 --channel stable --env production
```

`--move` runs only after a passing test and writes, through
`wrangler d1 execute` (`--env` is `production`, `development` or `local`):

- `--channel beta`: `template_version_beta` and `auto_update_beta`.
- `--channel stable`: `template_version_stable`, `template_version` and
  `auto_update_stable`. It refuses a prerelease build.

`auto_update_<channel>` is the image a passed test lets that channel's
computers update to on their own; a person's "Update this computer" goes to
the channel's image whatever it says. `--move-back` is the same step for a
previous build and runs no test: the channel's computers then move back to
that build when idle or asleep. Add `--min-version vX.Y.Z` to time the
first-start install of a newer ADE.

To stop automatic updates for a channel (new computers and a person's update
still use the channel's image), set its marker to `off`:

```sh
cd apps/account-directory
npx wrangler d1 execute ade-account-directory-production --remote --env production \
  --command "UPDATE cloud_settings SET value = 'off', updated_at = $(date +%s000) WHERE key = 'auto_update_stable';"
```

Measured on 2026-11-08 with `ade@8` (ADE 1.2.129-beta.24, a 2 CPU / 4 GB computer
on a 4 GB disk): create answered in 0.8 s, first command at 1.1 s, `ade --version`
at 2.4 s, ADE's brain answering at 4.0 s. Sleep 1.3 s, wake to a brain answering
1.9 s; stop 1.1 s, start to a brain answering 3.7 s.

A computer that an ADE older than the template already built keeps its image
until it is updated; `ade brain update` updates its ADE. On first boot a new
computer installs the ADE version of the app that made it when the image's ADE
is older (`ADE_MIN_VERSION`).
