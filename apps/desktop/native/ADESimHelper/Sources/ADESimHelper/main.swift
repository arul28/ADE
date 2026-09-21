import ADESimHelperCore
import Foundation

/// ADE's simulator helper.
///
/// Drives one or more booted iOS simulators — screen capture, touch, keyboard,
/// hardware buttons, orientation, accessibility — with no dependency beyond
/// Xcode, and speaks NDJSON to the ADE main process exactly as
/// `native/ADECaptureHelper` does:
///
///   stdin   {"type":"capture-start","id":"1","udid":"…","fps":60,"scale":1}
///   stdout  {"type":"ready","protocol":1,"pid":…}
///           {"type":"capture-started","id":"1","url":"http://127.0.0.1:…", …}
///           {"type":"ok","id":"2"} | {"type":"error","id":"2","code":…}
///
/// Three choices worth not undoing:
///
/// 1. **Frames leave over loopback HTTP, not stdout.** One socket per device
///    gives each stream independent backpressure, keeps binary out of a
///    line-oriented channel, and lets ADE's existing renderer-side decoder
///    attach with `fetch` and no new transport. See `FrameStreamServer`.
/// 2. **stdout is stolen from the vendored code at startup.** The vendored
///    capture and HID sources `print` progress to stdout; a single such line
///    would corrupt the NDJSON ADE is parsing. fd 1 is pointed at stderr and
///    the real stdout kept as a private duplicate. This is what lets the
///    vendored files stay byte-for-byte upstream.
/// 3. **No macOS privacy grant is needed and none is requested.** The pixels
///    come from the simulator's own IOSurface framebuffer through
///    CoreSimulator, not from the window server, so Screen Recording does not
///    apply; input goes to the simulator's HID port, not through CGEvent, so
///    Accessibility does not apply either. Nothing here may grow a call that
///    changes that without the entitlement discussion that comes with it.

// MARK: - stdout capture

/// Point fd 1 at stderr and keep the real stdout for NDJSON only.
///
/// Must run before anything touches the vendored code.
private func hijackStandardOutput() -> FileHandle {
    let realStdout = dup(STDOUT_FILENO)
    if realStdout >= 0 {
        dup2(STDERR_FILENO, STDOUT_FILENO)
        return FileHandle(fileDescriptor: realStdout, closeOnDealloc: false)
    }
    // dup failing means the process has no file descriptors to spare, which is
    // unrecoverable; writing NDJSON into the shared fd is still better than
    // exiting silently.
    return FileHandle.standardOutput
}

/// Serialised writes to the control channel.
///
/// Devices are driven concurrently, so two events can be produced at the same
/// moment; interleaved bytes would corrupt the NDJSON stream ADE is parsing.
final class EventWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.ade.sim-helper.stdout")
    private let handle: FileHandle

    init(handle: FileHandle) {
        self.handle = handle
    }

    func emit(_ event: SimHelperEvent) {
        guard let line = event.encoded() else { return }
        queue.async { [handle] in
            handle.write(Data(line.utf8))
        }
    }
}

// MARK: - Main

let controlChannel = hijackStandardOutput()
let writer = EventWriter(handle: controlChannel)
let runtime = SimHelperRuntime(emit: { [writer] event in writer.emit(event) })

/// Read NDJSON from stdin and drive the runtime until stdin closes or ADE quits.
///
/// Reads are blocking, on a dedicated thread, because the alternative —
/// `readabilityHandler` on the main queue — puts stdin parsing on the same queue
/// the capture callbacks and the stream server want, and a slow command then
/// stalls both devices' video.
let done = DispatchSemaphore(value: 0)

Thread.detachNewThread {
    var pending = Data()
    let input = FileHandle.standardInput

    /// A line this long is not something ADE sends; refusing it stops a
    /// desynchronised writer from growing the buffer without bound.
    let maxLineBytes = 1024 * 1024

    while true {
        let chunk = input.availableData
        if chunk.isEmpty { break }
        pending.append(chunk)

        while let newline = pending.firstIndex(of: 0x0A) {
            let lineData = pending[pending.startIndex..<newline]
            pending = pending[pending.index(after: newline)...]
            guard let line = String(data: lineData, encoding: .utf8) else { continue }

            // Each line is handled to completion before the next is read. The
            // commands are individually fast and ADE correlates by id, so
            // ordering per device is worth more than overlapping two taps.
            let keepGoing = DispatchSemaphore(value: 0)
            var shouldContinue = true
            Task {
                shouldContinue = await runtime.handle(line: line)
                keepGoing.signal()
            }
            keepGoing.wait()
            if !shouldContinue {
                done.signal()
                return
            }
        }

        if pending.count > maxLineBytes {
            pending.removeAll(keepingCapacity: false)
            writer.emit(.error(
                id: "",
                code: "line-too-long",
                message: "A command line exceeded \(maxLineBytes) bytes and was discarded."
            ))
        }
    }

    // stdin closed: ADE exited or the pipe broke. Tear the devices down rather
    // than leaving capture sessions attached to CoreSimulator.
    Task {
        await runtime.shutdown()
        done.signal()
    }
}

writer.emit(.ready(pid: ProcessInfo.processInfo.processIdentifier))
done.wait()
// Let the final NDJSON line reach ADE before the process goes away.
usleep(50_000)
