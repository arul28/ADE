// ADE Music host for macOS.
//
// A hidden WKWebView that runs MusicKit JS v3 on ADE's player page and is
// driven by ADE's main process over stdio. It speaks exactly the protocol of
// the Windows host (`native/ADEMusicHostWin/src/AdeMusicHost.cs`) and runs the
// same `page/` (index.html, player.js, ade-icon.png):
//   stdin  = one JSON command per line. Forwarded to the page verbatim, except
//            the host's own commands: {"cmd":"quit"},
//            {"cmd":"showAuth"} (bring the sign-in window to the front) and
//            {"cmd":"closeAuth"} (close it, which cancels the sign-in).
//   stdout = one JSON object per line: page events and command replies, plus the
//            host's own {"event":"hostReady"|"hostClosing"|"hostError"|"authWindow"}.
//   stderr = a human log. It never contains tokens: command lines are not logged,
//            and the page never logs them either.
//
// WebKit plays Apple Music's FairPlay streams, so signed-in accounts get full
// tracks. The page is loaded as https://music.ade.local/index.html with
// `loadSimulatedRequest` (a secure context, which EME needs); WKWebView cannot
// serve https from a folder the way WebView2's virtual host mapping does, so
// `player.js` is injected as a user script together with a small shim that
// gives it the `window.chrome.webview` bridge it was written against.
//
// Usage: ade-music-host --udf <dir> --page <dir> [--host music.ade.local]
//                       [--parent-pid <pid>] [--show] [--gpu] [--muted]
// `--gpu` is accepted for parity and ignored: WebKit manages its own GPU process.

import AppKit
import CryptoKit
import WebKit

let clock = Date()
let outLock = NSLock()

func log(_ message: String) {
    let ms = Int(Date().timeIntervalSince(clock) * 1000)
    let line = "[\(String(ms).leftPad(7))ms] \(message)\n"
    outLock.lock()
    FileHandle.standardError.write(line.data(using: .utf8)!)
    outLock.unlock()
}

func emit(_ json: String) {
    outLock.lock()
    FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
    outLock.unlock()
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
          let json = String(data: data, encoding: .utf8) else { return }
    emit(json)
}

extension String {
    func leftPad(_ width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}

struct Options {
    var udf: String?
    var page: String
    var host = "music.ade.local"
    var parentPid: pid_t = 0
    var show = false
    var muted = false

    init(_ argv: [String]) {
        page = URL(fileURLWithPath: argv[0]).resolvingSymlinksInPath().deletingLastPathComponent().appendingPathComponent("page").path
        var i = 1
        while i < argv.count {
            let a = argv[i]
            let next: String? = i + 1 < argv.count ? argv[i + 1] : nil
            switch a {
            case "--udf": if let n = next { udf = n; i += 1 }
            case "--page": if let n = next { page = n; i += 1 }
            case "--host": if let n = next { host = n; i += 1 }
            case "--parent-pid": if let n = next { parentPid = pid_t(n) ?? 0; i += 1 }
            case "--show": show = true
            case "--muted": muted = true
            default: break
            }
            i += 1
        }
    }
}

/// Gives player.js the WebView2 bridge it talks to: `chrome.webview.postMessage`
/// out, `chrome.webview` "message" events in. Only on ADE's own page.
func bridgeScript(origin: String) -> String {
    """
    (function () {
      if (location.origin !== \(jsString(origin))) return;
      var listeners = [];
      var out = window.webkit.messageHandlers.ade;
      window.chrome = window.chrome || {};
      window.chrome.webview = {
        postMessage: function (s) { out.postMessage(String(s)); },
        addEventListener: function (type, fn) { if (type === "message") listeners.push(fn); }
      };
      window.__adeDeliver = function (data) {
        for (var i = 0; i < listeners.length; i++) listeners[i]({ data: data });
      };
    })();
    """
}

/// Test instances play silently; playback still runs.
let muteScript = """
document.addEventListener("play", function (e) { if (e.target && "muted" in e.target) e.target.muted = true; }, true);
"""

func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
    let array = String(data: data, encoding: .utf8)!
    return String(array.dropFirst().dropLast())
}

/// A stable WebKit profile per ADE user-data directory, so dev and installed
/// builds (and test instances) never share Apple's cookies.
@available(macOS 14.0, *)
func dataStore(for udf: String) -> WKWebsiteDataStore {
    var bytes = Array(SHA256.hash(data: Data(("ade-music:" + udf).utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let uuid = NSUUID(uuidBytes: bytes) as UUID
    return WKWebsiteDataStore(forIdentifier: uuid)
}

final class Host: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let options: Options
    var playerWindow: NSWindow!
    var player: WKWebView!
    var authWindows: [NSWindow: (webView: WKWebView, n: Int)] = [:]
    var popupCount = 0
    var parentSource: DispatchSourceProcess?
    var closing = false

    init(options: Options) {
        self.options = options
    }

    var origin: String { "https://" + options.host }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        installMenu()
        let indexPath = (options.page as NSString).appendingPathComponent("index.html")
        let playerPath = (options.page as NSString).appendingPathComponent("player.js")
        guard var html = try? String(contentsOfFile: indexPath, encoding: .utf8),
              let playerJs = try? String(contentsOfFile: playerPath, encoding: .utf8) else {
            emit(["event": "hostError", "code": "page_missing", "error": "The player page is missing at \(options.page)."])
            exit(4)
        }
        // player.js arrives as a user script (before MusicKit's own script);
        // the page's tag would ask the network for music.ade.local.
        html = html.replacingOccurrences(of: "<script src=\"player.js\"></script>", with: "")
        // The page's icon link stays a short URL. MusicKit copies that link's
        // href into the authorize URL (base64, as a GET query), so inlining
        // the PNG as a data URL made a 41 KB URL and Apple's sign-in page
        // stayed blank. WKWebView cannot serve https://music.ade.local, so
        // Apple's Allow screen shows no ADE icon on macOS.

        let config = WKWebViewConfiguration()
        // Autoplay without a gesture: every play comes from ADE's own UI, never this page.
        config.mediaTypesRequiringUserActionForPlayback = []
        // MusicKit's authorize() opens Apple's sign-in with window.open from a
        // command, not a click.
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        if #available(macOS 14.0, *) {
            config.websiteDataStore = dataStore(for: options.udf!)
        }
        let content = WKUserContentController()
        content.add(self, name: "ade")
        content.addUserScript(WKUserScript(source: bridgeScript(origin: origin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addUserScript(WKUserScript(
            source: "if (location.origin === \(jsString(origin))) {\n\(playerJs)\n}",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        if options.muted {
            content.addUserScript(WKUserScript(source: muteScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        config.userContentController = content

        let frame = NSRect(x: 80, y: 80, width: 960, height: 640)
        player = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        // Apple's sign-in page has a dark-mode contrast bug; the player page has
        // no UI, so light everywhere is free.
        player.appearance = NSAppearance(named: .aqua)
        player.navigationDelegate = self
        player.uiDelegate = self
        if #available(macOS 13.3, *) { player.isInspectable = options.show }

        playerWindow = NSWindow(
            contentRect: frame,
            styleMask: options.show ? [.titled, .closable, .resizable, .miniaturizable] : [.borderless],
            backing: .buffered,
            defer: false)
        playerWindow.title = "ADE Music"
        playerWindow.isReleasedWhenClosed = false
        playerWindow.contentView = player
        if options.show {
            playerWindow.makeKeyAndOrderFront(nil)
        }

        if options.parentPid > 0 { watchParent(options.parentPid) }

        let request = URLRequest(url: URL(string: origin + "/index.html")!)
        player.loadSimulatedRequest(request, responseHTML: html)
        emit([
            "event": "hostReady",
            "hostPid": Int(getpid()),
            "browserPid": webContentPid() as Any? ?? NSNull(),
            "runtime": "WebKit " + (Bundle(for: WKWebView.self).infoDictionary?["CFBundleVersion"] as? String ?? "?"),
            "origin": origin,
        ])
        log("start pid=\(getpid()) page=\(options.page)")
        startStdin()
    }

    /// Edit shortcuts (paste a password into Apple's sign-in) go through the
    /// main menu; an app without one has no Cmd-V.
    func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Close Sign-in", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    // MARK: stdio

    func startStdin() {
        let thread = Thread { [weak self] in
            while let raw = readLine(strippingNewline: true) {
                let line = raw.trimmingCharacters(in: .whitespaces)
                if line.isEmpty { continue }
                if line == "{\"cmd\":\"quit\"}" { break }
                DispatchQueue.main.async { self?.handle(line) }
            }
            // EOF or quit: ADE is done with us (or gone).
            DispatchQueue.main.async { self?.shutdown() }
        }
        thread.name = "stdin"
        thread.start()
    }

    func handle(_ line: String) {
        if line == "{\"cmd\":\"showAuth\"}" {
            for window in authWindows.keys { present(window) }
            return
        }
        if line == "{\"cmd\":\"closeAuth\"}" {
            for window in Array(authWindows.keys) { window.performClose(nil) }
            return
        }
        player.callAsyncJavaScript(
            "if (window.__adeDeliver) window.__adeDeliver(line);",
            arguments: ["line": line],
            in: nil,
            in: .page
        ) { result in
            if case .failure(let error) = result { log("post failed \(error.localizedDescription)") }
        }
    }

    func shutdown(code: Int32 = 0) {
        if closing { return }
        closing = true
        for window in Array(authWindows.keys) { window.close() }
        emit(["event": "hostClosing"])
        log("exit")
        exit(code)
    }

    /// A crashed ADE closes our stdin, which ends the reader. This covers a
    /// pipe that leaked to another process and stays open.
    func watchParent(_ pid: pid_t) {
        if kill(pid, 0) != 0 && errno == ESRCH {
            log("parent already gone")
            DispatchQueue.main.async { self.shutdown() }
            return
        }
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            log("parent exited")
            self?.shutdown()
        }
        source.resume()
        parentSource = source
    }

    // MARK: page → ADE

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only ADE's player page may talk to ADE.
        guard message.webView === player,
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host == options.host,
              let body = message.body as? String,
              body.hasPrefix("{") else { return }
        emit(body)
    }

    // MARK: navigation

    /// The player's webviews only go where MusicKit and Apple's sign-in need to:
    /// the page itself and Apple. Only top-level navigations are checked:
    /// Apple's sign-in may frame others.
    func isAllowedNavigation(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.absoluteString == "about:blank" { return true }
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        if host == options.host { return true }
        return host == "apple.com" || host.hasSuffix(".apple.com") || host == "icloud.com" || host.hasSuffix(".icloud.com")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        if isAllowedNavigation(action.request.url) {
            decisionHandler(.allow)
        } else {
            log("\(webView === player ? "player" : "popup") navigation blocked")
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === player { log("navigation ok=true webContentPid=\(webContentPid().map(String.init) ?? "?")") }
    }

    /// The page's WebContent process, for logs and diagnostics. WebKit has no
    /// public accessor; the private one is checked before it is read, so a
    /// WebKit without it answers nil instead of raising.
    func webContentPid() -> Int? {
        guard let player, player.responds(to: NSSelectorFromString("_webProcessIdentifier")) else { return nil }
        let pid = (player.value(forKey: "_webProcessIdentifier") as? NSNumber)?.intValue ?? 0
        return pid > 0 ? pid : nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === player {
            // The page and MusicKit are gone. Exit so ADE starts a fresh host on
            // the next play instead of waiting on a dead page.
            log("process failed")
            emit(["event": "hostError", "code": "process_failed", "error": "WebContentProcessTerminated"])
            shutdown(code: 5)
        } else if let window = authWindows.first(where: { $0.value.webView === webView })?.key {
            window.close()
        }
    }

    // MARK: Apple's sign-in window

    /// MusicKit's authorize() opens Apple's sign-in with window.open and waits
    /// for it to post back to window.opener, so the popup must be the webview
    /// WebKit creates from this configuration.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, !isAllowedNavigation(action.request.url) {
            log("popup blocked")
            return nil
        }
        // Nothing of ADE's runs inside Apple's page.
        configuration.userContentController = WKUserContentController()
        popupCount += 1
        let n = popupCount
        let width = max(windowFeatures.width?.doubleValue ?? 520, 440)
        let height = max(windowFeatures.height?.doubleValue ?? 720, 620)
        let popup = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: configuration)
        popup.appearance = NSAppearance(named: .aqua)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Connect Apple Music - ADE"
        window.isReleasedWhenClosed = false
        window.contentView = popup
        window.delegate = self
        window.center()
        authWindows[window] = (popup, n)
        present(window)
        emit(["event": "authWindow", "state": "open", "n": n])
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        if let window = authWindows.first(where: { $0.value.webView === webView })?.key {
            window.close()
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let entry = authWindows.removeValue(forKey: window) else { return }
        entry.webView.uiDelegate = nil
        entry.webView.navigationDelegate = nil
        window.delegate = nil
        if authWindows.isEmpty { NSApp.hide(nil) }
        emit(["event": "authWindow", "state": "closed", "n": entry.n])
    }

    /// Show the sign-in window in front of ADE. A background helper may not be
    /// allowed to take focus, so the window also floats until it closes; one
    /// click on it makes it key.
    func present(_ window: NSWindow) {
        window.level = .floating
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        log("present active=\(NSApp.isActive)")
    }
}

let options = Options(CommandLine.arguments)
guard let udf = options.udf, !udf.isEmpty else {
    emit(["event": "hostError", "code": "usage", "error": "--udf is required"])
    exit(2)
}
try? FileManager.default.createDirectory(atPath: udf, withIntermediateDirectories: true)
signal(SIGPIPE, SIG_IGN)

let app = NSApplication.shared
let host = Host(options: options)
app.delegate = host
app.run()
