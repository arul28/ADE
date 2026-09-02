## Electron Control

Drive and inspect an Electron app from ADE — launch it or attach to one already
running, click and type in it, read its logs, and pull what is on screen into
the chat.

It works over the Chrome DevTools Protocol, so it drives Electron and Chromium
apps rather than native desktop apps.

This plugin replaces ADE's compiled Electron Control pane. Install it and the
Work tools talk to this package. Disable it and the compiled pane comes back
unchanged. The CDP engine stays in ADE.

### What it adds

- The **Electron Control** pane in the Work tools.
- A `get_status` tool. Click, type, launch and attach stay on `ade app-control`.

### Notes

- It drives apps on the computer this project is attached to, so it is a desktop
  pane. On a phone or in the terminal the plugin lists a status row pointing
  there.
- Desktop mounts ADE's compiled Control pane through a host canvas engine. Phone
  and terminal never run CDP.
- Agents keep using `ade app-control` — those verbs stay on the host.
