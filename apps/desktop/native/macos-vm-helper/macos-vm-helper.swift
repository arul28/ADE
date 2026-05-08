import AppKit
import Foundation
import ScreenCaptureKit
@preconcurrency import Virtualization

enum HelperError: Error, CustomStringConvertible {
    case usage(String)
    case unsupported(String)
    case missing(String)
    case invalid(String)

    var description: String {
        switch self {
        case .usage(let value), .unsupported(let value), .missing(let value), .invalid(let value):
            return value
        }
    }
}

struct Options {
    var values: [String: String] = [:]
    var flags: Set<String> = []

    init(_ args: [String]) throws {
        var index = 0
        while index < args.count {
            let arg = args[index]
            if !arg.hasPrefix("--") {
                throw HelperError.usage("unexpected argument: \(arg)")
            }
            if index + 1 < args.count && !args[index + 1].hasPrefix("--") {
                values[arg] = args[index + 1]
                index += 2
            } else {
                flags.insert(arg)
                index += 1
            }
        }
    }

    func string(_ key: String) -> String? {
        values[key]
    }

    func required(_ key: String) throws -> String {
        guard let value = values[key], !value.isEmpty else {
            throw HelperError.usage("missing required option \(key)")
        }
        return value
    }
}

func emit(_ payload: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func fail(_ error: Error) -> Never {
    let message = (error as? HelperError)?.description ?? error.localizedDescription
    emit(["type": "error", "message": message])
    fputs("\(message)\n", stderr)
    exit(1)
}

func parseSizeBytes(_ value: String, fallback: UInt64) -> UInt64 {
    let upper = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    let multipliers: [(String, UInt64)] = [
        ("TB", 1024 * 1024 * 1024 * 1024),
        ("GB", 1024 * 1024 * 1024),
        ("MB", 1024 * 1024),
    ]
    for (suffix, multiplier) in multipliers where upper.hasSuffix(suffix) {
        let number = upper.dropLast(suffix.count)
        return UInt64(String(number)).map { $0 * multiplier } ?? fallback
    }
    return UInt64(upper).map { $0 * 1024 * 1024 * 1024 } ?? fallback
}

func parseDisplay(_ value: String) -> (Int, Int) {
    let parts = value.lowercased().split(separator: "x")
    guard parts.count == 2, let width = Int(parts[0]), let height = Int(parts[1]) else {
        return (1920, 1200)
    }
    return (width, height)
}

func bundleURL(_ path: String) -> URL {
    URL(fileURLWithPath: path, isDirectory: true)
}

func diskURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("Disk.img")
}

func auxiliaryStorageURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("AuxiliaryStorage")
}

func serialLogURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("Serial.log")
}

func hardwareModelURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("HardwareModel")
}

func machineIdentifierURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("MachineIdentifier")
}

func configURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("ade-vm.json")
}

func runtimeStatusURL(_ bundle: URL) -> URL {
    bundle.appendingPathComponent("runtime-status.json")
}

func stateName(_ state: VZVirtualMachine.State) -> String {
    switch state {
    case .stopped:
        return "stopped"
    case .running:
        return "running"
    case .paused:
        return "paused"
    case .error:
        return "error"
    case .starting:
        return "starting"
    case .pausing:
        return "pausing"
    case .resuming:
        return "resuming"
    case .stopping:
        return "stopping"
    case .saving:
        return "saving"
    case .restoring:
        return "restoring"
    @unknown default:
        return "unknown"
    }
}

func writeRuntimeStatus(bundle: URL, virtualMachine: VZVirtualMachine, title: String, event: String, extra: [String: Any] = [:]) {
    var payload: [String: Any] = [
        "type": "runtime-status",
        "title": title,
        "event": event,
        "state": stateName(virtualMachine.state),
        "pid": ProcessInfo.processInfo.processIdentifier,
        "updatedAt": ISO8601DateFormatter().string(from: Date()),
    ]
    for (key, value) in extra {
        payload[key] = value
    }
    try? writeJSONFile(runtimeStatusURL(bundle), payload)
}

func latestRestoreImage() async throws -> VZMacOSRestoreImage {
    try await withCheckedThrowingContinuation { continuation in
        VZMacOSRestoreImage.fetchLatestSupported { result in
            continuation.resume(with: result)
        }
    }
}

func localRestoreImage(_ url: URL) async throws -> VZMacOSRestoreImage {
    try await withCheckedThrowingContinuation { continuation in
        VZMacOSRestoreImage.load(from: url) { result in
            continuation.resume(with: result)
        }
    }
}

func restoreInfo(_ restoreImage: VZMacOSRestoreImage) -> [String: Any] {
    var result: [String: Any] = [
        "url": restoreImage.url.absoluteString,
        "buildVersion": restoreImage.buildVersion,
        "isSupported": restoreImage.isSupported,
        "version": [
            "major": restoreImage.operatingSystemVersion.majorVersion,
            "minor": restoreImage.operatingSystemVersion.minorVersion,
            "patch": restoreImage.operatingSystemVersion.patchVersion,
        ],
    ]
    if let requirements = restoreImage.mostFeaturefulSupportedConfiguration {
        result["requirements"] = [
            "minimumSupportedCPUCount": requirements.minimumSupportedCPUCount,
            "minimumSupportedMemorySize": requirements.minimumSupportedMemorySize,
        ]
    }
    return result
}

func loadHardwareModel(_ bundle: URL) throws -> VZMacHardwareModel {
    let data = try Data(contentsOf: hardwareModelURL(bundle))
    guard let hardwareModel = VZMacHardwareModel(dataRepresentation: data) else {
        throw HelperError.invalid("failed to load VM hardware model")
    }
    guard hardwareModel.isSupported else {
        throw HelperError.unsupported("the VM hardware model is not supported on this host")
    }
    return hardwareModel
}

func loadMachineIdentifier(_ bundle: URL) throws -> VZMacMachineIdentifier {
    let data = try Data(contentsOf: machineIdentifierURL(bundle))
    guard let identifier = VZMacMachineIdentifier(dataRepresentation: data) else {
        throw HelperError.invalid("failed to load VM machine identifier")
    }
    return identifier
}

func createMacPlatform(bundle: URL, hardwareModel: VZMacHardwareModel? = nil) throws -> VZMacPlatformConfiguration {
    let platform = VZMacPlatformConfiguration()
    let model = try hardwareModel ?? loadHardwareModel(bundle)
    platform.hardwareModel = model
    platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: auxiliaryStorageURL(bundle))
    platform.machineIdentifier = try loadMachineIdentifier(bundle)
    return platform
}

func createDirectoryShare(_ sharedPath: String?) -> VZVirtioFileSystemDeviceConfiguration? {
    guard let sharedPath, !sharedPath.isEmpty else { return nil }
    let sharedURL = URL(fileURLWithPath: sharedPath, isDirectory: true)
    let sharedDirectory = VZSharedDirectory(url: sharedURL, readOnly: false)
    let singleShare = VZSingleDirectoryShare(directory: sharedDirectory)
    let sharing = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
    sharing.share = singleShare
    return sharing
}

func createConfiguration(
    bundle: URL,
    cpuCount requestedCPUCount: Int,
    memorySize requestedMemorySize: UInt64,
    display: String,
    sharedPath: String?,
    hardwareModel: VZMacHardwareModel? = nil
) throws -> VZVirtualMachineConfiguration {
    let configuration = VZVirtualMachineConfiguration()
    configuration.platform = try createMacPlatform(bundle: bundle, hardwareModel: hardwareModel)
    configuration.bootLoader = VZMacOSBootLoader()
    configuration.cpuCount = max(1, min(requestedCPUCount, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    configuration.memorySize = max(
        VZVirtualMachineConfiguration.minimumAllowedMemorySize,
        min(requestedMemorySize, VZVirtualMachineConfiguration.maximumAllowedMemorySize)
    )

    let attachment = try VZDiskImageStorageDeviceAttachment(url: diskURL(bundle), readOnly: false)
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]

    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    configuration.networkDevices = [network]

    configuration.serialPorts = [try createSerialPort(bundle: bundle)]
    configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

    let graphics = VZMacGraphicsDeviceConfiguration()
    let (width, height) = parseDisplay(display)
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: width, heightInPixels: height, pixelsPerInch: 200)]
    configuration.graphicsDevices = [graphics]

    configuration.keyboards = [VZUSBKeyboardConfiguration()]
    if #available(macOS 13.0, *) {
        configuration.pointingDevices = [
            VZUSBScreenCoordinatePointingDeviceConfiguration(),
            VZMacTrackpadConfiguration(),
        ]
    } else {
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    }

    if let share = createDirectoryShare(sharedPath) {
        configuration.directorySharingDevices = [share]
    }

    try configuration.validate()
    if #available(macOS 14.0, *) {
        try configuration.validateSaveRestoreSupport()
    }
    return configuration
}

func writeJSONFile(_ url: URL, _ payload: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url)
}

func createSparseDisk(_ url: URL, size: UInt64) throws {
    FileManager.default.createFile(atPath: url.path, contents: nil)
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: size)
    try handle.close()
}

func createSerialPort(bundle: URL) throws -> VZSerialPortConfiguration {
    let logURL = serialLogURL(bundle)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let readHandle = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/null"))
    let writeHandle = try FileHandle(forWritingTo: logURL)
    try writeHandle.seekToEnd()
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = VZFileHandleSerialPortAttachment(
        fileHandleForReading: readHandle,
        fileHandleForWriting: writeHandle
    )
    return serial
}

func downloadRestoreImageURL(_ remoteURL: URL, to localURL: URL) async throws -> URL {
    if FileManager.default.fileExists(atPath: localURL.path) {
        return localURL
    }
    try FileManager.default.createDirectory(at: localURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let temporaryURL = localURL.appendingPathExtension("download")
    try? FileManager.default.removeItem(at: temporaryURL)
    FileManager.default.createFile(atPath: temporaryURL.path, contents: nil)
    let handle = try FileHandle(forWritingTo: temporaryURL)
    defer {
        try? handle.close()
    }
    emit(["type": "progress", "stage": "download", "message": "Downloading macOS restore image.", "url": remoteURL.absoluteString])
    let (bytes, response) = try await URLSession.shared.bytes(from: remoteURL)
    let expected = response.expectedContentLength
    var written: Int64 = 0
    var lastEmit = Date.distantPast
    var buffer = Data()
    buffer.reserveCapacity(1024 * 1024)
    for try await byte in bytes {
        buffer.append(byte)
        if buffer.count >= 1024 * 1024 {
            handle.write(buffer)
            written += Int64(buffer.count)
            buffer.removeAll(keepingCapacity: true)
            if expected > 0 && Date().timeIntervalSince(lastEmit) >= 1.5 {
                lastEmit = Date()
                emit([
                    "type": "progress",
                    "stage": "download",
                    "message": "Downloading macOS restore image.",
                    "fraction": min(0.95, Double(written) / Double(expected)),
                    "bytesWritten": written,
                    "totalBytes": expected,
                    "url": remoteURL.absoluteString,
                ])
            }
        }
    }
    if !buffer.isEmpty {
        handle.write(buffer)
        written += Int64(buffer.count)
    }
    try? FileManager.default.removeItem(at: localURL)
    try FileManager.default.moveItem(at: temporaryURL, to: localURL)
    emit([
        "type": "progress",
        "stage": "download",
        "message": "Downloaded macOS restore image.",
        "fraction": 1.0,
        "bytesWritten": written,
        "totalBytes": expected,
        "url": remoteURL.absoluteString,
    ])
    return localURL
}

func downloadRestoreImage(_ remote: VZMacOSRestoreImage, to localURL: URL) async throws -> URL {
    try await downloadRestoreImageURL(remote.url, to: localURL)
}

@MainActor
func provision(_ options: Options) async throws {
    guard VZVirtualMachine.isSupported else {
        throw HelperError.unsupported("Apple Virtualization does not support macOS VMs on this host")
    }
    let bundle = bundleURL(try options.required("--bundle"))
    let ipsw = options.string("--ipsw") ?? "latest"
    let cpu = Int(options.string("--cpu") ?? "2") ?? 2
    let memory = parseSizeBytes(options.string("--memory") ?? "4GB", fallback: 4 * 1024 * 1024 * 1024)
    let disk = parseSizeBytes(options.string("--disk-size") ?? "64GB", fallback: 64 * 1024 * 1024 * 1024)
    let display = options.string("--display") ?? "1440x900"
    let sharedPath = options.string("--shared-dir")
    let restoreImagesDir = options.string("--restore-images-dir").map { URL(fileURLWithPath: $0, isDirectory: true) }

    try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)

    let restoreImage: VZMacOSRestoreImage
    let restoreURL: URL
    if ipsw == "latest" {
        let remote = try await latestRestoreImage()
        let cacheDir = restoreImagesDir ?? bundle
        restoreURL = try await downloadRestoreImage(remote, to: cacheDir.appendingPathComponent(remote.url.lastPathComponent))
        restoreImage = try await localRestoreImage(restoreURL)
    } else if let remoteURL = URL(string: ipsw), remoteURL.scheme == "https" || remoteURL.scheme == "http" {
        let cacheDir = restoreImagesDir ?? bundle
        restoreURL = try await downloadRestoreImageURL(remoteURL, to: cacheDir.appendingPathComponent(remoteURL.lastPathComponent))
        restoreImage = try await localRestoreImage(restoreURL)
    } else {
        restoreURL = URL(fileURLWithPath: ipsw)
        restoreImage = try await localRestoreImage(restoreURL)
    }
    guard restoreImage.isSupported, let requirements = restoreImage.mostFeaturefulSupportedConfiguration else {
        throw HelperError.unsupported("restore image is not supported by this host")
    }

    emit(["type": "progress", "stage": "configure", "message": "Creating VM bundle."])
    try? FileManager.default.removeItem(at: diskURL(bundle))
    try? FileManager.default.removeItem(at: auxiliaryStorageURL(bundle))
    try createSparseDisk(diskURL(bundle), size: disk)
    _ = try VZMacAuxiliaryStorage(creatingStorageAt: auxiliaryStorageURL(bundle), hardwareModel: requirements.hardwareModel, options: [])
    try requirements.hardwareModel.dataRepresentation.write(to: hardwareModelURL(bundle))
    let machineIdentifier = VZMacMachineIdentifier()
    try machineIdentifier.dataRepresentation.write(to: machineIdentifierURL(bundle))

    let effectiveCPU = max(cpu, requirements.minimumSupportedCPUCount)
    let effectiveMemory = max(memory, UInt64(requirements.minimumSupportedMemorySize))
    let configuration = try createConfiguration(
        bundle: bundle,
        cpuCount: effectiveCPU,
        memorySize: effectiveMemory,
        display: display,
        sharedPath: sharedPath,
        hardwareModel: requirements.hardwareModel
    )
    let virtualMachine = VZVirtualMachine(configuration: configuration, queue: .main)
    let installer = VZMacOSInstaller(virtualMachine: virtualMachine, restoringFromImageAt: restoreURL)
    let observer = installer.progress.observe(\.fractionCompleted, options: [.initial, .new]) { progress, _ in
        emit(["type": "progress", "stage": "install", "fraction": progress.fractionCompleted])
    }
    emit(["type": "progress", "stage": "install", "message": "Installing macOS into the VM disk."])
    try await installer.install()
    observer.invalidate()

    try writeJSONFile(configURL(bundle), [
        "cpuCount": effectiveCPU,
        "memorySize": effectiveMemory,
        "diskSize": disk,
        "display": display,
        "restoreImage": restoreInfo(restoreImage),
        "createdAt": ISO8601DateFormatter().string(from: Date()),
    ])
    emit(["type": "completed", "bundle": bundle.path, "restoreImage": restoreInfo(restoreImage)])
}

final class VMWindowDelegate: NSObject, NSWindowDelegate, VZVirtualMachineDelegate {
    let virtualMachine: VZVirtualMachine
    let bundle: URL
    let title: String
    let vmQueue: DispatchQueue
    var retainedWindow: NSWindow?
    var statusTimer: Timer?

    init(_ virtualMachine: VZVirtualMachine, bundle: URL, title: String, vmQueue: DispatchQueue) {
        self.virtualMachine = virtualMachine
        self.bundle = bundle
        self.title = title
        self.vmQueue = vmQueue
    }

    func windowWillClose(_ notification: Notification) {
        vmQueue.async {
            writeRuntimeStatus(bundle: self.bundle, virtualMachine: self.virtualMachine, title: self.title, event: "window-will-close")
            do {
                try self.virtualMachine.requestStop()
            } catch {
                self.virtualMachine.stop { _ in
                    DispatchQueue.main.async {
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        DispatchQueue.main.async {
            self.statusTimer?.invalidate()
            writeRuntimeStatus(bundle: self.bundle, virtualMachine: virtualMachine, title: self.title, event: "guest-did-stop")
            NSApp.terminate(nil)
        }
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        DispatchQueue.main.async {
            self.statusTimer?.invalidate()
            writeRuntimeStatus(
                bundle: self.bundle,
                virtualMachine: virtualMachine,
                title: self.title,
                event: "did-stop-with-error",
                extra: ["error": error.localizedDescription]
            )
            NSApp.terminate(nil)
        }
    }
}

@MainActor
func runVM(_ options: Options) throws {
    guard VZVirtualMachine.isSupported else {
        throw HelperError.unsupported("Apple Virtualization does not support macOS VMs on this host")
    }
    let bundle = bundleURL(try options.required("--bundle"))
    let title = options.string("--title") ?? bundle.lastPathComponent
    let cpu = Int(options.string("--cpu") ?? "2") ?? 2
    let memory = parseSizeBytes(options.string("--memory") ?? "4GB", fallback: 4 * 1024 * 1024 * 1024)
    let display = options.string("--display") ?? "1440x900"
    let sharedPath = options.string("--shared-dir")
    let headless = options.flags.contains("--headless")
    let recovery = options.flags.contains("--recovery")
    let app = NSApplication.shared
    if headless {
        app.setActivationPolicy(.accessory)
    } else {
        app.setActivationPolicy(.regular)
    }
    app.finishLaunching()

    let configuration = try createConfiguration(bundle: bundle, cpuCount: cpu, memorySize: memory, display: display, sharedPath: sharedPath)
    let vmQueue = DispatchQueue(label: "ade.macos-vm.virtual-machine")
    let virtualMachine = VZVirtualMachine(configuration: configuration, queue: vmQueue)

    let delegate = VMWindowDelegate(virtualMachine, bundle: bundle, title: title, vmQueue: vmQueue)
    virtualMachine.delegate = delegate
    writeRuntimeStatus(bundle: bundle, virtualMachine: virtualMachine, title: title, event: "configured")
    if headless {
    } else {
        let window = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isOpaque = false
        let vmView = VZVirtualMachineView()
        vmView.virtualMachine = virtualMachine
        if #available(macOS 14.0, *) {
            vmView.capturesSystemKeys = true
        }
        window.contentView = vmView
        window.initialFirstResponder = vmView
        window.delegate = delegate
        delegate.retainedWindow = window
        window.makeKeyAndOrderFront(vmView)
        NSRunningApplication.current.activate(options: [.activateAllWindows])
    }

    delegate.statusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
        vmQueue.async {
            writeRuntimeStatus(bundle: bundle, virtualMachine: virtualMachine, title: title, event: "heartbeat")
        }
    }
    let startVirtualMachine = {
        vmQueue.async {
            writeRuntimeStatus(bundle: bundle, virtualMachine: virtualMachine, title: title, event: recovery ? "recovery-start-requested" : "start-requested")
            let completion: (Error?) -> Void = { error in
                if let error {
                    DispatchQueue.main.async {
                        delegate.statusTimer?.invalidate()
                    }
                    writeRuntimeStatus(
                        bundle: bundle,
                        virtualMachine: virtualMachine,
                        title: title,
                        event: "start-failed",
                        extra: ["error": error.localizedDescription]
                    )
                    fail(error)
                } else {
                    writeRuntimeStatus(bundle: bundle, virtualMachine: virtualMachine, title: title, event: "start-completed")
                    emit(["type": "started", "title": title, "bundle": bundle.path])
                }
            }
            if #available(macOS 13.0, *) {
                let startOptions = VZMacOSVirtualMachineStartOptions()
                startOptions.startUpFromMacOSRecovery = recovery
                virtualMachine.start(options: startOptions, completionHandler: completion)
            } else if recovery {
                let error = NSError(
                    domain: "ADEMacOSVMHelper",
                    code: 13,
                    userInfo: [NSLocalizedDescriptionKey: "Starting a macOS VM in recovery requires macOS 13 or newer."]
                )
                completion(error)
            } else {
                virtualMachine.start { result in
                    switch result {
                    case .success:
                        completion(nil)
                    case .failure(let error):
                        completion(error)
                    }
                }
            }
        }
    }
    Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in
        startVirtualMachine()
    }
    withExtendedLifetime(delegate) {
        app.run()
    }
}

func doctor() {
    emit([
        "type": "doctor",
        "supported": VZVirtualMachine.isSupported,
        "platform": "apple-virtualization",
        "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    ])
}

func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    if let double = value as? Double {
        return double
    }
    if let int = value as? Int {
        return Double(int)
    }
    return nil
}

func findWindow(_ options: Options) throws -> [String: Any] {
    let titleQuery = options.string("--title") ?? ""
    let ownerQuery = options.string("--owner") ?? "macos-vm-helper"
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for window in windows {
        let ownerName = window[kCGWindowOwnerName as String] as? String ?? ""
        let windowTitle = window[kCGWindowName as String] as? String ?? ""
        if !ownerQuery.isEmpty && !ownerName.localizedCaseInsensitiveContains(ownerQuery) {
            continue
        }
        if !titleQuery.isEmpty && !windowTitle.localizedCaseInsensitiveContains(titleQuery) {
            continue
        }
        guard let windowId = (window[kCGWindowNumber as String] as? NSNumber)?.intValue else {
            continue
        }
        let processId = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let x = numberValue(bounds["X"]) ?? 0
        let y = numberValue(bounds["Y"]) ?? 0
        let width = max(1, numberValue(bounds["Width"]) ?? 1)
        let height = max(1, numberValue(bounds["Height"]) ?? 1)
        return [
            "type": "window",
            "windowId": windowId,
            "processId": processId,
            "processName": ownerName,
            "windowTitle": windowTitle,
            "x": Int(x.rounded()),
            "y": Int(y.rounded()),
            "width": Int(width.rounded()),
            "height": Int(height.rounded()),
        ]
    }
    let titleDetail = titleQuery.isEmpty ? "any title" : "\"\(titleQuery)\""
    let ownerDetail = ownerQuery.isEmpty ? "any owner" : "\"\(ownerQuery)\""
    throw HelperError.missing("No visible macOS VM window matched \(titleDetail) owned by \(ownerDetail)")
}

func windowInfo(_ options: Options) throws {
    let payload = try findWindow(options)
    if options.flags.contains("--activate"), let processId = payload["processId"] as? Int {
        _ = NSRunningApplication(processIdentifier: pid_t(processId))?.activate(options: [.activateIgnoringOtherApps])
    }
    emit(payload)
}

func runProcess(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let stderr = Pipe()
    let stdout = FileHandle(forWritingAtPath: "/dev/null")
    if let stdoutHandle = stdout {
        process.standardOutput = stdoutHandle
    }
    process.standardError = stderr
    defer {
        try? stdout?.close()
    }
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let data = stderr.fileHandleForReading.readDataToEndOfFile()
        let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw HelperError.invalid(detail?.isEmpty == false ? detail! : "\(executable) exited with code \(process.terminationStatus)")
    }
}

@MainActor
func captureWindow(_ options: Options) async throws {
    let output = try options.required("--output")
    let payload = try findWindow(options)
    guard let windowId = payload["windowId"] as? Int else {
        throw HelperError.missing("No window id was available for capture")
    }
    _ = NSApplication.shared
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { Int($0.windowID) == windowId }) else {
        throw HelperError.missing("No ScreenCaptureKit window matched id \(windowId)")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor
        ?? NSScreen.main?.backingScaleFactor
        ?? 2
    configuration.width = max(1, Int(window.frame.width * scale))
    configuration.height = max(1, Int(window.frame.height * scale))
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw HelperError.invalid("failed to encode macOS VM screenshot")
    }
    try data.write(to: URL(fileURLWithPath: output))
    var result = payload
    result["output"] = output
    result["captureMode"] = "window-id"
    result["captureBackend"] = "screencapturekit"
    emit(result)
}

@main
struct MacosVmHelper {
    static func main() {
        do {
            var args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else {
                throw HelperError.usage("usage: macos-vm-helper <doctor|latest-restore|inspect-restore|provision|run|window-info|capture-window>")
            }
            args.removeFirst()
            let options = try Options(args)
            if command == "run" {
                try runVM(options)
                return
            }
            if command == "--smoke-test" || command == "doctor" {
                doctor()
                return
            }
            if command == "window-info" {
                try windowInfo(options)
                return
            }
            Task {
                do {
                    switch command {
                    case "latest-restore":
                        let image = try await latestRestoreImage()
                        emit(["type": "restore-image", "restoreImage": restoreInfo(image)])
                    case "inspect-restore":
                        let image = try await localRestoreImage(URL(fileURLWithPath: try options.required("--ipsw")))
                        emit(["type": "restore-image", "restoreImage": restoreInfo(image)])
                    case "provision":
                        try await provision(options)
                    case "capture-window":
                        try await captureWindow(options)
                    default:
                        throw HelperError.usage("unknown command: \(command)")
                    }
                    exit(0)
                } catch {
                    fail(error)
                }
            }
            dispatchMain()
        } catch {
            fail(error)
        }
    }
}
