# ADE's machine template on Agent37: a Debian 12 box (or VM) whose main process
# is the ADE brain. Built by Agent37's cloud build (see ../build-template.sh); runs as
# the default `node` user with /home/node on the box's persistent disk.
FROM node:24-bookworm-slim

# git/gawk for ADE itself; tini as PID 1; the Linux Desktop lane screen needs
# xvfb, openbox, dbus, at-spi2-core, ffmpeg and a browser.
#
# /etc/machine-id stays absent: ADE's hardware anchor hashes it, and one value
# baked into the image would be shared by every box made from it, which makes
# the account directory merge different boxes into one row.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gawk tini python3 unzip procps \
      xvfb openbox dbus at-spi2-core ffmpeg chromium \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/machine-id /var/lib/dbus/machine-id

# The released ADE, installed into the image under /opt (the home folder is
# masked by the persistent disk at runtime). ADE_VERSION pins a release;
# "latest" takes the newest one at build time.
ARG ADE_VERSION=latest
RUN curl -fsSL https://ade-app.dev/install.sh -o /tmp/install.sh \
 && HOME=/opt ADE_HOME=/opt/ade ADE_VERSION="$ADE_VERSION" \
      ADE_INSTALL_NO_PROMPT=1 ADE_INSTALL_NO_PATH=1 sh /tmp/install.sh \
 && chmod -R a+rX /opt/ade && rm /tmp/install.sh \
 && ln -s /opt/ade/bin/ade /usr/local/bin/ade \
 && ade --version

# Docker, for projects whose setup starts a stack (docker compose, Supabase).
# Only a VM's own kernel runs it; on a sandboxed box the entrypoint skips it.
# dockerd needs root, and the brain runs as `node`: the one thing `node` may
# run as root is the entrypoint's own `--start-dockerd` step (sudoers below).
# Docker access is root-equivalent anyway, and the machine is the person's.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin \
      iptables kmod sudo \
 && rm -rf /var/lib/apt/lists/* \
 && usermod -aG docker node \
 && echo 'node ALL=(root) NOPASSWD: /usr/local/bin/ade-entrypoint.sh --start-dockerd' > /etc/sudoers.d/ade-dockerd \
 && chmod 440 /etc/sudoers.d/ade-dockerd

COPY ade-entrypoint.sh /usr/local/bin/ade-entrypoint.sh
RUN chmod 755 /usr/local/bin/ade-entrypoint.sh

USER node
WORKDIR /home/node
ENV ADE_HOME=/home/node/.ade \
    ADE_RUNTIME_ROOT=/opt/ade/runtime/linux-x64 \
    ADE_RUNTIME_NODE_MODULES=/opt/ade/runtime/linux-x64/node_modules \
    NODE_PATH=/opt/ade/runtime/linux-x64/node_modules
ENTRYPOINT ["tini", "--", "/usr/local/bin/ade-entrypoint.sh"]
