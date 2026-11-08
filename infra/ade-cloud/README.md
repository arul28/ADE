# ADE Cloud machine template

The image ADE creates ADE Cloud boxes and VMs from ("New ADE Cloud machine" in
Add a computer, and ready machines). It is Debian 12 whose main process is
the ADE brain.

- `template/Dockerfile`: `node:24-bookworm-slim`, git/gawk/tini, the Linux
  Desktop lane screen packages (xvfb, openbox, dbus, at-spi2-core, ffmpeg,
  chromium), and the **released** ADE installed under `/opt/ade` with
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

ADE creates from the template named `ade`. A development desktop can point at a
trial template with `ADE_CLOUD_TEMPLATE=ade-a1-test`.

## Keeping it current

ADE does not build the template from the app. Run this script after a release
that changes `template/`. On first boot a new machine installs the ADE version
of the app that made it when the image's ADE is older, so a template only has to be rebuilt when the image or
the entrypoint changes.
