/// `ade-desktop-driver`: one NDJSON request per line in, one reply per line out.
///
/// Transport note: the attention notch helper this package's layout mirrors uses
/// a unix socket, because it is a long-lived UI process the app may reconnect
/// to. This helper is the opposite — the runtime owns it, starts it, and dies
/// with it — so stdin/stdout is the right pipe: no socket path to leak, no
/// stale file after a crash, and the process group cleans itself up.
///
/// Three invariants hold for every line:
///
///   * A request carrying an `id` is *always* answered. An unknown op is
///     `ok:false`, never silence and never a crash: a newer Node talking to an
///     older helper is a normal state during an update, and an unsettled promise
///     on the other side is a hang nobody can diagnose.
///   * stdout carries protocol only. Every log line goes to stderr, because one
///     stray `print` would corrupt the stream.
///   * Work happens on the main thread. AppKit, the Accessibility API and the
///     `AXObserver` run-loop sources all require it, so stdin is read on a
///     background thread and every request is hopped to the main *run loop* —
///     `perform(onThread:)`, not `DispatchQueue.main.async`. The difference
///     matters: the main dispatch queue is serial, so a request that has to
///     wait (`input {command:"wait"}` can hold for two minutes) would pin every
///     other request behind it, health `ping` included, no matter how the
///     waiting is done. A run-loop perform can be drained from inside that
///     wait, which is what `RunLoopPump` does.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

let driverVersion = "1.0.0"

final class DriverRuntime: NSObject {
    private let output = OutputWriter()
    private let ownership = OwnershipRegistry()
    private let handles = HandleRegistry()
    private let leases = InputLeaseStore()

    lazy var displays: VirtualDisplayHost = {
        let host = VirtualDisplayHost(log: log)
        host.onTerminated = { [weak self] laneId in self?.displayTerminated(laneId: laneId) }
        return host
    }()
    lazy var windows: WindowControl = {
        let control = WindowControl(ownership: ownership, log: log, emit: emit)
        control.isGestureInFlight = { [weak self] in self?.gestures.isActive ?? false }
        return control
    }()
    lazy var accessibility = AccessibilityDriver(handles: handles, log: log)
    private lazy var capture = CaptureEngine(log: log, emit: emit)
    lazy var realInput = RealInput(leases: leases, log: log)

    /// "A real gesture is holding the mouse button right now." Consulted by the
    /// dispatcher below, set by the `drag` path in `InputCommands`, and read by
    /// the window watcher so its 1-second sweep does not repark a window out
    /// from under the pointer.
    let gestures = GestureGate()

    private var lastActivity: [String: Date] = [:]
    private var recordingCaptions: [String: String] = [:]

    /// The last permission pair a probe saw, so the periodic probe can emit a
    /// `permission-changed` only on a transition.
    private var lastPermissions: [String: JSONValue]?
    private var permissionTimer: Timer?
    /// How many `watch-permissions {watch:true}` askers are outstanding. The
    /// probe runs when watching OR a display exists, so a watched pane keeps
    /// probing with no display while an idle helper with neither stays idle.
    /// Sent only by the service, which watches while a viewer is reading.
    private var permissionWatching = false

    /// How often the permission probe runs while only a display exists. Both
    /// probes are cheap local calls, but they are not free, and nothing about a
    /// revoked grant needs sub-10-second latency: the action that follows it
    /// fails with a permission error of its own either way.
    private static let permissionProbeInterval: TimeInterval = 10
    /// A watched pane needs the transition quickly; 10 seconds of a stale
    /// "denied" screen after the user toggles the grant reads as broken.
    private static let watchedPermissionProbeInterval: TimeInterval = 3

    private var signalSources: [DispatchSourceSignal] = []
    private var isShuttingDown = false
    /// `isShuttingDown`, readable off the main thread by the forced-exit timer.
    private let shutdownStarted = SettledFlag()

    /// How long a SIGTERM or a closed stdin waits for the main thread to begin
    /// the orderly shutdown before the process exits without it.
    ///
    /// Both are handled on the main thread, because that is where the displays,
    /// the recorders and the parked windows live. A main thread stuck inside a
    /// framework call never gets to them, and the process then outlived the
    /// client that asked it to go: the client started a replacement while this
    /// one still held its lanes' virtual displays.
    private static let forcedExitGrace: TimeInterval = 5

    /// What shutdown gives every recording together to finalise. Inside the
    /// apps' quit grace (`WindowControl.exitQuitGrace`), so the force quit
    /// still lands before the client's SIGKILL; a normal finalise takes tens
    /// of milliseconds.
    private static let shutdownFinalizeBudget: TimeInterval = 1.0

    /// Every request currently being handled, and the right to answer it.
    ///
    /// The dispatcher is synchronous, so the ordinary paths answer by
    /// construction. This is for the paths that are not ordinary: a
    /// ScreenCaptureKit or AVFoundation completion handler that is never
    /// invoked leaves the main thread inside `handle` forever, and the caller
    /// with a promise that never settles — the one failure nobody can diagnose
    /// from Node's side. The watchdog answers on the handler's behalf, and the
    /// tracker makes sure a handler that finishes afterwards stays quiet rather
    /// than writing a second reply for the same id.
    private let pending = PendingRequestTracker(timeout: 15)
    private var watchdog: DispatchSourceTimer?

    /// How often the watchdog looks for an overdue request. A second of
    /// granularity on a 15-second deadline is noise, and the sweep is a lock
    /// and a dictionary walk over at most a handful of entries.
    private static let watchdogInterval: TimeInterval = 1

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    func run() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        // The default is about six seconds per call, and one stalled app could
        // then hold the main thread — and with it `ping` and every other lane —
        // for minutes. The walk sets a shorter timeout on each element it
        // reads; this bounds every other call. See `AXTimeouts.global`.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), AXTimeouts.global)
        startReading()
        installSignalHandlers()
        startWatchdog()
        log("ade-desktop-driver \(driverVersion) ready (pid \(getpid()))")
        application.run()
    }

    /// The same shutdown stdin-close runs, for the death the Node client
    /// actually deals: it kills the process group rather than closing the pipe
    /// and waiting. Without this, a recording in flight is a half-written MP4 —
    /// `AVAssetWriter` finalises the moov atom in `finishWriting`, and a file
    /// that never got it is not a shorter video, it is not a video.
    ///
    /// The default disposition is ignored first: a `DispatchSource` signal
    /// handler runs *alongside* the default one, so without the `SIG_IGN` the
    /// process would still die on the spot and the handler would never run.
    private func installSignalHandlers() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                self?.shutdown(reason: number == SIGTERM ? "SIGTERM" : "SIGINT")
            }
            source.resume()
            signalSources.append(source)
            // A second source for the same signal, off the main thread, for the
            // case the one above cannot run: a main thread that is stuck.
            let backstop = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .utility))
            backstop.setEventHandler { [weak self] in
                self?.armForcedExit(reason: number == SIGTERM ? "SIGTERM" : "SIGINT")
            }
            backstop.resume()
            signalSources.append(backstop)
        }
    }

    /// Exits the process if the main thread has not begun shutting down within
    /// `forcedExitGrace`. Safe from any thread.
    ///
    /// Losing the orderly shutdown loses an in-flight recording's last seconds;
    /// keeping a process nobody talks to loses the user's screen layout to a
    /// virtual display that no client knows about. The second is worse.
    private func armForcedExit(reason: String) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.forcedExitGrace) { [weak self] in
            guard let self, !self.shutdownStarted.isSet else { return }
            self.log("main thread did not start shutting down \(Int(Self.forcedExitGrace))s after \(reason); exiting without it")
            exit(0)
        }
    }

    /// Answers, on a queue of its own, anything the main thread has been stuck
    /// inside for longer than the tracker's timeout.
    ///
    /// Off the main thread on purpose: the case it exists for is precisely the
    /// one where the main thread is not coming back, so a main-run-loop timer
    /// would be parked behind the very handler it is supposed to rescue.
    /// `OutputWriter` is serialised, so writing from here is safe.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            for overdue in self.pending.takeOverdue() {
                self.log("watchdog answering \(overdue.op) \(overdue.id) after \(Int(overdue.elapsed))s with no reply")
                self.output.write(.reply(.failure(id: overdue.id, error: overdue.driverError)))
            }
        }
        timer.resume()
        watchdog = timer
    }

    private func startReading() {
        let thread = Thread { [weak self] in
            let handle = FileHandle.standardInput
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    self?.performOnMain(#selector(DriverRuntime.shutdownFromStdin), with: nil)
                    self?.armForcedExit(reason: "stdin closed")
                    return
                }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<newline)
                    buffer.removeSubrange(buffer.startIndex...newline)
                    guard let line = String(data: lineData, encoding: .utf8) else { continue }
                    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { continue }
                    self?.performOnMain(#selector(DriverRuntime.acceptBoxed(_:)), with: trimmed as NSString)
                }
            }
        }
        thread.name = "ade-desktop-driver.stdin"
        thread.start()
    }

    /// Hands one line to the main thread in a way a nested run-loop pump can
    /// drain. `.common` covers the modes the pump and AppKit's own loops run in.
    private func performOnMain(_ selector: Selector, with argument: NSObject?) {
        perform(
            selector,
            on: Thread.main,
            with: argument,
            waitUntilDone: false,
            modes: [RunLoop.Mode.common.rawValue, RunLoop.Mode.default.rawValue]
        )
    }

    @objc private func shutdownFromStdin() {
        shutdown(reason: "stdin closed")
    }

    private func shutdown(reason: String) {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        shutdownStarted.set()
        log("shutting down: \(reason)")
        watchdog?.cancel()
        watchdog = nil
        permissionTimer?.invalidate()
        permissionTimer = nil
        // The apps the lanes opened go with their displays, the same as on a
        // `stop`: quitting ADE is a deliberate stop of every lane. One grace
        // period for all lanes, then a force quit, so a save dialog cannot
        // keep a lane's copy alive on the user's screen after ADE is gone.
        //
        // The apps are asked to quit first and the recordings finalise inside
        // their grace (`CaptureEngine.dispose` is what writes each MP4's moov),
        // with a bounded budget: the client sends SIGKILL two seconds after
        // SIGTERM, and finalising first used to push the force quit past it.
        _ = windows.quitAllLaunchedApps(duringGrace: { [capture] in
            capture.dispose(finalizeBudget: Self.shutdownFinalizeBudget)
        })
        windows.dispose()
        displays.destroyAll()
        exit(0)
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    @objc private func acceptBoxed(_ line: NSString) {
        accept(line: line as String)
    }

    private func accept(line: String) {
        let input: DriverInput
        do {
            input = try DriverInputDecoder.decode(line: line)
        } catch {
            // A line that named an id is owed a reply even when the rest of it
            // was nonsense; only a line with nobody to answer becomes an event.
            if let id = DriverInputDecoder.requestId(inLine: line) {
                respond(.failure(id: id, code: DriverErrorCode.protocolError, message: "\(error)"))
            } else {
                output.write(.event(DriverEvent.protocolError("\(error)")))
            }
            return
        }
        guard case .request(let request) = input else { return }
        switch gestures.decide(request) {
        case .proceed:
            break
        case .deferred:
            // No reply yet, and that is the point: the caller waits out the
            // gesture instead of racing it. `drainDeferred` answers it.
            gestures.enqueue(request)
            return
        case .rejected(let error):
            respond(.failure(id: request.id, error: error))
            return
        }
        dispatch(request)
    }

    /// The watchdog deadline for one request.
    ///
    /// Everything the driver does is a handful of framework calls and answers
    /// in well under the tracker's default, with one exception: `input` carries
    /// its own duration. A `wait` polls for up to two minutes and a `drag` runs
    /// for as long as it was asked to, so their budget is the default *plus*
    /// what the caller asked for. Anything else is a hang.
    private static func watchdogBudget(for request: DriverRequest) -> TimeInterval? {
        guard request.knownOp == .input, let payload = request.object("payload") else { return nil }
        let waitMs = payload["timeoutMs"]?.intValue ?? 0
        let dragMs = payload["durationMs"]?.intValue ?? 0
        let extra = Double(max(0, waitMs) + max(0, dragMs)) / 1000
        return extra > 0 ? 15 + extra : nil
    }

    /// The single door every reply goes through.
    ///
    /// The tracker decides whether this reply is the one that gets written: for
    /// a request the watchdog already answered it is not, and writing it anyway
    /// would put two lines with one id on a wire whose client keys its promises
    /// by id.
    private func respond(_ reply: DriverReply) {
        guard pending.claim(id: reply.id) else { return }
        output.write(.reply(reply))
    }

    /// Handle one request and write its reply. Every request reaches this
    /// exactly once, whether it arrived on the wire or out of the gesture
    /// queue, and leaves it having produced exactly one reply — from here, or
    /// from the watchdog if this never returns.
    private func dispatch(_ request: DriverRequest) {
        pending.begin(id: request.id, op: request.op, budget: Self.watchdogBudget(for: request))
        defer { pending.finish(id: request.id) }
        // Shutdown pumps the run loop while apps quit and recordings close,
        // and a request run inside it could start something nothing stops.
        if let refusal = RequestAdmission.refusal(op: request.knownOp, isShuttingDown: isShuttingDown) {
            respond(.failure(id: request.id, error: refusal))
            return
        }
        do {
            let result = try handle(request)
            respond(.success(id: request.id, result: result))
        } catch let error as DriverError {
            respond(.failure(id: request.id, error: error))
        } catch let error as CaptureError {
            respond(.failure(id: request.id, error: Self.driverError(for: error)))
        } catch {
            respond(
                .failure(
                    id: request.id,
                    code: DriverErrorCode.internalError,
                    message: "\(error)"
                )
            )
        }
    }

    /// Replays what the gesture held up.
    ///
    /// Posted to the run loop rather than called inline so it runs *after* the
    /// drag's own reply has gone out, keeping replies in the order a client
    /// would expect.
    ///
    /// One item at a time, with an `isActive` re-check between each. Today a
    /// gesture begins and ends synchronously inside one request, so the gate
    /// cannot re-arm mid-drain and the check never fires; it is one atomic read
    /// per item, and it is what keeps the drain correct the day a gesture
    /// becomes asynchronous — a parked request can itself be a drag, and the
    /// rest of the queue would have to wait for that one too.
    func scheduleDeferredDrain() {
        performOnMain(#selector(DriverRuntime.drainDeferred), with: nil)
    }

    @objc private func drainDeferred() {
        while !gestures.isActive, let next = gestures.dequeue() {
            switch next {
            case .run(let request):
                dispatch(request)
            case .expired(let request, let error):
                // Answered, never executed: the caller's own timeout has almost
                // certainly fired, and replaying stale coordinates into a
                // desktop that moved on is the worse of the two outcomes.
                log("dropping deferred \(request.op) \(request.id): \(error.message)")
                respond(.failure(id: request.id, error: error))
            }
        }
    }

    private static func driverError(for error: CaptureError) -> DriverError {
        switch error {
        case .noSurface(let message):
            return DriverError(code: DriverErrorCode.displayUnavailable, message: message)
        case .failed(let message):
            return DriverError(code: DriverErrorCode.internalError, message: message)
        }
    }

    private func handle(_ request: DriverRequest) throws -> [String: JSONValue] {
        guard let op = request.knownOp else {
            throw DriverError(
                code: DriverErrorCode.unknownOp,
                message: "This ade-desktop-driver build does not implement \"\(request.op)\"."
            )
        }
        switch op {
        case .health: return health()
        case .createDisplay: return try createDisplay(request)
        case .destroyDisplay: return try destroyDisplay(request)
        case .reconcileDisplays: return reconcileDisplays(request)
        case .watchPermissions: return setPermissionWatch(request.bool("watch") ?? false)
        case .requestPermission: return try requestPermission(request)
        case .listWindows: return listWindows(request)
        case .parkWindow: return try parkWindow(request)
        case .unparkWindow: return try unparkWindow(request)
        case .launch: return try launch(request)
        case .present: return try present(request)
        case .observe: return try observe(request)
        case .input: return try input(request)
        case .setLease: return try setLease(request)
        case .clearLease: return clearLease(request)
        case .screenshot: return try screenshot(request)
        case .startStream: return try startStream(request)
        case .setStreamRate: return try setStreamRate(request)
        case .setStreamCursorVisible: return try setStreamCursorVisible(request)
        case .stopStream: return try stopStream(request)
        case .startRecording: return try startRecording(request)
        case .stopRecording: return try stopRecording(request)
        }
    }

    // -----------------------------------------------------------------------
    // Health and permissions
    // -----------------------------------------------------------------------

    /// The periodic probe behind `permission-changed`.
    ///
    /// Runs while a display exists OR a viewer is watching. With neither, there
    /// is nothing a revoked grant could break and nothing watching for a new
    /// one, so an idle helper stays idle. A watched pane probes every 3 seconds
    /// so the screen flips off "denied" promptly after the user toggles the
    /// grant; a display-only helper keeps the cheaper 10-second cadence.
    private func updatePermissionProbe() {
        let wanted = !displays.all().isEmpty || permissionWatching
        let interval = permissionWatching
            ? Self.watchedPermissionProbeInterval
            : Self.permissionProbeInterval
        if wanted {
            if permissionTimer == nil {
                startPermissionTimer(interval: interval)
            } else if (permissionTimer?.timeInterval ?? interval) != interval {
                // A `Timer` carries its interval for life, so a cadence change
                // is a new timer. `lastPermissions` is re-seeded from the
                // current snapshot, which keeps the swap itself transition-free.
                permissionTimer?.invalidate()
                permissionTimer = nil
                startPermissionTimer(interval: interval)
            }
        } else if permissionTimer != nil {
            permissionTimer?.invalidate()
            permissionTimer = nil
            lastPermissions = nil
        }
    }

    private func startPermissionTimer(interval: TimeInterval) {
        lastPermissions = Permissions.snapshot()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.probePermissionsForChange()
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionTimer = timer
    }

    /// Turns the viewer-driven half of the probe condition on or off.
    ///
    /// Internal rather than private so a test can assert the probe starts with
    /// no display, which is exactly the state the first-run screen is stuck in.
    @discardableResult
    func setPermissionWatch(_ watch: Bool) -> [String: JSONValue] {
        permissionWatching = watch
        updatePermissionProbe()
        return ["watch": .bool(watch)]
    }

    /// Test seam: whether the periodic probe currently has a timer.
    var isPermissionProbeActive: Bool { permissionTimer != nil }

    private func probePermissionsForChange() {
        let current = Permissions.snapshot()
        guard current != lastPermissions else { return }
        lastPermissions = current
        emit(DriverEvent(event: "permission-changed", fields: ["permissions": .object(current)]))
    }

    /// `request-permission`: ask macOS for a grant, but only when told to.
    ///
    /// The service passes `allowPrompt` true only for a local user's explicit
    /// click; an agent action or a remote client arrives false. The prompt is a
    /// system modal fired at whoever is at the Mac, so this never fires from a
    /// background read, and when it is refused the fresh snapshot is still the
    /// answer.
    private func requestPermission(_ request: DriverRequest) throws -> [String: JSONValue] {
        let which = try request.requireString("which")
        let allowPrompt = request.bool("allowPrompt") ?? false
        return Permissions.request(which: which, allowPrompt: allowPrompt)
    }

    private func health() -> [String: JSONValue] {
        [
            "version": .string(driverVersion),
            "pid": .int(Int(getpid())),
            "permissions": .object(Permissions.snapshot()),
            "displayMode": .string(displays.displayMode),
            "virtualDisplay": .object([
                "available": .bool(displays.isVirtualDisplayAvailable),
                "reason": displays.unavailableReason.map(JSONValue.string) ?? .null,
            ]),
            "axWindowBridge": .bool(AXWindowBridge.isAvailable),
            "idleSeconds": .double(PhysicalInput.secondsSinceLastEvent()),
            // The lanes that have a display in this process right now. The
            // service reconciles against it on every health read, so it never
            // reports a display this process no longer has — after a restart,
            // or after the window server ended one.
            "displays": .array(displays.all().map { .string($0.laneId) }),
        ]
    }

    // -----------------------------------------------------------------------
    // Displays
    // -----------------------------------------------------------------------

    private func createDisplay(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        // A create that runs inside a stop's run-loop pump would hand back a
        // display the stop has already moved past, and nothing would ever
        // destroy it.
        if let refusal = windows.stopGate.refusal(laneId: laneId, action: "create a display") { throw refusal }
        let name = request.string("name") ?? "\(VirtualDisplayIdentity.namePrefix)\(laneId)"
        let width = request.int("width") ?? 2560
        let height = request.int("height") ?? 1440
        let scale = request.int("scale") ?? 2
        let handle = displays.create(laneId: laneId, name: name, width: width, height: height, scale: scale)
        windows.setPlacement(laneId: laneId, placement: handle.placement, displayId: handle.displayId)
        touch(laneId)
        let json = handle.asJSON(
            windowCount: ownership.windows(forLane: laneId).count,
            lastActivityAt: lastActivity[laneId] ?? Date()
        )
        updatePermissionProbe()
        emit(DriverEvent(event: "display-created", fields: ["display": .object(json)]))
        return json
    }

    private func destroyDisplay(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        // Held for the whole stop: quitting the apps pumps the run loop for
        // seconds, and a launch, park or capture start run inside that pump
        // would outlive the lane.
        windows.stopGate.begin(laneId)
        defer { windows.stopGate.end(laneId) }
        capture.stopStream(laneId: laneId)
        _ = try? capture.stopRecording(laneId: laneId)
        // Before the windows are released and while the display still exists:
        // the apps the lane opened quit (force-quit after a grace period), and
        // what is left — the windows the user claimed — goes back to the
        // user's screen.
        let quit = windows.quitLaunchedApps(laneId: laneId)
        let released = windows.releaseLane(laneId)
        let destroyed = displays.destroy(laneId: laneId)
        lastActivity.removeValue(forKey: laneId)
        emit(
            DriverEvent(
                event: "display-destroyed",
                fields: [
                    "laneId": .string(laneId),
                    "reason": .string(request.string("reason") ?? "stopped"),
                ].merging(quit.jsonFields) { current, _ in current }
            )
        )
        updatePermissionProbe()
        return ["destroyed": .bool(destroyed), "releasedWindows": .int(released)]
            .merging(quit.jsonFields) { current, _ in current }
    }

    /// The window server ended a lane's display without being asked.
    ///
    /// Everything `display.destroy` would do, minus destroying the display,
    /// and the same `display-destroyed` event with a reason of its own, so the
    /// service drops the lane rather than keep reporting a screen that is gone.
    private func displayTerminated(laneId: String) {
        windows.stopGate.begin(laneId)
        defer { windows.stopGate.end(laneId) }
        capture.stopStream(laneId: laneId)
        _ = try? capture.stopRecording(laneId: laneId)
        let quit = windows.quitLaunchedApps(laneId: laneId)
        let released = windows.releaseLane(laneId)
        lastActivity.removeValue(forKey: laneId)
        log("lane \(laneId) lost its virtual display; released \(released) window(s)")
        emit(
            DriverEvent(
                event: "display-destroyed",
                fields: ["laneId": .string(laneId), "reason": .string("terminated")]
                    .merging(quit.jsonFields) { current, _ in current }
            )
        )
        updatePermissionProbe()
    }

    private func reconcileDisplays(_ request: DriverRequest) -> [String: JSONValue] {
        let live = Set(request.stringArray("liveLaneIds") ?? [])
        var destroyed: [String] = []
        for laneId in displays.reconcile(liveLaneIds: live) {
            // The same stop as `display.destroy`, recording included: a
            // recording left running captured a display that no longer exists.
            windows.stopGate.begin(laneId)
            capture.stopStream(laneId: laneId)
            _ = try? capture.stopRecording(laneId: laneId)
            recordingCaptions.removeValue(forKey: laneId)
            _ = windows.quitLaunchedApps(laneId: laneId)
            _ = windows.releaseLane(laneId)
            windows.stopGate.end(laneId)
            destroyed.append(laneId)
        }
        updatePermissionProbe()
        return ["destroyed": .array(destroyed.map(JSONValue.string))]
    }

    // -----------------------------------------------------------------------
    // Windows
    // -----------------------------------------------------------------------

    private func listWindows(_ request: DriverRequest) -> [String: JSONValue] {
        let laneId = request.string("laneId")
        let pid = request.int("pid").map { pid_t($0) }
        let list = windows.listWindows(laneId: laneId, pid: pid)
        return ["windows": .array(list.map { .object($0.asJSON()) })]
    }

    private func parkWindow(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let windowId = CGWindowID(try request.requireInt("windowId"))
        let parked = try windows.park(
            laneId: laneId,
            windowId: windowId,
            origin: request.string("origin") ?? "claimed"
        )
        touch(laneId)
        return parked.asJSON()
    }

    /// `window.unpark`: the Release button and `mac-desktop release`. A
    /// window of an app the lane launched hands the whole instance to the
    /// user; `releasedWindowIds` names every window that left the lane, and
    /// `handedOverPid` the instance the lane no longer watches or quits.
    private func unparkWindow(_ request: DriverRequest) throws -> [String: JSONValue] {
        let windowId = CGWindowID(try request.requireInt("windowId"))
        // A client that names its lane can only release that lane's windows;
        // one lane's Release must never hand over another lane's app.
        if let refusal = ownership.releaseRefusal(windowId: Int(windowId), laneId: request.string("laneId")) {
            throw refusal.driverError
        }
        guard let result = windows.release(windowId: windowId) else {
            return ["window": .null, "releasedWindowIds": .array([])]
        }
        return [
            "window": result.window.map { .object($0.asJSON()) } ?? .null,
            "releasedWindowIds": .array(result.releasedWindowIds.map { .int(Int($0)) }),
            "handedOverPid": result.handedOverPid.map { .int(Int($0)) } ?? .null,
        ]
    }

    private func launch(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let target = try request.requireString("target")
        let result = try windows.launch(
            laneId: laneId,
            target: target,
            arguments: request.stringArray("args") ?? []
        )
        touch(laneId)
        return [
            "laneId": .string(laneId),
            "pid": result.pid.map { JSONValue.int(Int($0)) } ?? .null,
            "appName": result.appName.map(JSONValue.string) ?? .null,
            "bundleId": result.bundleId.map(JSONValue.string) ?? .null,
            "windows": .array(result.windows.map { .object($0.asJSON()) }),
            "watching": .bool(result.watching),
        ]
    }

    private func present(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let destination = request.string("destination") ?? "main"
        let moved = windows.present(laneId: laneId, destination: destination)
        touch(laneId)
        return ["moved": .int(moved)]
    }

    // -----------------------------------------------------------------------
    // Observation
    // -----------------------------------------------------------------------

    private func observe(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display. Start one before observing it."
            )
        }
        let limit = max(1, min(2_000, request.int("limit") ?? 200))
        let requestedWindowId = request.int("windowId").map { CGWindowID($0) }
        var parked = windows.listWindows(laneId: laneId)
        if let requestedWindowId {
            parked = parked.filter { $0.id == requestedWindowId }
            guard !parked.isEmpty else {
                throw DriverError(
                    code: DriverErrorCode.windowNotFound,
                    message: "Window \(requestedWindowId) is not parked on lane \(laneId)."
                )
            }
        }

        let capturedAt = Date()
        let screenshotPath = request.string("screenshotPath")
            ?? Self.scratchPath(laneId: laneId, suffix: "observe", extension: "png")
        var size = (width: 0, height: 0)
        var captureFailure: String?
        do {
            size = try capture.screenshot(
                laneId: laneId,
                displayId: handle.displayId,
                windowId: requestedWindowId ?? (handle.displayId == 0 ? parked.first?.id : nil),
                path: screenshotPath
            )
        } catch {
            // An observation without a frame is still worth returning: the
            // element tree is the half an agent acts on, and a missing Screen
            // Recording grant must not make the whole feature unusable.
            captureFailure = "\(error)"
            log("observe on lane \(laneId) captured no frame: \(error)")
        }

        let observation = accessibility.observe(
            windows: parked,
            limit: limit,
            windowControl: windows,
            timeBudget: AXTimeouts.observeWalk
        )
        if let reason = observation.truncatedReason, reason == .timeout || reason == .stalled {
            let stalled = observation.stalledApps.isEmpty
                ? ""
                : "; not answering: \(observation.stalledApps.joined(separator: ", "))"
            log("observe on lane \(laneId) stopped early (\(reason.rawValue)) after \(observation.walkMs)ms with \(observation.elementCount) element(s)\(stalled)")
        }

        var mapPath: JSONValue = .null
        if request.bool("map") == true, captureFailure == nil {
            let path = request.string("mapPath")
                ?? Self.scratchPath(laneId: laneId, suffix: "map", extension: "png")
            do {
                try capture.writeElementMap(
                    laneId: laneId,
                    screenshotPath: screenshotPath,
                    mapPath: path,
                    display: handle.placement,
                    elements: observation.elements
                )
                mapPath = .string(path)
            } catch {
                log("element map for lane \(laneId) failed: \(error)")
            }
        }

        touch(laneId)
        var result: [String: JSONValue] = [
            "id": .string(observation.id),
            "laneId": .string(laneId),
            "capturedAt": .string(ISO8601.string(capturedAt)),
            "screenshotPath": .string(screenshotPath),
            "mapPath": mapPath,
            "display": .object([
                "width": .int(size.width > 0 ? size.width : Int(handle.placement.width)),
                "height": .int(size.height > 0 ? size.height : Int(handle.placement.height)),
                "scale": .double(Double(handle.placement.scale)),
            ]),
            "windows": .array(parked.map { .object($0.asJSON()) }),
            "elements": .array(observation.elements.map { .object($0.asJSON()) }),
            "elementCount": .int(observation.elementCount),
            "truncated": .bool(observation.truncated),
            "truncatedReason": observation.truncatedReason.map { JSONValue.string($0.rawValue) } ?? .null,
            "stalledApps": .array(observation.stalledApps.map(JSONValue.string)),
            "walkMs": .int(observation.walkMs),
            "caption": request.string("caption").map(JSONValue.string) ?? .null,
        ]
        if let captureFailure {
            result["captureError"] = .string(captureFailure)
        }
        return result
    }

    // -----------------------------------------------------------------------
    // Lease
    // -----------------------------------------------------------------------

    private func setLease(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let holderId = try request.requireString("holderId")
        guard let expiresAtMs = InputLeaseStore.expiryMilliseconds(request.fields["expiresAt"]) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "lease.set needs an \"expiresAt\" as epoch milliseconds or an ISO-8601 string."
            )
        }
        leases.set(InputLease(laneId: laneId, holderId: holderId, expiresAtMs: expiresAtMs))
        return [
            "laneId": .string(laneId),
            "holderId": .string(holderId),
            "expiresAt": .double(expiresAtMs),
        ]
    }

    private func clearLease(_ request: DriverRequest) -> [String: JSONValue] {
        guard let laneId = request.string("laneId") else {
            return ["cleared": .bool(false)]
        }
        return ["cleared": .bool(leases.clear(laneId: laneId) != nil)]
    }

    // -----------------------------------------------------------------------
    // Capture
    // -----------------------------------------------------------------------

    private func screenshot(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display."
            )
        }
        let path = request.string("path")
            ?? Self.scratchPath(laneId: laneId, suffix: "shot", extension: "png")
        let windowId = request.int("windowId").map { CGWindowID($0) }
            ?? (handle.displayId == 0 ? windows.listWindows(laneId: laneId).first?.id : nil)
        let size = try capture.screenshot(
            laneId: laneId,
            displayId: handle.displayId,
            windowId: windowId,
            path: path
        )
        touch(laneId)
        return [
            "laneId": .string(laneId),
            "filePath": .string(path),
            "width": .int(size.width),
            "height": .int(size.height),
            "capturedAt": .string(ISO8601.string(Date())),
        ]
    }

    private func startStream(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        if let refusal = windows.stopGate.refusal(laneId: laneId, action: "start a live stream") { throw refusal }
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(code: DriverErrorCode.noDisplay, message: "Lane \(laneId) has no display.")
        }
        let fps = max(1, min(60, request.int("fps") ?? 30))
        let started = try capture.startStream(
            laneId: laneId,
            displayId: handle.displayId,
            fps: fps,
            // Absent means "whatever this lane was last told", which is what
            // keeps a reconnect during a takeover from losing the pointer.
            showsCursor: request.bool("showsCursor")
        )
        touch(laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "port": .int(Int(started.port)),
            "url": .null,
            "token": .null,
            "codec": started.codec.map(JSONValue.string) ?? .null,
            "width": .int(started.width),
            "height": .int(started.height),
            "fps": .int(fps),
        ]
        emit(DriverEvent(event: "stream-started", fields: result))
        return result
    }

    private func setStreamRate(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let fps = max(1, min(60, try request.requireInt("fps")))
        try capture.setStreamRate(laneId: laneId, fps: fps)
        return ["fps": .int(fps)]
    }

    /// Whether the lane's live stream draws the system pointer.
    ///
    /// The whole reason this op exists: while an agent drives, the pointer in
    /// the picture is wherever the machine's one real mouse happens to sit,
    /// which has nothing to do with the lane — so it is hidden and the viewer
    /// draws its own glyph from the action it just took. While a *person*
    /// drives, that same real pointer IS the thing they are moving, and hiding
    /// it makes the takeover feel like typing with the lights off.
    private func setStreamCursorVisible(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let visible = request.bool("visible") ?? false
        try capture.setStreamCursorVisible(laneId: laneId, visible: visible)
        return ["laneId": .string(laneId), "visible": .bool(visible)]
    }

    private func stopStream(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let stopped = capture.stopStream(laneId: laneId)
        emit(DriverEvent(event: "stream-stopped", fields: ["laneId": .string(laneId)]))
        return ["stopped": .bool(stopped)]
    }

    private func startRecording(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        if let refusal = windows.stopGate.refusal(laneId: laneId, action: "start a recording") { throw refusal }
        // `windowId` records one window and needs no lane display: App Control
        // records the app it drives. `laneId` is then only the recording's key.
        let windowId = request.int("windowId").flatMap { $0 > 0 ? CGWindowID($0) : nil }
        let displayId: CGDirectDisplayID
        if windowId != nil {
            displayId = 0
        } else {
            guard let handle = displays.handle(forLane: laneId) else {
                throw DriverError(code: DriverErrorCode.noDisplay, message: "Lane \(laneId) has no display.")
            }
            displayId = handle.displayId
        }
        let fps = max(1, min(60, request.int("fps") ?? 30))
        let filePath = request.string("filePath")
            ?? Self.scratchPath(laneId: laneId, suffix: "recording", extension: "mp4")
        // Idle cutting defaults on: a recording of an agent thinking is
        // mostly a still display. `keepIdle: true` keeps wall-clock time.
        let startedAt = try capture.startRecording(
            laneId: laneId,
            displayId: displayId,
            windowId: windowId,
            fps: fps,
            filePath: filePath,
            keepIdle: request.bool("keepIdle") ?? false
        )
        if let caption = request.string("caption") {
            recordingCaptions[laneId] = caption
        }
        touch(laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "running": .bool(true),
            "startedAt": .string(ISO8601.string(startedAt)),
            "filePath": .string(filePath),
            "caption": recordingCaptions[laneId].map(JSONValue.string) ?? .null,
        ]
        emit(DriverEvent(event: "recording-changed", fields: result))
        return result
    }

    private func stopRecording(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let finished = try capture.stopRecording(laneId: laneId)
        let caption = recordingCaptions.removeValue(forKey: laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "running": .bool(false),
            "filePath": .string(finished.filePath),
            "durationMs": .int(finished.durationMs),
            "wallDurationMs": .int(finished.wallDurationMs),
            "idleCutMs": .int(finished.idleCutMs),
            "caption": caption.map(JSONValue.string) ?? .null,
        ]
        emit(DriverEvent(event: "recording-changed", fields: result))
        return result
    }

    // -----------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------

    func touch(_ laneId: String) {
        lastActivity[laneId] = Date()
    }

    private static func scratchPath(laneId: String, suffix: String, extension pathExtension: String) -> String {
        let safeLane = laneId.replacingOccurrences(of: "/", with: "-")
        let directory = NSTemporaryDirectory() + "ade-desktop-driver"
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        return "\(directory)/\(safeLane)-\(suffix)-\(stamp).\(pathExtension)"
    }

    func emit(_ event: DriverEvent) {
        output.write(.event(event))
    }

    func log(_ message: String) {
        FileHandle.standardError.write(Data("[ade-desktop-driver] \(message)\n".utf8))
    }
}

/// stdout, one JSON line at a time.
///
/// Serialised because events are emitted from timers and stream callbacks while
/// a reply may be on its way out; two interleaved writes would produce one
/// unparseable line and take the whole session down with it.
final class OutputWriter {
    private let lock = NSLock()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    func write(_ output: DriverOutput) {
        guard let data = try? encoder.encode(output) else { return }
        lock.lock()
        defer { lock.unlock() }
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }
}

// Held in a top-level binding, not `DriverRuntime().run()`: a temporary would
// let ARC consider the runtime dead at the end of that statement, and every
// `[weak self]` capture inside the timers and stream callbacks would read nil.
let runtime = DriverRuntime()
runtime.run()
