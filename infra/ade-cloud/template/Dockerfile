# ADE's machine template on the provider: a Debian 12 box (or VM) whose main process
# is the ADE brain. Built by the provider's cloud build (see ../build-template.sh); runs as
# the default `node` user with /home/node on the box's persistent disk.
FROM node:24-bookworm-slim

# git/gawk for ADE itself; tini as PID 1; the Linux Desktop lane screen needs
# xvfb, openbox, dbus, at-spi2-core, ffmpeg and a browser.
#
# The lane screen's "Browser", "Terminal" and "Files" buttons need one app of
# each kind: chromium, xterm (2.7 MB installed) and thunar (14.7 MB: GTK 3,
# which chromium already brings, so the accessibility tree reads it; pcmanfm
# is GTK 2 here and adds 32 MB). Fonts: fontconfig already brings DejaVu
# (sans, serif, mono); fonts-liberation (2.0 MB) gives pages Arial/Times/
# Courier metrics, fonts-noto-color-emoji (10.5 MB) draws emoji instead of
# boxes, and librsvg2-common (0.1 MB) lets GTK draw its SVG icons. About
# 30 MB in all (Debian 12 package sizes, --no-install-recommends).
#
# /etc/machine-id stays absent: ADE's hardware anchor hashes it, and one value
# baked into the image would be shared by every box made from it, which makes
# the account directory merge different boxes into one row.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gawk tini python3 unzip procps \
      xvfb openbox dbus at-spi2-core ffmpeg chromium \
      xterm thunar fonts-liberation fonts-noto-color-emoji librsvg2-common \
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
# run as root is the entrypoint's own `--root-setup` step (sudoers below).
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
 && echo 'node ALL=(root) NOPASSWD: /usr/local/bin/ade-entrypoint.sh --root-setup' > /etc/sudoers.d/ade-root-setup \
 && chmod 440 /etc/sudoers.d/ade-root-setup

# The Android SDK, for the Android tool on a VM (a sandboxed box has no
# /dev/kvm and never uses it). In the image rather than on the machine's disk:
# read-only at runtime, and it costs nothing against the disk. Java is only
# for sdkmanager here: ADE needs none at runtime. The entrypoint sets
# ANDROID_HOME for the brain.
ARG ANDROID_CMDLINE_TOOLS_ZIP=commandlinetools-linux-16111833_latest.zip
ARG ANDROID_SYSTEM_IMAGE="system-images;android-34;google_apis;x86_64"
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-jre-headless libgl1 libglu1-mesa libnss3 libpulse0 libasound2 libdbus-1-3 \
      libxcomposite1 libxcursor1 libxdamage1 libxi6 libxrandr2 libxtst6 libxkbcommon-x11-0 libfontconfig1 \
 && sdk=/opt/android-sdk \
 && curl -fsSL "https://dl.google.com/android/repository/${ANDROID_CMDLINE_TOOLS_ZIP}" -o /tmp/clt.zip \
 && mkdir -p "$sdk/cmdline-tools" && unzip -q /tmp/clt.zip -d "$sdk/cmdline-tools" \
 && mv "$sdk/cmdline-tools/cmdline-tools" "$sdk/cmdline-tools/latest" && rm /tmp/clt.zip \
 && yes | ANDROID_HOME="$sdk" "$sdk/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null \
 && ANDROID_HOME="$sdk" "$sdk/cmdline-tools/latest/bin/sdkmanager" --install "platform-tools" "emulator" "$ANDROID_SYSTEM_IMAGE" > /dev/null \
 # Java only runs sdkmanager here: ADE writes AVDs and reads hardware profiles
 # itself (androidAvds.ts), so the image doesn't carry a JRE.
 && apt-get purge -y default-jre-headless && apt-get autoremove -y --purge \
 && { rm -rf /var/lib/apt/lists/* /root/.android "$sdk/.temp" || true; } \
 && chmod -R a+rX "$sdk"

# The agents this ADE release pins, baked in read-only under /opt/ade-tools
# (the tools cache's own layout), so a lane's first turn on Codex, Claude or
# OpenCode downloads nothing. They are exactly the versions the ADE above pins:
# `ade tools ensure` installs its own manifest. ADE uses a baked copy only
# while its version is the pin, so an `ade brain update` past this image
# downloads the new pin instead (onto the system layer, below).
#
# Last of the big steps, so the size check sees the whole image: a tool that
# would take the image's files past ADE_IMAGE_MAX_BYTES (under the 8 GB image
# cap) is left out, and a tool whose download fails is left out too; either
# way the lane downloads it on first use. Each tool installs alone first, so
# its size is known before it joins the image.
ARG ADE_BAKED_TOOLS="codex claude-code opencode"
ARG ADE_IMAGE_MAX_BYTES=7500000000
RUN set -eu; baked=/opt/ade-tools; scratch=/tmp/ade-bake; mkdir -p "$baked"; \
    for tool in $ADE_BAKED_TOOLS; do \
      root="$scratch/$tool"; \
      if ! HOME="$scratch/home" ADE_HOME="$scratch/home/.ade" ADE_TOOLS_ROOT="$root" \
           ade tools ensure "$tool" > "$scratch.log" 2>&1 \
         || [ -z "$(find "$root" -name .install-complete 2>/dev/null | head -n 1)" ]; then \
        echo "bake: $tool did not install; it downloads on first use" >&2; cat "$scratch.log" >&2 || true; \
        rm -rf "$root"; continue; \
      fi; \
      rm -rf "$root/.staging" "$root/.locks" "$root"/.*.json; \
      tool_kb=$(du -sk "$root" | cut -f1); \
      image_kb=$(du -sxk --exclude="$scratch" / 2>/dev/null | cut -f1); \
      if [ $(( (image_kb + tool_kb) * 1024 )) -gt "$ADE_IMAGE_MAX_BYTES" ]; then \
        echo "bake: $tool ($tool_kb KB) would take the image past $ADE_IMAGE_MAX_BYTES bytes; left out" >&2; \
        rm -rf "$root"; continue; \
      fi; \
      cp -a "$root/." "$baked/"; rm -rf "$root"; \
      echo "bake: $tool baked ($tool_kb KB; image now about $(( (image_kb + tool_kb) / 1024 )) MB)"; \
    done; \
    rm -rf "$scratch" "$scratch.log"; chmod -R a+rX "$baked"; \
    # The system layer's cache folder (see ADE_SYSTEM_CACHE_ROOT below).
    mkdir -p /var/cache/ade/tools && chown -R node:node /var/cache/ade

COPY ade-entrypoint.sh /usr/local/bin/ade-entrypoint.sh
RUN chmod 755 /usr/local/bin/ade-entrypoint.sh

USER node
WORKDIR /home/node
# Where ADE keeps what it can rebuild, read by the brain (tools/paths.ts) and
# the package managers the lane runs. /home/node is the person's billed disk;
# everything outside it is the provider's unbilled system layer, which an
# image update resets. So: the baked agents first; agents downloaded later and
# package caches on the system layer within ~7 GB of its 10 GB (least recently
# used out first), falling back to /home/node only when that cannot fit. After
# an image update the folder starts empty and each agent downloads again on
# its first use, so nothing needs restoring (no post-image-update hook).
# ADE_TOOLS_PREFETCH=used: the brain fetches at startup only the agents this
# computer ran, never every agent whose sign-in was copied here.
ENV ADE_HOME=/home/node/.ade \
    ADE_RUNTIME_ROOT=/opt/ade/runtime/linux-x64 \
    ADE_RUNTIME_NODE_MODULES=/opt/ade/runtime/linux-x64/node_modules \
    NODE_PATH=/opt/ade/runtime/linux-x64/node_modules \
    ADE_TOOLS_BAKED_ROOTS=/opt/ade-tools \
    ADE_SYSTEM_CACHE_ROOT=/var/cache/ade \
    ADE_SYSTEM_CACHE_BUDGET_BYTES=7000000000 \
    ADE_TOOLS_PREFETCH=used \
    npm_config_cache=/var/cache/ade/npm \
    PIP_CACHE_DIR=/var/cache/ade/pip \
    YARN_CACHE_FOLDER=/var/cache/ade/yarn
ENTRYPOINT ["tini", "--", "/usr/local/bin/ade-entrypoint.sh"]
