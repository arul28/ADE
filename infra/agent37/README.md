# ADE's Agent37 machine template

The image ADE creates Agent37 boxes from ("New Agent37 machine" in Add a
computer). It is a Debian 12 box whose main process is the ADE brain.

- `template/Dockerfile`: `node:24-bookworm-slim`, git/gawk/tini, the Linux
  Desktop lane screen packages (xvfb, openbox, dbus, at-spi2-core, ffmpeg,
  chromium), and the **released** ADE installed under `/opt/ade` with
  `ade-app.dev/install.sh`. `ADE_HOME` is `/home/node/.ade`, on the box's
  persistent disk (Agent37 masks `/home/node` with it, so nothing of ADE's own
  is baked there).
- `template/ade-entrypoint.sh`: keeps `ade --role cto serve` running, with
  backoff. Being the entrypoint is what lets the brain survive an Agent37
  sleep. It sets `ADE_HOST_INSTANCE_ID=agent37:<hostname>` (the hostname is the
  instance id), so a forked box starts signed out as a new machine.
- `/etc/machine-id` and `/var/lib/dbus/machine-id` are deleted in the image.
  ADE's hardware anchor hashes them; one baked value would make the account
  directory merge every box into one row.

Nothing is signed in inside the image. A new box signs in after it starts:
the ADE that made it runs `ade login --headless` on it over Agent37 exec and
approves the code with its own account (see
`apps/desktop/src/main/services/agent37/agent37MachineCreator.ts`).

## Build and publish

Agent37 templates are per workspace, so the build publishes into the workspace
the key belongs to. It uses Agent37's cloud build (`npx agent37 templates
build`); no local Docker is needed.

```sh
AGENT37_API_KEY=sk_live_... infra/agent37/build-template.sh            # template "ade", latest ADE
AGENT37_API_KEY=sk_live_... infra/agent37/build-template.sh ade-a1-test # a trial template
AGENT37_API_KEY=sk_live_... infra/agent37/build-template.sh ade 1.2.128 # pin an ADE release
```

The build takes about five minutes. Building an existing name publishes a new
revision; boxes already made keep their image until they are updated.

ADE creates from the template named `ade`. A development desktop can point at a
trial template with `ADE_AGENT37_TEMPLATE=ade-a1-test`.

## Known gaps

- Every user's workspace needs the template, and today only this script puts
  it there. See "Template distribution" in `docs/plans/agent37-integration.md`.
- The image installs whatever ADE release is current at build time. A box from
  ADE 1.2.128 needs a registered project before another computer can connect
  to it (fixed on `ade/agent37-integration`, not yet released).
