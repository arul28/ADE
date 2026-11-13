import SwiftUI

// MARK: - Chips (pure)

/// What a lane tool chip opens onto. Only things the phone can actually watch
/// or read get a chip: the Mac's active tool on its own ("Apple active") is a
/// fact about someone else's window, not something to tap, so it has none.
enum WorkToolChipKind: Equatable {
  /// The lane's Apple device, while it is up. Opens `AppleDeviceViewer` on
  /// the live stage.
  /// `family` is the status's raw family, for the glyph.
  case simulator(name: String, family: String?)
  /// The desktop browser, one chip for all its tabs. Opens the browser sheet,
  /// which lists the tabs. `agentUsing`: a chat
  /// in this lane is driving the browser right now.
  case browser(tabCount: Int, agentUsing: Bool)
  /// What App Control is attached to. Opens `AppControlViewer` when the host
  /// streams its frames, otherwise the App Control sheet. `live`: the app is
  /// attached over CDP, so frames flow. The chip reads "App": the host's
  /// `appName` is often the launch command ("npm start"), which is not a name.
  case appControl(appName: String, live: Bool = false)
  /// The lane's private macOS screen, while it has one. Opens
  /// `MacDesktopViewer`. `streamLive`: frames flow at full rate.
  /// `agentDriving`: an agent holds the screen's input lease.
  case macDesktop(streamLive: Bool, agentDriving: Bool)
  /// The lane's Android emulator. Opens `AndroidDeviceViewer` on the live
  /// stage. `live`: the emulator is booted.
  case android(name: String, live: Bool)

  /// The SF Symbol on the chip. A simulator's follows its device family, so
  /// an Apple Watch does not show as an iPhone.
  var symbolName: String {
    switch self {
    case .simulator(_, let family): return appleDeviceFamilySymbol(family)
    case .browser: return "globe"
    case .appControl: return "macwindow"
    case .macDesktop: return "desktopcomputer"
    case .android: return "smartphone"
    }
  }
}

/// A chip for a device the chat drives on another machine through its work
/// copy there (`ade apple|android|screen … --machine`), not the lane's own.
struct WorkToolChipRemote: Equatable, Hashable {
  /// The work copy's lane, namespaced to its machine (`registerRemoteWorkCopyLane`):
  /// what the viewer streams and drives.
  let laneId: String
  let machineName: String
}

struct WorkToolChip: Equatable, Identifiable {
  let kind: WorkToolChipKind
  var desktopPlatformLabel: String? = nil
  /// Set for a device on another machine; nil for the lane's own tool.
  var remote: WorkToolChipRemote? = nil

  /// The chip's full name, derived from `kind` so the two cannot drift.
  var label: String {
    switch kind {
    case .simulator(let name, _): return name
    case .browser(let tabCount, _): return workBrowserChipLabel(tabCount: tabCount)
    case .appControl: return appControlTagLabel
    case .macDesktop: return desktopPlatformLabel ?? "macOS"
    case .android(let name, _): return name
    }
  }

  /// The chip's SF Symbol: the kind's, except a Windows host's screen, which
  /// takes the four-pane mark the desktop uses for Windows.
  var symbolName: String {
    if case .macDesktop = kind, desktopPlatformLabel == "Windows" { return windowsDesktopSymbolName }
    return kind.symbolName
  }

  /// The text on the chip. The simulator chip already shows the device icon,
  /// so it drops the family word: "iPhone 16 Pro" shows as "16 Pro". VoiceOver
  /// still reads the full `label`.
  var displayLabel: String {
    let local: String
    if case .simulator(let name, _) = kind {
      local = appleDeviceChipModelName(name)
    } else {
      local = label
    }
    // A device on another machine names that machine: "16 Pro · MacBook Pro".
    guard let remote, !remote.machineName.isEmpty else { return local }
    return "\(local) · \(remote.machineName)"
  }

  var id: String {
    let base: String
    switch kind {
    case .simulator: base = "simulator"
    case .browser: base = "browser"
    case .appControl: base = "app-control"
    case .macDesktop: base = "mac-desktop"
    case .android: base = "android"
    }
    guard let remote else { return base }
    return "\(base)|\(remote.laneId)"
  }
}

/// One of a chat's work copies on another machine whose device the chat
/// drives, from the chat summary's `remoteWork` (desktop `remoteSimulatorUses`,
/// `remoteAndroidEmulatorUses`, `remoteWorkUsesOf(…, "usesDesktop")`). The
/// time of the last use is left out, so the list changes only when a device
/// does.
struct WorkRemoteWorkDevice: Equatable, Hashable {
  /// The account directory's key for that machine.
  let machineKey: String
  let machineName: String
  let projectId: String
  let projectRootPath: String?
  let workCopyLaneId: String
  let simulator: Bool
  let android: Bool
  let desktop: Bool
}

/// The chat's work copies elsewhere that drive a device the phone can show,
/// newest use first. Only those whose machine named the copy's lane and its
/// project (current ADE there). App Control is left out: its frames reach the
/// phone only from the focused machine.
func workRemoteWorkDevices(_ uses: [AgentChatRemoteWorkUse]?) -> [WorkRemoteWorkDevice] {
  var seen: Set<String> = []
  return (uses ?? [])
    .sorted { ($0.lastStartedAt ?? "") > ($1.lastStartedAt ?? "") }
    .compactMap { use -> WorkRemoteWorkDevice? in
      guard use.usesSimulator || use.usesAndroidEmulator || use.usesDesktop,
            !use.machineKey.isEmpty,
            let lane = nonEmptyTrimmed(use.workCopyLaneId),
            let projectId = nonEmptyTrimmed(use.projectId),
            seen.insert("\(use.machineKey)|\(lane)").inserted
      else { return nil }
      return WorkRemoteWorkDevice(
        machineKey: use.machineKey,
        machineName: use.machineName.trimmingCharacters(in: .whitespacesAndNewlines),
        projectId: projectId,
        projectRootPath: nonEmptyTrimmed(use.projectRootPath),
        workCopyLaneId: lane,
        simulator: use.usesSimulator,
        android: use.usesAndroidEmulator,
        desktop: use.usesDesktop
      )
    }
}

/// The lane's tool chips for the chat's floating badge row, in order:
/// simulator, Android, macOS (the lane's Mac Desktop), browser, App Control.
/// The screens the phone can watch lead.
///
/// - Simulator: only while the lane's own device is up (`appleDeviceRunningName`).
///   A device the lane keeps after Shut down is not advertised.
/// - Android: while the lane has an emulator (`androidToolChip`), also when
///   it is off, so the viewer can offer Start. Live dot while it is booted.
/// - Mac Desktop: only while the lane holds a display on a host that can host
///   one. Live dot while frames flow at full rate; accent while an agent
///   drives it.
/// - Browser: when the desktop browser has tabs ("1 tab" / "N tabs"), or when
///   an agent is driving it with none listed ("Browser") — an agent on the
///   browser was always reason enough to surface it.
/// - App Control: "App" while an app is attached. Live dot while it is
///   attached and sending frames.
func workToolChips(
  state: WorkToolsLaneState?,
  appleDevice: AppleDeviceStatus?,
  android: AndroidDeviceStatus? = nil
) -> [WorkToolChip] {
  var chips: [WorkToolChip] = []
  if let chip = appleToolChip(appleDevice) {
    chips.append(chip)
  }
  if let chip = androidToolChip(android) {
    chips.append(chip)
  }
  if let chip = macDesktopToolChip(state?.macDesktop) {
    chips.append(chip)
  }
  let tabCount = state?.browser?.tabs.count ?? 0
  let agentUsingBrowser = workToolsAgentIsUsingBrowser(state)
  if tabCount > 0 || agentUsingBrowser {
    chips.append(WorkToolChip(kind: .browser(tabCount: tabCount, agentUsing: agentUsingBrowser)))
  }
  if let appName = state?.appControl?.appName.trimmingCharacters(in: .whitespacesAndNewlines),
     !appName.isEmpty {
    chips.append(WorkToolChip(kind: .appControl(appName: appName, live: appControlIsLive(state?.appControl))))
  }
  return chips
}

/// The chips of the chat's devices on other machines, in the order of the
/// reads (newest use first): the simulator while it is up, the Android
/// emulator while the copy has one, the screen while it has a display. Each
/// names its machine and opens its own lane there.
func workRemoteToolChips(_ reads: [WorkLaneToolsModel.RemoteRead]) -> [WorkToolChip] {
  var chips: [WorkToolChip] = []
  for read in reads {
    if var chip = appleToolChip(read.apple) {
      chip.remote = read.remote
      chips.append(chip)
    }
    if var chip = androidToolChip(read.android) {
      chip.remote = read.remote
      chips.append(chip)
    }
    if var chip = macDesktopToolChip(read.macDesktop) {
      chip.remote = read.remote
      chips.append(chip)
    }
  }
  return chips
}

/// The simulator chip while the lane's own device is up
/// (`appleDeviceRunningName`), or nil.
func appleToolChip(_ status: AppleDeviceStatus?) -> WorkToolChip? {
  guard let name = appleDeviceRunningName(status) else { return nil }
  return WorkToolChip(kind: .simulator(name: name, family: status?.device?.family))
}

/// The Mac Desktop chip, or nil when the lane has no screen to show. A host
/// that cannot hold a display (`supported: false`) and a lane that has not
/// created one both read as "nothing to open".
func macDesktopToolChip(_ macDesktop: WorkToolsMacDesktopState?) -> WorkToolChip? {
  guard let macDesktop, macDesktop.supported, macDesktop.display != nil else { return nil }
  let stream = macDesktop.stream
  return WorkToolChip(kind: .macDesktop(
    streamLive: stream?.running == true && stream?.idle != true,
    agentDriving: macDesktop.lease?.holder == "agent"
  ), desktopPlatformLabel: macDesktop.linuxDesktop != nil ? "Linux" : (macDesktop.windowsDesktop == nil ? nil : "Windows"))
}

/// The Android chip, or nil when the lane has no emulator to open: no status
/// (the host does not advertise Android), a machine that cannot run it, or a
/// lane with no AVD set up.
func androidToolChip(_ status: AndroidDeviceStatus?) -> WorkToolChip? {
  guard let status, status.unavailable?.isEmpty != false,
        let state = androidDeviceState(status), state != "none"
  else { return nil }
  return WorkToolChip(kind: .android(name: androidDeviceDisplayName(status), live: state == "booted"))
}

/// The SF Symbol for a Windows host's screen: four panes, the shape of the
/// Windows mark the desktop shows (SF Symbols has no Windows logo).
let windowsDesktopSymbolName = "square.grid.2x2.fill"

/// Which Windows seat the lane's screen is: `private` or `shared`. Nil on a Mac
/// host (no `windowsDesktop`) and when the lane has no screen.
///
/// Reads the display's `seatMode`, then the host's, and on an older Windows
/// host that sends neither falls back to the display mode the host itself
/// checks before a viewer's Stop: `virtual` is the private seat.
func windowsDesktopSeat(_ windowsDesktop: WindowsDesktopHostState?, display: WorkToolsMacDesktopDisplay?) -> String? {
  guard let windowsDesktop, let display else { return nil }
  for candidate in [display.seatMode, windowsDesktop.seatMode] {
    if let seat = candidate?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
       seat == "private" || seat == "shared" {
      return seat
    }
  }
  return display.mode == "virtual" ? "private" : "shared"
}

/// The seat in the desktop's words, so nobody mistakes the private screen
/// (the user's own wallpaper and taskbar) for their real one. Nil off Windows.
func windowsDesktopSeatLabel(_ seat: String?) -> String? {
  switch seat {
  case "private": return "Private Windows screen"
  case "shared": return "Using your main Windows desktop"
  default: return nil
  }
}

/// The lane state the chips show after one poll.
///
/// A failed read (nil from a host that advertises the read) keeps the last
/// answer. The Mac can take longer than the phone waits while an agent drives
/// its screen, and dropping the state then hid the macOS chip for a display
/// that was up the whole time. A host that does not advertise the read has no
/// state at all.
func workToolsStateAfterRead(
  fetched: WorkToolsLaneState?,
  previous: WorkToolsLaneState?,
  supported: Bool
) -> WorkToolsLaneState? {
  guard supported else { return nil }
  return fetched ?? previous
}

/// "Browser" with no tabs, "1 tab", "N tabs".
func workBrowserChipLabel(tabCount: Int) -> String {
  switch tabCount {
  case ...0: return "Browser"
  case 1: return "1 tab"
  default: return "\(tabCount) tabs"
  }
}

/// Whether a chat in this lane is driving the browser right now. Derived on the
/// Mac from the browser commands themselves, and it expires on its own — so a
/// chip that stops seeing it simply stops showing it.
func workToolsAgentIsUsingBrowser(_ state: WorkToolsLaneState?) -> Bool {
  !(state?.agentBrowserPresence ?? []).isEmpty
}

/// A device name without its leading family word: "iPhone 16 Pro" -> "16 Pro",
/// "iPad Air (M2)" -> "Air (M2)". A name that is only the family word, or that
/// does not start with one, stays as it is.
func appleDeviceChipModelName(_ name: String) -> String {
  for family in ["iPhone", "iPad"] {
    guard name.count > family.count,
          name.prefix(family.count).caseInsensitiveCompare(family) == .orderedSame
    else { continue }
    let rest = name.dropFirst(family.count)
    guard rest.first == " " else { continue }
    let model = rest.trimmingCharacters(in: .whitespaces)
    return model.isEmpty ? name : model
  }
  return name
}

/// The lane's device name while it is up ("iPhone 16 Pro"), nil otherwise.
///
/// The lane's means `laneDevice` names the same udid as `device`: for a lane
/// with no device the host reports any booted iPhone on the Mac, which is not
/// this lane's to show. Up means simctl reports it `Booted`, or the host is
/// streaming it. A device the lane keeps after Shut down carries its own
/// `state` ("Shutdown"), and a status with no device state at all is not
/// evidence the device is on, so both read as off. The host fills a missing
/// name with the udid; that is not a name, so the family ("iPhone") stands in.
func appleDeviceRunningName(_ status: AppleDeviceStatus?) -> String? {
  guard appleStatusShowsLaneDevice(status), let device = status?.device, let udid = device.udid else { return nil }
  let booted = device.state?.caseInsensitiveCompare("Booted") == .orderedSame
  guard booted || status?.stream?.running == true else { return nil }
  let name = device.name?.trimmingCharacters(in: .whitespacesAndNewlines)
  let usableName = (name?.isEmpty == false && name != udid) ? name : nil
  return usableName ?? appleDeviceFamilyLabel(device.family) ?? "Simulator"
}

// MARK: - Model

/// Reads the lane's tool state for the chat's badge row.
///
/// The Work tools pane — browser, App Control, the Apple device — runs on the
/// Mac. The phone can watch the device and read the rest, so the chat shows a
/// chip for each of those that exists right now. The Mac's state is not
/// table-backed, so this polls: one loop per chat, every 10 s, cancelled with
/// the chat's `.task`.
///
/// Only the derived chips are published. `apple.status` carries fps and
/// bitrate, which change on every read while a stream runs; publishing the raw
/// status would re-render the whole chat every tick for numbers no chip shows.
@MainActor
final class WorkLaneToolsModel: ObservableObject {
  /// Deliberately much slower than `WorkToolsSheet`'s 3 s: that is a surface
  /// the user opened to watch, whereas these chips sit behind every chat.
  static let refreshInterval: Duration = .seconds(10)
  /// How long one read of another machine's device may take before its pill
  /// keeps the last answer. Shorter than the command's own timeout: a machine
  /// that is slow or gone must not hold the others' pills back for long.
  static let remoteReadTimeoutNanoseconds: UInt64 = 5_000_000_000

  /// The surface a chip opened.
  enum Surface: Equatable {
    case appleDevice
    case androidDevice
    case macDesktop
    /// A sheet for one tool.
    case toolSheet(WorkToolsSheet.Tool)
    /// Live App Control frames, when the host is streaming.
    case appControl
    /// A device the chat drives on another machine (`WorkToolChip.remote`).
    case remote(WorkToolChip)
  }

  /// One poll of a work copy's devices on another machine.
  struct RemoteRead: Equatable {
    let remote: WorkToolChipRemote
    var apple: AppleDeviceStatus?
    var android: AndroidDeviceStatus?
    var macDesktop: WorkToolsMacDesktopState?
  }

  @Published private(set) var chips: [WorkToolChip] = []
  @Published var presented: Surface?
  /// Handed to `AppleDeviceViewer` as its first frame of state. Not published.
  private(set) var appleStatus: AppleDeviceStatus?
  /// Handed to `AndroidDeviceViewer` the same way. Not published.
  private(set) var androidStatus: AndroidDeviceStatus?
  /// Handed to `MacDesktopViewer` the same way. Not published.
  private(set) var macDesktopState: WorkToolsMacDesktopState?
  /// Handed to `AppControlViewer` the same way. Not published.
  private(set) var appControlState: WorkToolsAppControlState?
  /// The host streams App Control frames, read at the last refresh. `open`
  /// has no sync service, so the chip's target is decided from this.
  private(set) var appControlStream = false
  /// The last lane state the Mac answered with. A read that fails or times
  /// out keeps it, so one slow reply does not blank every chip.
  private var lastTools: WorkToolsLaneState?
  /// The chat's work copies on other machines whose devices it drives.
  private var remoteDevices: [WorkRemoteWorkDevice] = []
  /// The last read of each of those, by namespaced lane id: the seed of a
  /// remote chip's viewer. Not published.
  private(set) var remoteReads: [String: RemoteRead] = [:]
  /// The namespaced lanes this round reads, newest use first: the order of
  /// their pills.
  private var remoteOrder: [String] = []
  /// The lane's own chips from its last read.
  private var localChips: [WorkToolChip] = []

  /// True while a tool sheet or a live stream is up (a stream lives on the
  /// stage, not in `presented`). Both poll the same reads faster and are the
  /// authoritative view, so a tick here would be a duplicate RPC for chips
  /// nobody can see. The next tick after dismissal catches up.
  var paused: Bool { presented != nil || LiveStage.shared.session != nil }

  /// `macDesktopStream`: the host can stream the lane's screen. A host
  /// without the live stream can still describe the screen, so the sheet shows
  /// its last still in the macOS sheet instead of a viewer that could only fail.
  func open(_ chip: WorkToolChip, macDesktopStream: Bool) {
    // Another machine's device always goes on the live stage, on every
    // layout: the tools pane and its sheets show the lane's own tools.
    if chip.remote != nil {
      presented = .remote(chip)
      return
    }
    switch chip.kind {
    case .simulator: presented = .appleDevice
    case .android: presented = .androidDevice
    case .macDesktop: presented = macDesktopStream ? .macDesktop : .toolSheet(.macDesktop)
    case .browser: presented = .toolSheet(.browser)
    case .appControl: presented = appControlStream ? .appControl : .toolSheet(.appControl)
    }
  }

  func isPresented(_ surface: Surface) -> Binding<Bool> {
    Binding(
      get: { self.presented == surface },
      set: { if !$0, self.presented == surface { self.presented = nil } }
    )
  }

  /// The live-stage seed of a remote chip, from its last read. Nil for a
  /// chip with nothing to open on the stage.
  func remoteSeed(for chip: WorkToolChip) -> LiveStage.Seed? {
    guard let remote = chip.remote else { return nil }
    let read = remoteReads[remote.laneId]
    switch chip.kind {
    case .simulator: return .simulator(read?.apple)
    case .android: return .android(read?.android)
    case .macDesktop: return .macDesktop(read?.macDesktop)
    case .browser, .appControl: return nil
    }
  }

  func run(laneId: String, remoteDevices: [WorkRemoteWorkDevice] = [], syncService: SyncService) async {
    chips = []
    appleStatus = nil
    androidStatus = nil
    macDesktopState = nil
    appControlState = nil
    lastTools = nil
    remoteReads = [:]
    remoteOrder = []
    localChips = []
    self.remoteDevices = remoteDevices
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    await refresh(laneId: trimmed, syncService: syncService)
    while !Task.isCancelled {
      try? await Task.sleep(for: Self.refreshInterval)
      guard !Task.isCancelled else { return }
      guard !paused else { continue }
      await refresh(laneId: trimmed, syncService: syncService)
    }
  }

  /// All reads at once, each gated on its own action: a Mac with the pane
  /// state but no Apple or Android support keeps the chips it always could
  /// show, and no read goes on the wire unadvertised. The lane's own chips
  /// publish as soon as its reads answer; another machine's publish as each
  /// of its reads does, so an unreachable machine holds back nothing.
  func refresh(laneId: String, syncService: SyncService) async {
    let readTools = syncService.supportsWorkToolsState(laneId: laneId)
    // Asked of the lane's own machine: a lane on another Mac answers there.
    let readApple = syncService.supportsAppleDeviceStatus(laneId: laneId)
    // Android is offered only where the host can also mint a stream ticket.
    let readAndroid = syncService.supportsAndroidDevice(laneId: laneId)
    async let remoteDone: Void = refreshRemoteDevices(syncService: syncService)
    async let nextState: WorkToolsLaneState? = readTools
      ? (try? await syncService.fetchWorkToolsLaneState(laneId: laneId))
      : nil
    async let nextApple: AppleDeviceStatus? = readApple
      ? (try? await syncService.fetchAppleDeviceStatus(laneId: laneId))
      : nil
    async let nextAndroid: AndroidDeviceStatus? = readAndroid
      ? (try? await syncService.fetchAndroidDeviceStatus(laneId: laneId))
      : nil
    let (fetched, apple, android) = await (nextState, nextApple, nextAndroid)
    if !Task.isCancelled {
      let tools = workToolsStateAfterRead(fetched: fetched, previous: lastTools, supported: readTools)
      lastTools = tools
      appleStatus = apple
      androidStatus = android
      macDesktopState = tools?.macDesktop
      appControlState = tools?.appControl
      appControlStream = syncService.supportsAppControlStream
      localChips = workToolChips(state: tools, appleDevice: apple, android: android)
      publishChips()
    }
    await remoteDone
  }

  /// The lane's own chips, then the other machines' in the order of the
  /// chat's use. Publishes only when the set changes.
  private func publishChips() {
    let next = localChips + workRemoteToolChips(remoteOrder.compactMap { remoteReads[$0] })
    if next != chips { chips = next }
  }

  /// Each work copy's devices on its machine, read there, all machines at
  /// once. A machine the phone cannot reach (`registerRemoteWorkCopyLane`
  /// nil), or one that does not advertise a read, gets no read and so no chip.
  /// A failed or slow read keeps the last answer, as the lane's own chips do.
  /// Only the devices the chat drove are read.
  private func refreshRemoteDevices(syncService: SyncService) async {
    var order: [String] = []
    var targets: [(device: WorkRemoteWorkDevice, laneId: String)] = []
    for device in remoteDevices {
      guard let laneId = syncService.registerRemoteWorkCopyLane(device), !order.contains(laneId) else { continue }
      order.append(laneId)
      targets.append((device, laneId))
    }
    guard !Task.isCancelled else { return }
    // A machine the phone can no longer reach loses its pill now.
    remoteOrder = order
    remoteReads = remoteReads.filter { order.contains($0.key) }
    publishChips()
    await withTaskGroup(of: RemoteRead.self) { group in
      for target in targets {
        let previous = remoteReads[target.laneId]
        group.addTask { @MainActor in
          await Self.readRemoteDevice(target.device, laneId: target.laneId, previous: previous, syncService: syncService)
        }
      }
      for await read in group {
        guard !Task.isCancelled else { continue }
        remoteReads[read.remote.laneId] = read
        publishChips()
      }
    }
  }

  /// One work copy's devices, each read at once and each bounded by
  /// `remoteReadTimeoutNanoseconds`.
  private static func readRemoteDevice(
    _ device: WorkRemoteWorkDevice,
    laneId: String,
    previous: RemoteRead?,
    syncService: SyncService
  ) async -> RemoteRead {
    let readApple = device.simulator && syncService.supportsAppleDeviceStatus(laneId: laneId)
    let readAndroid = device.android && syncService.supportsAndroidDevice(laneId: laneId)
    // The screen opens only on the live stage, so it needs the stream there.
    let readDesktop = device.desktop && syncService.supportsWorkToolsState(laneId: laneId)
      && syncService.supportsMacDesktopStream(laneId: laneId)
    async let apple: AppleDeviceStatus? = readApple
      ? await boundedRemoteRead({ try? await syncService.fetchAppleDeviceStatus(laneId: laneId) })
      : nil
    async let android: AndroidDeviceStatus? = readAndroid
      ? await boundedRemoteRead({ try? await syncService.fetchAndroidDeviceStatus(laneId: laneId) })
      : nil
    async let desktop: WorkToolsMacDesktopState? = readDesktop
      ? await boundedRemoteRead({ (try? await syncService.fetchWorkToolsLaneState(laneId: laneId))?.macDesktop })
      : nil
    var read = RemoteRead(remote: WorkToolChipRemote(laneId: laneId, machineName: device.machineName))
    let (appleRead, androidRead, desktopRead) = await (apple, android, desktop)
    if readApple { read.apple = appleRead ?? previous?.apple }
    if readAndroid { read.android = androidRead ?? previous?.android }
    if readDesktop { read.macDesktop = desktopRead ?? previous?.macDesktop }
    return read
  }

  /// `work`'s answer, or nil once `remoteReadTimeoutNanoseconds` pass first.
  private static func boundedRemoteRead<T>(_ work: @escaping @MainActor () async -> T?) async -> T? {
    let answer: T?? = await workAwaitWithDeadline(timeoutNanoseconds: remoteReadTimeoutNanoseconds, work: work)
    return answer ?? nil
  }

  #if DEBUG
  /// Fixture seam for previews and simulator screenshots.
  func installPreview(
    state: WorkToolsLaneState?,
    appleStatus: AppleDeviceStatus?,
    androidStatus: AndroidDeviceStatus? = nil
  ) {
    self.appleStatus = appleStatus
    self.androidStatus = androidStatus
    macDesktopState = state?.macDesktop
    appControlState = state?.appControl
    // The fixture's app streams from a drawn stand-in, as a streaming host's would.
    appControlStream = state?.appControl != nil
    localChips = workToolChips(state: state, appleDevice: appleStatus, android: androidStatus)
    publishChips()
  }
  #endif
}

#if DEBUG
/// What a preview installs into `WorkLaneToolsModel` in place of the poll.
struct WorkLaneToolsPreview {
  var state: WorkToolsLaneState?
  var appleStatus: AppleDeviceStatus?
  var androidStatus: AndroidDeviceStatus?
}
#endif

/// What restarts the chips' poll: another lane, or another set of devices on
/// other machines.
struct WorkLaneToolsTaskKey: Equatable {
  let laneId: String
  let remoteDevices: [WorkRemoteWorkDevice]
}

/// The lane tool chips, handed up from the chat view (which owns their poll)
/// to the destination around it, whose header lists the same tools. Publishes
/// only when the chip set changes.
@MainActor
final class WorkChatToolsRelay: ObservableObject {
  @Published private(set) var chips: [WorkToolChip] = []
  /// Opens a chip's tool exactly as tapping the chip does (phone layout).
  var openChip: ((WorkToolChip) -> Void)?

  func publish(_ next: [WorkToolChip]) {
    if chips != next { chips = next }
  }

  func open(_ chip: WorkToolChip) {
    openChip?(chip)
  }
}

/// The chips' poll and the surfaces they open, on the chat view.
struct WorkLaneToolsPresenter: ViewModifier {
  @ObservedObject var model: WorkLaneToolsModel
  let laneId: String
  /// The chat the chips sit in. A device that chat claimed is still its own to
  /// drive from the viewer, as it is from the desktop's pane in that chat.
  var chatSessionId: String?
  /// False for a personal chat, which has no lane.
  let enabled: Bool
  /// The chat's work copies on other machines whose devices it drives
  /// (`workRemoteWorkDevices`). Their chips follow the lane's own.
  var remoteDevices: [WorkRemoteWorkDevice] = []
  /// The wide display's tools column. While the chips poll, it publishes which
  /// tool tabs exist; the chip tap opens the pane instead of a cover.
  var duoPane: DuoWorkPaneModel?
  /// The chat's header (its ⋯ Tools menu, the Duo's Tools button) lists the
  /// same tools the chips show and opens them the way a chip tap does.
  var relay: WorkChatToolsRelay?
  #if DEBUG
  var preview: WorkLaneToolsPreview?
  #endif
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  func body(content: Content) -> some View {
    content
      .task(id: WorkLaneToolsTaskKey(laneId: laneId, remoteDevices: remoteDevices)) {
        #if DEBUG
        if let preview {
          model.installPreview(state: preview.state, appleStatus: preview.appleStatus, androidStatus: preview.androidStatus)
          return
        }
        #endif
        guard enabled else { return }
        await model.run(laneId: laneId, remoteDevices: remoteDevices, syncService: syncService)
      }
      // Which tools exist is the same answer the chips give; the pane only
      // needs the identities, and this fires only when the chip set changes.
      .onAppear {
        var macDesktopStream = syncService.supportsMacDesktopStream(laneId: laneId)
        #if DEBUG
        // A fixture chat's lane screen streams from a drawn stand-in.
        if preview != nil || WorkRootPreviewFixture.active != nil { macDesktopStream = true }
        #endif
        relay?.openChip = { [weak model = self.model] chip in
          model?.open(chip, macDesktopStream: macDesktopStream)
        }
      }
      .onChange(of: model.chips, initial: true) { _, allChips in
        // The Tools menus and the pane list the lane's own tools by tab; a
        // device on another machine is a pill only (it opens on the stage).
        let chips = allChips.filter { $0.remote == nil }
        relay?.publish(chips)
        var seed = DuoToolSeed(
          appleStatus: model.appleStatus,
          macDesktop: model.macDesktopState,
          appControl: model.appControlState,
          appControlStream: model.appControlStream,
          macDesktopStream: syncService.supportsMacDesktopStream(laneId: laneId),
          androidStatus: model.androidStatus
        )
        #if DEBUG
        // A fixture chat's screens stream from a drawn stand-in, so they open
        // on the stage as a streaming host's would.
        if preview != nil {
          seed.macDesktopStream = true
          seed.appControlStream = true
        }
        #endif
        duoPane?.setToolTabs(chips.map(\.duoToolTab), seed: seed)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.browser))) {
        toolSheet(.browser)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.appControl))) {
        toolSheet(.appControl)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.macDesktop))) {
        toolSheet(.macDesktop)
      }
      // A live stream (the simulator, the Android emulator, the lane's
      // screen, App Control frames) goes on stage, full screen over the whole app, seeded with the last
      // state so the first frame is not an empty viewer. The stage outlives
      // this chat's layout, so folding the phone keeps it.
      .onChange(of: model.presented) { _, surface in
        // A device on another machine: its own lane (namespaced to that
        // machine), so the viewer streams and drives it there.
        if case .remote(let chip)? = surface {
          model.presented = nil
          guard let remote = chip.remote, let seed = model.remoteSeed(for: chip) else { return }
          LiveStage.shared.open(
            seed,
            laneId: remote.laneId,
            chatSessionId: chatSessionId,
            fromPane: false,
            onClose: nil,
            preview: nil
          )
          return
        }
        let seed: LiveStage.Seed
        switch surface {
        case .appleDevice: seed = .simulator(model.appleStatus)
        case .androidDevice: seed = .android(model.androidStatus)
        case .macDesktop: seed = .macDesktop(model.macDesktopState)
        case .appControl: seed = .appControl(model.appControlState)
        case .toolSheet, .remote, nil: return
        }
        model.presented = nil
        var stagePreview: LiveStagePreview?
        #if DEBUG
        // A fixture chat streams each viewer's drawn stand-in, as its pane does.
        if preview != nil || WorkRootPreviewFixture.active != nil {
          stagePreview = WorkSessionDestinationView.liveStagePreview(seed.kind)
        }
        #endif
        LiveStage.shared.open(
          seed,
          laneId: laneId,
          chatSessionId: chatSessionId,
          fromPane: false,
          onClose: nil,
          preview: stagePreview
        )
      }
  }

  private func toolSheet(_ tool: WorkToolsSheet.Tool) -> some View {
    WorkToolsSheet(laneId: laneId, tool: tool)
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
  }
}

// MARK: - Chip view

/// One lane tool chip in the chat's badge row. Same capsule as the PR and chat
/// info chips (`WorkComposerBadgeCapsule`), so the row reads as one set.
struct WorkLaneToolChipView: View {
  let chip: WorkToolChip
  /// Nil on the phone; on a wide display, whether the pane shows this tool.
  var isSelected: Bool? = nil
  let onOpen: () -> Void

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: tint,
      spacing: 6,
      accessibilityLabel: accessibilityText,
      selection: isSelected,
      onOpen: onOpen
    ) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
      Text(chip.displayLabel)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
      if showsLiveDot {
        // The device is up, or the desktop is streaming: a small live dot.
        Circle()
          .fill(ADEColor.success)
          .frame(width: 6, height: 6)
          .accessibilityHidden(true)
      }
    }
  }

  private var symbol: String { chip.symbolName }

  private var showsLiveDot: Bool {
    switch chip.kind {
    case .simulator: return true
    case .macDesktop(let streamLive, _): return streamLive
    case .appControl(_, let live): return live
    case .android(_, let live): return live
    case .browser: return false
    }
  }

  /// Neutral by default; the browser and Mac Desktop chips take the accent
  /// while an agent is driving them, which is the signal the old Tools row
  /// carried as a globe.
  private var tint: Color {
    switch chip.kind {
    case .browser(_, agentUsing: true), .macDesktop(_, agentDriving: true): return ADEColor.accent
    default: return ADEColor.textSecondary
    }
  }

  private var accessibilityText: String { workToolChipAccessibilityText(chip) }
}

/// What VoiceOver reads for a chip.
func workToolChipAccessibilityText(_ chip: WorkToolChip) -> String {
  if let remote = chip.remote {
    let machine = remote.machineName.isEmpty ? "another computer" : remote.machineName
    switch chip.kind {
    case .simulator: return "\(chip.label) running on \(machine) for this chat. Tap to watch."
    case .android: return "\(chip.label), Android emulator on \(machine) for this chat. Tap to watch."
    case .macDesktop: return "The desktop this chat drives on \(machine). Tap to watch."
    case .browser, .appControl: return "\(chip.label) on \(machine). Tap to watch."
    }
  }
  switch chip.kind {
  case .simulator:
    return "\(chip.label) running on your Mac. Tap to watch."
  case .browser(let tabCount, let agentUsing):
    let base = tabCount > 0 ? "Browser on your Mac, \(chip.label)" : "Browser on your Mac"
    return agentUsing
      ? "\(base). An agent is using the browser. Tap for details."
      : "\(base). Tap for details."
  case .appControl(_, let live):
    return live
      ? "\(chip.label) on your Mac, live. Tap to watch."
      : "\(chip.label) on your Mac. Tap for details."
  case .macDesktop(let streamLive, let agentDriving):
    var text = chip.desktopPlatformLabel == "Windows" ? "This lane's Windows desktop" : "This lane's macOS desktop"
    if streamLive { text += ", live" }
    if agentDriving { text += ". An agent is driving it" }
    return text + ". Tap to watch."
  case .android(_, let live):
    return live
      ? "\(chip.label), Android emulator, running. Tap to watch."
      : "\(chip.label), Android emulator, not running. Tap to open it."
  }
}
