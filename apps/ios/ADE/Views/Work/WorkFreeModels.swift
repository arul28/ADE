import Foundation
import SwiftUI

/// Free models: models a person can chat with without any paid plan, account
/// or key. The picker's Free page lists them, a machine with nothing signed in
/// starts new chats on one, and a new person's sign-in card offers them.
///
/// Mirrors `apps/desktop/src/shared/freeModels.ts` (the rule, badges, sources
/// and `pickFreeDefaultModelId`); keep the two together. Today there is one
/// source, OpenCode Zen's free tier, served only to OpenCode. Rows carry a
/// source and a badge so another source (an ad-supported one) adds rows, and a
/// tab on the Free page, without changing the page.

// MARK: - The rule

/// The tag a Free page row shows.
enum WorkFreeModelBadge: String, Equatable {
  case free
  case adSupported = "ad-supported"

  var label: String {
    switch self {
    case .free: return "Free"
    case .adSupported: return "Ad-supported"
    }
  }
}

/// One model's place on the Free page.
struct WorkFreeModelEntry: Equatable {
  /// Where the model comes from; each source is one group (tab) on the page.
  let source: String
  let badge: WorkFreeModelBadge
}

private let workFreeModelSourceLabels: [String: String] = [
  "opencode-zen": "OpenCode Zen",
]

func workFreeModelSourceLabel(_ source: String) -> String {
  workFreeModelSourceLabels[source] ?? source
}

/// OpenCode Zen's free models that do not end in `-free`
/// (`OPENCODE_ZEN_FREE_TIER_IDS` in `shared/harnessRoutes.ts`).
private let workOpenCodeZenFreeTierIds: Set<String> = ["big-pickle"]

/// The Free page row for a model id (`opencode/<provider>/<model>`), or nil
/// when the model is not free.
func workFreeModelEntry(modelId: String) -> WorkFreeModelEntry? {
  let id = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  let prefix = "opencode/"
  guard id.lowercased().hasPrefix(prefix) else { return nil }
  let rest = id.dropFirst(prefix.count)
  guard let slash = rest.firstIndex(of: "/"), slash > rest.startIndex else { return nil }
  let provider = rest[..<slash].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let model = rest[rest.index(after: slash)...].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard provider == "opencode", !model.isEmpty else { return nil }
  guard model.hasSuffix("-free") || workOpenCodeZenFreeTierIds.contains(model) else { return nil }
  return WorkFreeModelEntry(source: "opencode-zen", badge: .free)
}

func workIsFreeModel(_ modelId: String) -> Bool {
  workFreeModelEntry(modelId: modelId) != nil
}

/// The free model a new chat starts on when nothing is signed in: the first
/// of `preferred` that is listed now, else the first listed free model.
func workPickFreeDefaultModelId(freeModelIds: [String], preferred: [String]) -> String? {
  for id in preferred where freeModelIds.contains(id) { return id }
  return freeModelIds.first
}

/// Search finds a free model by its badge ("free") and its source ("zen").
func workFreeModelMatchesSearch(_ modelId: String, needle: String) -> Bool {
  guard !needle.isEmpty, let entry = workFreeModelEntry(modelId: modelId) else { return false }
  return entry.badge.label.lowercased().contains(needle)
    || workFreeModelSourceLabel(entry.source).lowercased().contains(needle)
}

/// One source's free models, in catalog order.
struct WorkFreeModelGroup: Identifiable, Equatable {
  var id: String { source }
  let source: String
  let label: String
  let models: [WorkModelOption]
}

/// Every free model in the catalog, grouped by source in first-seen order.
func workFreeModelGroups(_ catalog: [WorkModelCatalogGroup]) -> [WorkFreeModelGroup] {
  var order: [String] = []
  var bySource: [String: [WorkModelOption]] = [:]
  var seen = Set<String>()
  for group in catalog {
    for provider in group.providers {
      for model in provider.models {
        guard let entry = workFreeModelEntry(modelId: model.id), seen.insert(model.id).inserted else { continue }
        if bySource[entry.source] == nil { order.append(entry.source) }
        bySource[entry.source, default: []].append(model)
      }
    }
  }
  return order.map { WorkFreeModelGroup(source: $0, label: workFreeModelSourceLabel($0), models: bySource[$0] ?? []) }
}

/// The free model ids a host catalog lists that the machine can run now.
func workFreeModelIds(in catalog: AgentChatModelCatalog) -> [String] {
  var ids: [String] = []
  for group in catalog.groups {
    for provider in group.providers {
      for subsection in provider.subsections {
        for model in subsection.models where model.isAvailable && workIsFreeModel(model.id) && !ids.contains(model.id) {
          ids.append(model.id)
        }
      }
    }
  }
  return ids
}

// MARK: - The machine's answer

/// The `freeModels` block of a machine's `ai.getStatus`
/// (`AiFreeModelsStatus` in `shared/types/config.ts`).
struct WorkFreeModelsStatus: Equatable {
  /// Nothing on the machine can chat except free models.
  let nothingSignedIn: Bool
  /// A provider was signed in there at some point, or an agent ran there.
  let everSignedIn: Bool
  let preferredDefaultModelIds: [String]

  /// A brand-new person: their sign-in card offers free models.
  var isNewPerson: Bool { nothingSignedIn && !everSignedIn }

  init(nothingSignedIn: Bool, everSignedIn: Bool, preferredDefaultModelIds: [String]) {
    self.nothingSignedIn = nothingSignedIn
    self.everSignedIn = everSignedIn
    self.preferredDefaultModelIds = preferredDefaultModelIds
  }

  /// Nil when the block is missing: an older machine, read as "someone is
  /// signed in", so the phone behaves exactly as before.
  init?(aiStatus: Any) {
    guard let block = (aiStatus as? [String: Any])?["freeModels"] as? [String: Any],
          let nothingSignedIn = block["nothingSignedIn"] as? Bool else { return nil }
    self.nothingSignedIn = nothingSignedIn
    self.everSignedIn = block["everSignedIn"] as? Bool ?? true
    self.preferredDefaultModelIds = (block["preferredDefaultModelIds"] as? [String]) ?? []
  }
}

/// One read of each machine's free-models status, shared by the picker, the
/// New Chat page and the sign-in card, so opening them does not ask the
/// machine again. Keyed by the machine, never by the tab.
@MainActor
final class WorkFreeModelsStatusStore {
  static let shared = WorkFreeModelsStatusStore()

  private struct Entry {
    let status: WorkFreeModelsStatus?
    let at: Date
  }

  private var entries: [String: Entry] = [:]
  private var inFlight: [String: Task<WorkFreeModelsStatus?, Never>] = [:]
  private let ttl: TimeInterval = 60

  #if DEBUG
  /// Fixture screens: every machine answers with this status and free list.
  private(set) var previewPin: (status: WorkFreeModelsStatus, freeModelIds: [String])?

  func pinPreview(status: WorkFreeModelsStatus, freeModelIds: [String]) {
    previewPin = (status, freeModelIds)
  }
  #endif

  /// The machine behind a host: the connection object and the machine it
  /// talks to (the primary connection can move to another machine).
  static func key(for host: ProviderAccountsHost) -> String {
    let machine: String
    if let sync = host as? SyncService {
      machine = sync.focusedMachineKey ?? "focused"
    } else if let connection = host as? MachineConnection {
      machine = connection.machineKey
    } else {
      machine = ""
    }
    return "\(ObjectIdentifier(host).hashValue):\(machine)"
  }

  func cachedStatus(for host: ProviderAccountsHost) -> WorkFreeModelsStatus? {
    guard let entry = entries[Self.key(for: host)], Date().timeIntervalSince(entry.at) < ttl else { return nil }
    return entry.status
  }

  /// Keeps the block of an `ai.getStatus` answer read for another reason.
  func record(aiStatus: Any, for host: ProviderAccountsHost) {
    entries[Self.key(for: host)] = Entry(status: WorkFreeModelsStatus(aiStatus: aiStatus), at: Date())
  }

  /// The machine's status, or nil for an older machine or a failed read
  /// (both mean "behave as before").
  func status(for host: ProviderAccountsHost) async -> WorkFreeModelsStatus? {
    #if DEBUG
    if let previewPin { return previewPin.status }
    #endif
    let key = Self.key(for: host)
    if let entry = entries[key], Date().timeIntervalSince(entry.at) < ttl { return entry.status }
    guard host.providerAccountsConnected, host.supportsProviderAccountsAction("ai.getStatus") else { return nil }
    if let task = inFlight[key] { return await task.value }
    let task = Task { @MainActor () -> WorkFreeModelsStatus? in
      guard let raw = try? await host.runProviderAccountsCommand("ai.getStatus", args: [:]) else { return nil }
      return WorkFreeModelsStatus(aiStatus: raw)
    }
    inFlight[key] = task
    let status = await task.value
    inFlight[key] = nil
    entries[key] = Entry(status: status, at: Date())
    return status
  }
}

/// The free models the machine behind `host` lists now. The primary
/// connection reads its project catalog; another machine its machine-wide one.
@MainActor
func workFreeModelIds(on host: ProviderAccountsHost) async -> [String] {
  #if DEBUG
  if let pin = WorkFreeModelsStatusStore.shared.previewPin { return pin.freeModelIds }
  #endif
  if let sync = host as? SyncService {
    if let catalog = try? await sync.getChatModelCatalog(mode: "cached") {
      let ids = workFreeModelIds(in: catalog)
      if !ids.isEmpty { return ids }
    }
    guard let fresh = try? await sync.getChatModelCatalog(mode: "refresh-stale", refreshProvider: "opencode") else { return [] }
    return workFreeModelIds(in: fresh)
  }
  let action = "personalChats.modelCatalog"
  guard host.providerAccountsConnected, host.supportsProviderAccountsAction(action) else { return [] }
  func read(_ args: [String: Any]) async -> [String] {
    guard let raw = try? await host.runProviderAccountsCommand(action, args: args),
          let data = try? JSONSerialization.data(withJSONObject: raw),
          let catalog = try? JSONDecoder().decode(AgentChatModelCatalog.self, from: data) else { return [] }
    return workFreeModelIds(in: catalog)
  }
  let cached = await read(["mode": "cached"])
  if !cached.isEmpty { return cached }
  return await read(["mode": "refresh-stale", "refreshProvider": "opencode"])
}

/// The free model a new chat or a new person's card switches to on the
/// machine behind `host`, or nil when it has none to offer.
@MainActor
func workFreeDefaultModelId(on host: ProviderAccountsHost, status: WorkFreeModelsStatus) async -> String? {
  workPickFreeDefaultModelId(freeModelIds: await workFreeModelIds(on: host), preferred: status.preferredDefaultModelIds)
}

// MARK: - Getting OpenCode on the machine

/// The machine's pinned OpenCode (`PinnedProviderToolStatus`), the fields the
/// Free page reads.
struct WorkPinnedToolStatus: Decodable, Equatable {
  var state: String
  var downloading: Bool?
  var receivedBytes: Double?
  var totalBytes: Double?
  var failureReason: String?
  var message: String?
  var fetchAllowed: Bool?
}

/// The Free page's setup when the chat's machine has no free models yet:
/// downloads OpenCode there (`ai.pinnedToolDownload`) and reads its progress
/// (`ai.pinnedToolStatus`) about once a second, only while it downloads.
@MainActor
final class WorkFreeModelsSetup: ObservableObject {
  enum Phase: Equatable {
    /// Not read yet.
    case idle
    case checking
    /// OpenCode is not on the machine; the page offers to get it.
    case needsDownload
    case downloading(received: Double?, total: Double?)
    /// OpenCode is there; the catalog is reading its models.
    case ready
    case failed(String)
    /// The machine cannot run it, or will not download it.
    case unavailable(String)
    /// The machine's ADE cannot download it from the phone.
    case unsupported
  }

  @Published private(set) var phase: Phase = .idle
  private var pollTask: Task<Void, Never>?
  private var attempt = 0
  private static let args: [String: Any] = ["provider": "opencode"]

  static func canCheck(_ host: ProviderAccountsHost?) -> Bool {
    guard let host else { return false }
    return host.providerAccountsConnected && host.supportsProviderAccountsAction("ai.pinnedToolStatus")
  }

  /// Reads where OpenCode stands on the machine, once. A download already
  /// running (the machine starts one for a new person) shows its progress.
  func check(host: ProviderAccountsHost?, onReady: @escaping @MainActor () async -> Void) async {
    guard let host, Self.canCheck(host) else {
      phase = .unsupported
      return
    }
    if case .downloading = phase { return }
    attempt += 1
    let current = attempt
    phase = .checking
    do {
      let status = try await read("ai.pinnedToolStatus", host: host)
      guard current == attempt else { return }
      await apply(status, host: host, attempt: current, onReady: onReady)
    } catch {
      guard current == attempt else { return }
      phase = .needsDownload
    }
  }

  func start(host: ProviderAccountsHost?, onReady: @escaping @MainActor () async -> Void) async {
    guard let host, host.supportsProviderAccountsAction("ai.pinnedToolDownload") else {
      phase = .unsupported
      return
    }
    attempt += 1
    let current = attempt
    phase = .downloading(received: nil, total: nil)
    do {
      let status = try await read("ai.pinnedToolDownload", host: host)
      guard current == attempt else { return }
      await apply(status, host: host, attempt: current, onReady: onReady)
    } catch {
      guard current == attempt else { return }
      phase = .failed(error.localizedDescription)
    }
  }

  func stop() {
    attempt += 1
    pollTask?.cancel()
    pollTask = nil
    if case .downloading = phase { phase = .idle }
  }

  private func read(_ action: String, host: ProviderAccountsHost) async throws -> WorkPinnedToolStatus {
    let raw = try await host.runProviderAccountsCommand(action, args: Self.args)
    let data = try JSONSerialization.data(withJSONObject: raw)
    return try JSONDecoder().decode(WorkPinnedToolStatus.self, from: data)
  }

  private func apply(
    _ status: WorkPinnedToolStatus,
    host: ProviderAccountsHost,
    attempt current: Int,
    onReady: @escaping @MainActor () async -> Void
  ) async {
    switch status.state {
    case "ready" where status.downloading != true:
      pollTask?.cancel()
      pollTask = nil
      phase = .ready
      await onReady()
    case "ready", "downloading":
      phase = .downloading(received: status.receivedBytes, total: status.totalBytes)
      schedulePoll(host: host, attempt: current, onReady: onReady)
    case "failed":
      phase = .failed(status.failureReason ?? status.message ?? "The download failed.")
    case "unavailable":
      phase = .unavailable(status.message ?? "Free models can't run on this computer.")
    default:
      phase = status.fetchAllowed == false
        ? .unavailable("Downloads are turned off on this computer.")
        : .needsDownload
    }
  }

  private func schedulePoll(host: ProviderAccountsHost, attempt current: Int, onReady: @escaping @MainActor () async -> Void) {
    guard pollTask == nil else { return }
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        guard let self, !Task.isCancelled, current == self.attempt else { return }
        guard case .downloading = self.phase else { self.pollTask = nil; return }
        do {
          let status = try await self.read("ai.pinnedToolStatus", host: host)
          guard current == self.attempt else { return }
          if status.state == "downloading" || (status.state == "ready" && status.downloading == true) {
            self.phase = .downloading(received: status.receivedBytes, total: status.totalBytes)
            continue
          }
          // Done, failed or gone: one last apply, and the poll ends.
          self.pollTask = nil
          await self.apply(status, host: host, attempt: current, onReady: onReady)
          return
        } catch {
          guard current == self.attempt else { return }
          self.pollTask = nil
          self.phase = .failed(error.localizedDescription)
          return
        }
      }
    }
  }
}

// MARK: - Views

/// The small tag beside a free model's name, wherever the model shows.
struct WorkFreeModelBadgeTag: View {
  let badge: WorkFreeModelBadge

  var body: some View {
    ADEKitTag(text: badge.label, tone: badge == .free ? .ok : .neutral, keepsCase: true)
      .accessibilityLabel(badge.label)
  }
}

/// The Free page when the machine lists no free model yet: get OpenCode,
/// its progress, or why it can't.
struct WorkFreeModelsSetupPane: View {
  let phase: WorkFreeModelsSetup.Phase
  /// The catalog is reading models after OpenCode became ready.
  let isRefreshingCatalog: Bool
  let onGet: () -> Void
  let onRefresh: () -> Void

  var body: some View {
    VStack(spacing: 10) {
      Spacer(minLength: 24)
      Image(systemName: symbol)
        .font(.title3.weight(.semibold))
        .foregroundStyle(symbolTint)
        .frame(height: 26)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)
      if let detail {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      progress
      action
        .padding(.top, 4)
      Spacer(minLength: 24)
    }
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity)
    .animation(.smooth(duration: 0.2), value: phase)
    .accessibilityElement(children: .contain)
  }

  private var symbol: String {
    switch phase {
    case .failed: return "exclamationmark.triangle"
    case .unavailable: return "nosign"
    default: return "gift"
    }
  }

  private var symbolTint: Color {
    switch phase {
    case .failed: return ADEColor.warning
    case .unavailable: return ADEColor.textMuted
    default: return ADEColor.success
    }
  }

  private var title: String {
    switch phase {
    case .idle, .checking: return "Checking for free models…"
    case .needsDownload, .unsupported: return "Free models aren't set up yet"
    case .downloading: return "Getting free models…"
    case .ready: return isRefreshingCatalog ? "Loading free models…" : "No free models right now"
    case .failed: return "Couldn't get free models"
    case .unavailable: return "Free models can't run here"
    }
  }

  private var detail: String? {
    switch phase {
    case .idle, .checking: return nil
    case .needsDownload: return "ADE downloads OpenCode to run them. No account or key needed."
    case .unsupported: return "Get them from ADE on your computer, then reopen this list."
    case .downloading(let received, let total): return workFreeModelsProgressText(received: received, total: total)
    case .ready: return isRefreshingCatalog ? nil : "OpenCode Zen has none to offer at the moment."
    case .failed(let reason): return reason
    case .unavailable(let reason): return reason
    }
  }

  @ViewBuilder
  private var progress: some View {
    switch phase {
    case .downloading(let received, let total):
      if let received, let total, total > 0 {
        ProgressView(value: min(received / total, 1))
          .tint(ADEColor.success)
          .frame(maxWidth: 200)
      } else {
        ProgressView().controlSize(.small)
      }
    case .idle, .checking:
      ProgressView().controlSize(.small)
    case .ready where isRefreshingCatalog:
      ProgressView().controlSize(.small)
    default:
      EmptyView()
    }
  }

  @ViewBuilder
  private var action: some View {
    switch phase {
    case .needsDownload:
      Button("Get free models", action: onGet)
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .accessibilityIdentifier("Work.ModelPicker.GetFreeModels")
    case .failed:
      Button("Try again", action: onGet)
        .buttonStyle(ADEKitButtonStyle())
    case .ready where !isRefreshingCatalog:
      Button("Refresh", action: onRefresh)
        .buttonStyle(ADEKitButtonStyle())
    default:
      EmptyView()
    }
  }
}

/// "12 of 48 MB", or nil before the size is known.
func workFreeModelsProgressText(received: Double?, total: Double?) -> String? {
  guard let received, let total, total > 0 else { return nil }
  let part = ByteCountFormatter()
  part.countStyle = .file
  part.allowedUnits = [.useMB]
  part.includesUnit = false
  let whole = ByteCountFormatter()
  whole.countStyle = .file
  whole.allowedUnits = [.useMB]
  return "\(part.string(fromByteCount: Int64(received))) of \(whole.string(fromByteCount: Int64(total)))"
}
