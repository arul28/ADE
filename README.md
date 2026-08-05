<p align="center">
  <a href="https://ade-app.dev">
    <img src="assets/logo.png" alt="ADE" width="240" />
  </a>
</p>

<p align="center">
  <strong>Your workspace for every AI coding agent.</strong><br />
  <em>macOS, Windows, iOS, and CLI all synced in real time. (android mobile app almost ready)</em>
</p>

<p align="center">
  <a href="https://ade-app.dev/download/mac-arm64"><img src="https://img.shields.io/badge/Download_for_macOS-7C3AED?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  &nbsp;
  <a href="https://ade-app.dev/download/windows"><img src="https://img.shields.io/badge/Download_for_Windows-12101a?style=for-the-badge&logo=windows&logoColor=a78bfa" alt="Download for Windows" /></a>
  &nbsp;
  <a href="https://testflight.apple.com/join/ZSdJGKPy"><img src="https://img.shields.io/badge/Download_for_iOS-12101a?style=for-the-badge&logo=apple&logoColor=a78bfa" alt="Download for iOS" /></a>
  &nbsp;
  <a href="https://ade-app.dev"><img src="https://img.shields.io/badge/Website-12101a?style=for-the-badge&logo=googlechrome&logoColor=a78bfa" alt="Website" /></a>
  &nbsp;
  <a href="https://ade-app.dev/docs"><img src="https://img.shields.io/badge/Docs-12101a?style=for-the-badge&logo=readthedocs&logoColor=a78bfa" alt="Docs" /></a>
  &nbsp;
  <a href="https://github.com/arul28/ADE"><img src="https://img.shields.io/badge/GitHub-12101a?style=for-the-badge&logo=github&logoColor=a78bfa" alt="GitHub" /></a>
</p>

<p align="center">
  <a href="https://github.com/arul28/ADE/releases/latest"><img src="https://img.shields.io/github/v/release/arul28/ADE?style=flat-square&label=release&labelColor=12101a&color=a78bfa" alt="Latest release" /></a>
  <a href="https://github.com/arul28/ADE/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/arul28/ADE/ci.yml?branch=main&style=flat-square&label=CI&labelColor=12101a&color=7c3aed" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-7c3aed?style=flat-square&labelColor=12101a" alt="AGPL-3.0" /></a>
  <img src="https://img.shields.io/github/downloads/arul28/ADE/total?style=flat-square&label=downloads&labelColor=12101a&color=a78bfa" alt="Downloads" />
  <a href="https://github.com/arul28/ADE/stargazers"><img src="https://img.shields.io/github/stars/arul28/ADE?style=flat-square&labelColor=12101a&color=a78bfa" alt="Stars" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-efe6d0?style=flat-square&labelColor=12101a" alt="macOS 13+" />
  <img src="https://img.shields.io/badge/Windows-10%2F11%20x64%20beta-efe6d0?style=flat-square&labelColor=12101a" alt="Windows 10/11 x64 beta" />
</p>

<p align="center">
  <a href="https://ade-app.dev"><img src="assets/readme/hero.png" alt="ADE — every AI coding tool, one app that runs everywhere" width="900" /></a>
</p>

ADE runs **Claude Code, Codex, Cursor, Factory Droid, OpenCode** (more coming soon) in one workspace that you can open from any machine you own, the web, or a mobile app. The best part? It's completely free.

Simply sign in to ADE on a machine you own, and you can magically run and manage agents from any other ADE client. In real time, every single ADE chat or CLI session (yes even your CLI sessions) syncs to every other device.

I can start a thread on my desktop at home, pick it up on my phone at the gym, and then finish it off from a website on my friend's computer. It works like magic, and removes the friction of managing agents on the go.

Beyond agent management, ADE (like the name implies) offers a full development environment. This means git management, a full file editing/viewing experience like VS Code, PR management, automations, GitKraken inspired history, and more. This one app is meant to replace every single modern dev tool.

---

<table>
<tr>
<td width="50%" valign="top">
  <img src="assets/readme/grid-view.gif" alt="ADE desktop app — parallel agents in grid view" width="100%" />

**Desktop app**

The full workspace. Every agent and every worktree, tiled side by side. macOS and Windows.

</td>
<td width="50%" valign="top">
  <img src="assets/readme/web-client.png" alt="ADE web client running in a browser" width="100%" />

**Web client**

The same workspace in a browser at [app.ade-app.dev](https://app.ade-app.dev). Nothing to install — sign in and your machines are there.

</td>
</tr>
<tr>
<td width="50%" valign="top">
  <img src="assets/readme/ade-code-tui.gif" alt="ade code — the terminal-native TUI" width="100%" />

**Terminal**

`ade code` is ADE, terminal-native — the same worktrees, chats, and PRs in a fast TUI. Works over SSH.

</td>
<td width="50%" valign="top" align="center">
  <img src="assets/readme/mobile-chat.webp" alt="ADE on iOS" width="47%" />
  &nbsp;
  <img src="assets/readme/mobile-pr.webp" alt="ADE on iOS — pull requests" width="47%" />

**Mobile app**

Every worktree, agent, and PR synced to iOS. Start a task on the desktop, approve the diff from the train.

</td>
</tr>
</table>

## Install

Think of ADE as having 4 UI clients (web, desktop app, terminal, and mobile app) you can interact and work with. Each one of those clients needs to connect to a machine, and it does that via "ADE Brain". You can install the Brain to any machine, and magically it will then be accessible and controllable by any of those UI clients. The machine just needs to stay on, and suddenly you get a full agentic development experience from anywhere. 

This one command below installs the **ADE brain** — the always-on engine that every ADE UI client talks to. Running this command will also optionally ask you to install the desktop app, which is one of the four UI clients, and the most powerful one. This command will also ask you to sign up or login to your ADE account. Your ADE account is what lets you seamlessly connect to all other machines you use. Of course, you can use ADE without an account, you will just have to connect to your machines to an ADE Brain via LAN, Tailscale, or SSH. 

**macOS and Linux**

```bash
curl -fsSL https://ade-app.dev/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://ade-app.dev/install.ps1 | iex
```

**Want to install the full Desktop App + Brain via a dmg or exe file?** Download it from [**GitHub Releases**](https://github.com/arul28/ADE/releases/latest) or [ade-app.dev](https://ade-app.dev) instead. That gets you the same thing as the above command, but with the above command you can opt out of the desktop app and only install the Brain, these download files bundle it all together. Note - linux doesnt have a desktop app yet, only Brain.

If you already have the Brain installed, and want the desktop app, you can safely run the command above, or install the appropriate download file. 

### Desktop app

macOS and Windows. Install it with the one-liner above, or download it directly:

[**macOS · Apple Silicon**](https://ade-app.dev/download/mac-arm64) · [**macOS · Intel**](https://ade-app.dev/download/mac-x64) · [**Windows x64**](https://ade-app.dev/download/windows)

Requirements: macOS 13+, or Windows 10/11 **x64** (ARM64 unsupported)

Windows is in **beta** and may be a little buggy, PR's and bug reports are encouraged to help grow this project. Due to lack of support and general Windows quirks, some features are not available that work on MacOS, nothing major though. Full detail: [docs/development/windows-support.md](docs/development/windows-support.md).

<sub>If you prefer Homebrew, this command installs the full desktop app + ADE Brain: `brew install --cask arul28/ade/ade`</sub>

#### Linux

There is no Linux desktop app yet, but it can run the Brain. You can install it on any x64 or arm64 box with the one-liner command from above, and that machine becomes reachable from any ADE UI Client. 

Brain-only downloads, if you would rather not pipe a script: [`darwin-arm64`](https://ade-app.dev/download/brain/darwin-arm64) · [`darwin-x64`](https://ade-app.dev/download/brain/darwin-x64) · [`linux-arm64`](https://ade-app.dev/download/brain/linux-arm64) · [`linux-x64`](https://ade-app.dev/download/brain/linux-x64) · [`win32-x64`](https://ade-app.dev/download/brain/win32-x64).

### Terminal

Nothing extra to install — once you have the ADE Brain installed, either via the single command above or by installing the full desktop app, you can simply run:

```bash
ade code
```

On macOS and Linux this binary lives in `~/.ade/bin`, and the installer asks before adding it to your `PATH`. It writes `~/.ade/env` and drops one marked line into your shell profile, so say yes and new terminals just work. Say no and nothing gets touched, or set `ADE_INSTALL_NO_PATH=1` to skip the question. Windows updates your user `PATH` the same way, and `-NoPath` skips it. Other overrides: `ADE_VERSION` to pin a release tag, `ADE_INSTALL_DIR` for the binary destination, `ADE_HOME` for the state root.

With no terminal attached — CI, a provisioning script — the installer skips every prompt and prints the follow-up commands instead. `ADE_INSTALL_NO_PROMPT=1` (`-NoPrompt` for PowerShell) opts out explicitly.

### Web client

Nothing to install. Sign in at [**app.ade-app.dev**](https://app.ade-app.dev) and every machine on your account is right there. Any machine running the ADE brain is reachable from it, from any browser.

### Mobile app

Available now on [**TestFlight**](https://testflight.apple.com/join/ZSdJGKPy). App Store coming soon; Android coming soon.

Sign in on the phone to see your machines and connect automatically. If you choose not to create a free account, you can **Continue without an account** and pair to any machine via direct QR/link, Nearby LAN/Tailscale scan, or SSH pairing. To maintain and relay information between machines, ADE will prefer LAN, then Tailscale, and use its own relay service as fallback to maintain mobile to machine connections. Having an account makes the discovery of machines seamless, and will also allow you to connect off wifi or without Tailscale. But if you have access to internet, or have Tailscale setup on mobile and another machine, then ADE will automatically use that to maintain the connection, it's always a bit faster. 



#### What `ade connect` does

It links a machine to your ADE account — nothing more. Once linked, that machine shows up in every ADe client once you are signed in. 

You rarely run it yourself. The install script runs it at the end, and the desktop app does the same job when you sign in. Reach for it when you declined the sign-in prompt, installed non-interactively, or want to check or repair an existing machine:

```bash
ade connect                  # sign in, install the service, publish this machine
ade connect --status --text  # report the three steps, change nothing
ade connect --headless       # copy-paste device flow, for SSH sessions
ade connect --no-login       # service only; stay local/LAN-only
```

`ade logout` undoes the account half; `ade runtime uninstall-service` removes the service.

## CLI

The same `ade` binary that runs the Brain is your CLI too, so once the Brain is installed you already have it. A taste of what it does:

```bash
ade desktop
ade brain status --text
ade code
ade lanes create --name fix-checkout-flow
ade prs checks 168 --text
ade actions list --text   # discover every service action
```

[Full CLI reference →](apps/ade-cli/README.md)

## Architecture

ADE is local first. The Brain is the always on process that owns your project catalog, the sync websocket, and the authority to actually run things. Every UI client attaches to it, including the desktop app, `ade code`, mobile, and the web client. Project data stays in `.ade/` inside each repo, and machine wide state lives in `~/.ade`.

```text
apps/ade-cli   ADE Brain, the `ade` CLI, and the `ade code` terminal client
apps/desktop   Electron desktop app
apps/ios       SwiftUI mobile app
apps/web       Website and download surface
docs/          Product and engineering docs
```

Deep reference: [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Develop

```bash
npm run setup   # first time only
npm run dev     # rebuild the CLI, refresh the dev runtime, launch desktop
```

`npm run dev` uses a temp endpoint and its own Electron profile, so it never touches your installed ADE app or the Brain it talks to.

Everything else lives in [docs/development/local-development.md](docs/development/local-development.md): the full dev command matrix, running a specific lane worktree, previewing the renderer in a browser without Electron, packaging local Alpha and Beta builds, and a table of what to rebuild after a given change.

Validate with `npm --prefix apps/desktop run typecheck` and `npm run test:desktop:sharded` for the full desktop suite. The desktop test suite is large, so run the smallest relevant subset first.

## Links

[Quickstart](https://www.ade-app.dev/docs/quickstart) · [Key concepts](https://www.ade-app.dev/docs/key-concepts) · [Worktrees](https://www.ade-app.dev/docs/lanes/overview) · [Computer use](https://www.ade-app.dev/docs/computer-use/overview) · [Changelog](https://www.ade-app.dev/docs/changelog) · [Contributing](CONTRIBUTING.md)

## Commit Chart

[![arul28/ADE GitStock K-Line Chart](https://gitstock.org/arul28/ADE/stock.svg)](https://gitstock.org/arul28/ADE)

## License

[AGPL-3.0](LICENSE) — © 2025 Arul Sharma. Free forever. Source on GitHub.
