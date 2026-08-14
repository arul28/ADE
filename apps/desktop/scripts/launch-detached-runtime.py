#!/usr/bin/env python3
"""Detach `npm run dev:runtime -- --no-sync` so ADE chat shells cannot SIGKILL it.

Rebuilds apps/ade-cli (do not pass --skip-runtime-build). Attach Electron
afterwards with launch-detached-dev.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PROFILE = Path(__file__).resolve().parents[1] / ".ade" / "dev-profile"
LOG_PATH = PROFILE / "runtime.log"
PID_PATH = PROFILE / "runtime.pid"
STDIN_PATH = PROFILE / "stdin"

STRIP_ENV_KEYS = (
    "ELECTRON_RUN_AS_NODE",
    "ADE_PACKAGE_CHANNEL",
    "ADE_DESKTOP_APP_NAME",
    "ADE_RUNTIME_SOCKET_PATH",
    "ADE_DEV_RUNTIME_SOCKET_PATH",
    "ADE_DESKTOP_USER_DATA_PATH",
    "ADE_CHAT_SESSION_ID",
    "ADE_PARENT_CHAT_SESSION_ID",
    "ADE_SPAWN_KIND",
    "ADE_RUNTIME_PACKAGED",
    "ADE_DISABLE_RUNTIME_SERVICE_INSTALL",
    "ADE_BROWSER_ACTOR_TOKEN",
    "ADE_CLI_BIN_DIR",
    "ADE_CLI_PATH",
    "ADE_AGENT_SKILLS_DIRS",
    "ADE_BUNDLED_AGENT_SKILLS_DIR",
    "ADE_LANE_ID",
    "ADE_WORKSPACE_ROOT",
    "CURSOR_AGENT",
    "CURSOR_CONVERSATION_ID",
    "ADE_RUNTIME_PARENT_PID",
    "ADE_RUNTIME_IDLE_EXIT_MS",
)

STRIP_ENV_PREFIXES = (
    "ADE_CURSOR_SDK_",
    "CURSOR_API_",
)


def sanitized_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in STRIP_ENV_KEYS:
        env.pop(key, None)
    for key in list(env):
        if any(key.startswith(prefix) for prefix in STRIP_ENV_PREFIXES):
            env.pop(key, None)
    return env


def main() -> int:
    PROFILE.mkdir(parents=True, exist_ok=True)
    STDIN_PATH.write_bytes(b"")
    LOG_PATH.write_bytes(b"")

    with STDIN_PATH.open("rb") as stdin, LOG_PATH.open("ab") as log:
        proc = subprocess.Popen(
            ["npm", "run", "dev:runtime", "--", "--no-sync"],
            cwd=str(REPO),
            env=sanitized_env(),
            stdin=stdin,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )

    PID_PATH.write_text(f"{proc.pid}\n")
    print(f"launched runtime pid={proc.pid}")
    print(f"log={LOG_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
