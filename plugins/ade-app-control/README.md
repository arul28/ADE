## Electron Control

Drive and inspect an Electron app from ADE — launch it or attach to one already
running, click and type in it, read what is on screen, and pull an element's
source context into the chat.

It works over the Chrome DevTools Protocol, so it drives Electron and Chromium
apps rather than native desktop apps.

This plugin replaces ADE's compiled Electron Control pane. Install it and the
Work tools talk to this package. Disable it and the compiled pane comes back
unchanged. The CDP engine stays in ADE.

### What it adds

- The **Electron Control** pane in the Work tools, and the same page from the
  command palette.
- A `get_status` tool. Click, type, launch and attach also stay on
  `ade app-control`, which is what agents use.

### The page

The pane is the plugin's own HTML page (`page/`, built into `dist/`), not a
vocabulary panel. It carries all the chrome — the launch and attach rows, the
status pill, the window picker, the blockers card, the inspect list and the
type-text field — and it reserves a rect that ADE paints the live app view into.

That split is the point. A CDP screencast is thirty frames a second, and relaying
those through the plugin bridge would be a structured clone per frame for a
picture the guest would decode again. So the picture stays a host engine and the
page places it. `page/README.md` has the placement contract; `PARITY.md` has what
the page carries against the compiled pane and, at the end, what it does not.

A host too old to paint an engine draws a sentence where the picture goes and
keeps every other verb working, which is most of the product.

### Notes

- It drives apps on the computer this project is attached to, so it is a desktop
  page. There is no phone placement, deliberately: no phone is the computer the
  Electron app is running on. On a phone and in the terminal the plugin lists a
  status row plus the line saying so.
- The launch command, the working directory and the CDP port are remembered per
  project in the plugin's own `ui-state` collection, which does not sync — they
  describe a process on one machine.
- Agents keep using `ade app-control` — those verbs stay on the host.
