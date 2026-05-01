import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

func eprint(_ value: String) {
  FileHandle.standardError.write((value + "\n").data(using: .utf8) ?? Data())
}

func jsonStatus(_ payload: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: payload),
     let text = String(data: data, encoding: .utf8) {
    eprint("[sim-capture] " + text)
  }
}

struct Options {
  var udid: String?
  var fps: Int = 60
  var quality: Double = 0.52
  var smokeTest = false
}

func parseOptions() -> Options {
  var options = Options()
  var index = 1
  let args = CommandLine.arguments
  while index < args.count {
    let arg = args[index]
    if arg == "--smoke-test" {
      options.smokeTest = true
    } else if arg == "--udid", index + 1 < args.count {
      index += 1
      options.udid = args[index]
    } else if arg == "--fps", index + 1 < args.count {
      index += 1
      options.fps = max(1, min(120, Int(args[index]) ?? 60))
    } else if arg == "--quality", index + 1 < args.count {
      index += 1
      options.quality = max(0.25, min(0.9, Double(args[index]) ?? 0.52))
    } else {
      eprint("[sim-capture] unknown argument: \(arg)")
      exit(64)
    }
    index += 1
  }
  return options
}

let options = parseOptions()

let coreSimulatorPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
guard dlopen(coreSimulatorPath, RTLD_NOW) != nil else {
  eprint("[sim-capture] FAIL dlopen CoreSimulator: \(String(cString: dlerror()))")
  exit(2)
}

guard let simServiceContext = NSClassFromString("SimServiceContext") as? NSObject.Type,
      let renderableProtocol = NSProtocolFromString("SimDisplayIOSurfaceRenderable") else {
  eprint("[sim-capture] FAIL CoreSimulator runtime symbols missing")
  exit(2)
}

func developerDir() -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  process.arguments = ["-p"]
  let pipe = Pipe()
  process.standardOutput = pipe
  do {
    try process.run()
  } catch {
    return "/Applications/Xcode.app/Contents/Developer"
  }
  process.waitUntilExit()
  let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : trimmed
}

func bootstrap() -> AnyObject? {
  let selector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
  typealias Signature = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
  guard let implementation = simServiceContext.method(for: selector) else { return nil }
  let function = unsafeBitCast(implementation, to: Signature.self)
  var error: NSError?
  let context = withUnsafeMutablePointer(to: &error) { pointer -> AnyObject? in
    function(simServiceContext, selector, developerDir() as NSString, AutoreleasingUnsafeMutablePointer(pointer))
  }
  if context == nil {
    eprint("[sim-capture] sharedServiceContext err: \(String(describing: error))")
  }
  return context
}

func defaultDeviceSet(_ context: AnyObject) -> AnyObject? {
  let selector = NSSelectorFromString("defaultDeviceSetWithError:")
  typealias Signature = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
  guard let implementation = (context as! NSObject).method(for: selector) else { return nil }
  let function = unsafeBitCast(implementation, to: Signature.self)
  var error: NSError?
  let deviceSet = withUnsafeMutablePointer(to: &error) { pointer -> AnyObject? in
    function(context, selector, AutoreleasingUnsafeMutablePointer(pointer))
  }
  if deviceSet == nil {
    eprint("[sim-capture] defaultDeviceSet err: \(String(describing: error))")
  }
  return deviceSet
}

func deviceUdid(_ device: AnyObject) -> String {
  if let uuid = device.value(forKey: "UDID") as? NSUUID {
    return uuid.uuidString
  }
  return (device.value(forKey: "udid") as? String) ?? "?"
}

func bootedDevice(_ deviceSet: AnyObject, udid: String?) -> NSObject? {
  guard let devices = deviceSet.value(forKey: "devices") as? NSArray else { return nil }
  for entry in devices {
    let device = entry as AnyObject
    let state = (device.value(forKey: "state") as? NSNumber)?.intValue ?? -1
    if state != 3 { continue }
    if let requested = udid, deviceUdid(device).caseInsensitiveCompare(requested) != .orderedSame {
      continue
    }
    return device as? NSObject
  }
  return nil
}

func findDisplayDescriptor(_ device: NSObject) -> NSObject? {
  guard let io = device.value(forKey: "io") as? NSObject,
        let ports = io.value(forKey: "ioPorts") as? NSArray else { return nil }
  let descriptorSelector = NSSelectorFromString("descriptor")
  let surfaceSelector = NSSelectorFromString("framebufferSurface")
  typealias DescriptorSignature = @convention(c) (AnyObject, Selector) -> AnyObject?
  var best: NSObject?
  var bestArea = 0
  for entry in ports {
    let port = entry as! NSObject
    guard let implementation = port.method(for: descriptorSelector) else { continue }
    let function = unsafeBitCast(implementation, to: DescriptorSignature.self)
    guard let descriptor = function(port, descriptorSelector) as? NSObject else { continue }
    if !descriptor.conforms(to: renderableProtocol) { continue }
    guard let surfaceValue = descriptor.perform(surfaceSelector)?.takeUnretainedValue(),
          CFGetTypeID(surfaceValue) == IOSurfaceGetTypeID() else { continue }
    let surface = unsafeBitCast(surfaceValue, to: IOSurfaceRef.self) as IOSurface
    let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
    if area > bestArea {
      bestArea = area
      best = descriptor
    }
  }
  return best
}

final class Stream {
  let descriptor: NSObject
  let device: NSObject
  let targetUdid: String
  let maxFps: Int
  let jpegQuality: Double
  let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  let stdout = FileHandle.standardOutput
  let writeLock = NSLock()
  let callbackUUID = NSUUID()
  let damageCallbackUUID = NSUUID()
  var registered = false
  var damageRegistered = false
  var encoding = false
  var frameCount = 0
  var lastReportTime = Date()
  var lastEmitTime = Date(timeIntervalSince1970: 0)
  var width = 0
  var height = 0

  init(descriptor: NSObject, device: NSObject, targetUdid: String, maxFps: Int, jpegQuality: Double) {
    self.descriptor = descriptor
    self.device = device
    self.targetUdid = targetUdid
    self.maxFps = max(1, maxFps)
    self.jpegQuality = max(0.25, min(0.9, jpegQuality))
  }

  func start() {
    let initial = descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue()
    if let surfaceValue = initial, CFGetTypeID(surfaceValue) == IOSurfaceGetTypeID() {
      let surface = unsafeBitCast(surfaceValue, to: IOSurfaceRef.self) as IOSurface
      width = IOSurfaceGetWidth(surface)
      height = IOSurfaceGetHeight(surface)
      jsonStatus([
        "type": "stream-started",
        "pixelWidth": width,
        "pixelHeight": height,
        "deviceUDID": targetUdid,
        "deviceName": (device.value(forKey: "name") as? String) ?? "?",
        "fps": maxFps,
        "quality": jpegQuality,
      ])
      handle(surface: surface, force: true)
    } else {
      eprint("[sim-capture] no initial framebufferSurface")
    }

    let surfaceSelector = NSSelectorFromString("registerCallbackWithUUID:ioSurfacesChangeCallback:")
    typealias SurfaceSignature = @convention(c) (AnyObject, Selector, NSUUID, @convention(block) (AnyObject?, AnyObject?) -> Void) -> Void
    if let implementation = descriptor.method(for: surfaceSelector) {
      let function = unsafeBitCast(implementation, to: SurfaceSignature.self)
      let block: @convention(block) (AnyObject?, AnyObject?) -> Void = { [weak self] _, value in
        guard let self,
              let surfaceValue = value,
              CFGetTypeID(surfaceValue) == IOSurfaceGetTypeID() else { return }
        let surface = unsafeBitCast(surfaceValue, to: IOSurfaceRef.self) as IOSurface
        self.handle(surface: surface)
      }
      function(descriptor, surfaceSelector, callbackUUID, block)
      registered = true
    } else {
      eprint("[sim-capture] WARN no IOSurface callback selector")
    }

    let damageSelector = NSSelectorFromString("registerCallbackWithUUID:damageRectanglesCallback:")
    typealias DamageSignature = @convention(c) (AnyObject, Selector, NSUUID, @convention(block) (AnyObject?) -> Void) -> Void
    if let implementation = descriptor.method(for: damageSelector) {
      let function = unsafeBitCast(implementation, to: DamageSignature.self)
      let block: @convention(block) (AnyObject?) -> Void = { [weak self] _ in
        guard let self,
              let surfaceValue = self.descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue(),
              CFGetTypeID(surfaceValue) == IOSurfaceGetTypeID() else { return }
        let surface = unsafeBitCast(surfaceValue, to: IOSurfaceRef.self) as IOSurface
        self.handle(surface: surface)
      }
      function(descriptor, damageSelector, damageCallbackUUID, block)
      damageRegistered = true
    } else {
      eprint("[sim-capture] WARN no damage callback selector")
    }
  }

  func stop() {
    if registered {
      let selector = NSSelectorFromString("unregisterIOSurfacesChangeCallbackWithUUID:")
      typealias Signature = @convention(c) (AnyObject, Selector, NSUUID) -> Void
      if let implementation = descriptor.method(for: selector) {
        unsafeBitCast(implementation, to: Signature.self)(descriptor, selector, callbackUUID)
      }
      registered = false
    }
    if damageRegistered {
      let selector = NSSelectorFromString("unregisterDamageRectanglesCallbackWithUUID:")
      typealias Signature = @convention(c) (AnyObject, Selector, NSUUID) -> Void
      if let implementation = descriptor.method(for: selector) {
        unsafeBitCast(implementation, to: Signature.self)(descriptor, selector, damageCallbackUUID)
      }
      damageRegistered = false
    }
  }

  func handle(surface: IOSurface, force: Bool = false) {
    let now = Date()
    if !force && now.timeIntervalSince(lastEmitTime) < (1.0 / Double(maxFps)) {
      return
    }
    objc_sync_enter(self)
    if encoding {
      objc_sync_exit(self)
      return
    }
    encoding = true
    objc_sync_exit(self)
    defer {
      objc_sync_enter(self)
      encoding = false
      objc_sync_exit(self)
    }
    lastEmitTime = now
    let image = CIImage(ioSurface: surface)
    let opts: [CIImageRepresentationOption: Any] = [
      CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): jpegQuality,
    ]
    guard let jpeg = ciContext.jpegRepresentation(
      of: image,
      colorSpace: CGColorSpaceCreateDeviceRGB(),
      options: opts
    ) else { return }
    var length = UInt32(jpeg.count).bigEndian
    let header = withUnsafeBytes(of: &length) { Data($0) }
    writeLock.lock()
    defer { writeLock.unlock() }
    do {
      try stdout.write(contentsOf: header)
      try stdout.write(contentsOf: jpeg)
    } catch {
      exit(0)
    }
    frameCount += 1
    let elapsed = now.timeIntervalSince(lastReportTime)
    if elapsed >= 5 {
      eprint("[sim-capture] fps≈\(Int(Double(frameCount) / elapsed))")
      frameCount = 0
      lastReportTime = now
    }
  }
}

guard let context = bootstrap(),
      let deviceSet = defaultDeviceSet(context) else {
  exit(2)
}

if options.smokeTest {
  _ = deviceSet.value(forKey: "devices") as? NSArray
  jsonStatus(["type": "smoke-ok"])
  exit(0)
}

guard let requestedUdid = options.udid, !requestedUdid.isEmpty else {
  eprint("[sim-capture] --udid is required")
  exit(64)
}

var currentStream: Stream?
var currentDeviceUdid = ""
let stateQueue = DispatchQueue(label: "ade.sim-capture.state")

func stopCurrentStream() {
  stateQueue.sync {
    currentStream?.stop()
  }
}

let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTerm.setEventHandler {
  stopCurrentStream()
  exit(0)
}
sigTerm.resume()
signal(SIGTERM, SIG_IGN)

let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigInt.setEventHandler {
  stopCurrentStream()
  exit(0)
}
sigInt.resume()
signal(SIGINT, SIG_IGN)

DispatchQueue.global(qos: .userInitiated).async {
  var notifiedNoBoot = false
  while true {
    if let device = bootedDevice(deviceSet, udid: requestedUdid) {
      let udid = deviceUdid(device)
      let needsSwap = stateQueue.sync { udid != currentDeviceUdid }
      if needsSwap {
        stateQueue.sync {
          currentStream?.stop()
          currentStream = nil
        }
        if let descriptor = findDisplayDescriptor(device) {
          let stream = Stream(descriptor: descriptor, device: device, targetUdid: udid, maxFps: options.fps, jpegQuality: options.quality)
          stream.start()
          stateQueue.sync {
            currentStream = stream
            currentDeviceUdid = udid
          }
          notifiedNoBoot = false
        } else {
          eprint("[sim-capture] no display descriptor on booted device (will retry)")
        }
      }
    } else {
      let hadStream = stateQueue.sync { currentStream != nil }
      if hadStream {
        eprint("[sim-capture] booted device gone")
        stateQueue.sync {
          currentStream?.stop()
          currentStream = nil
          currentDeviceUdid = ""
        }
      }
      if !notifiedNoBoot {
        jsonStatus(["type": "no-booted-device", "deviceUDID": requestedUdid])
        notifiedNoBoot = true
      }
    }
    Thread.sleep(forTimeInterval: 1.0)
  }
}

RunLoop.main.run()
