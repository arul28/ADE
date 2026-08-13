## Electron Control

Drive and inspect an Electron app from ADE — launch it or attach to one already
running, click and type in it, read its logs, and pull what is on screen into
the chat.

It works over the Chrome DevTools Protocol, so it drives Electron and Chromium
apps rather than native desktop apps.

Electron Control was part of ADE itself until plugins existed. Nothing about it
changed — it stopped being something everyone has to carry.

### What it adds

- The **Electron Control** pane in the Work tools, and its chat drawer.

### Notes

- It drives apps on the computer this project is attached to, so it is a desktop
  pane. On a phone or in the terminal the plugin shows a card pointing there.
- The pane is drawn by the desktop app rather than published as a panel, because
  it owns a live connection to the app it is driving.
- It runs no code at all: the card is `panels/main.json`, which ADE reads from
  the manifest. Nothing is read, and nothing is stored.
