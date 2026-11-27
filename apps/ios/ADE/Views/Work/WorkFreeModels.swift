import Foundation
import SwiftUI

/// Free models: models a person can chat with without any paid plan, account
/// or key. The picker's Free page lists them, a machine with nothing signed in
/// starts new chats on one, and a new person's sign-in card offers them.
///
/// Mirrors `apps/desktop/src/shared/freeModels.ts` (the rule, badges, sources
/// and `pickFreeDefaultModelId`) and `apps/desktop/src/shared/adeFreeModels.ts`
/// (the ADE Free Models table); keep them together. Two sources: OpenCode Zen's
/// free tier, served only to OpenCode, and ADE Free Models (Gravity's models,
/// paid for by the sponsored cards in their chats, so they are ad-supported).
/// Rows carry a source and a badge, so each source is a tab on the Free page.

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

/// The Free page source of the ADE Free Models (`ADE_FREE_MODELS_SOURCE_ID`).
let workAdeFreeModelsSource = "ade-free"

private let workFreeModelSourceLabels: [String: String] = [
  "opencode-zen": "OpenCode Zen",
  workAdeFreeModelsSource: "ADE Free Models",
]

func workFreeModelSourceLabel(_ source: String) -> String {
  workFreeModelSourceLabels[source] ?? source
}

/// One ADE Free Model (`ADE_FREE_MODELS` in `shared/adeFreeModels.ts`).
struct WorkAdeFreeModel: Equatable {
  let alias: String
  let displayName: String

  /// The ADE registry id a chat's model names.
  var id: String { "opencode/\(workAdeFreeOpenCodeProviderId)/\(alias)" }
}

/// The OpenCode provider every ADE Free Model runs under (`ADE_FREE_OPENCODE_PROVIDER_ID`).
let workAdeFreeOpenCodeProviderId = "ade-free"

let workAdeFreeModels: [WorkAdeFreeModel] = [
  WorkAdeFreeModel(alias: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash"),
  WorkAdeFreeModel(alias: "glm-5.3-flash", displayName: "GLM 5.3 Flash"),
]

/// The ADE Free Model a model id names: the registry id
/// (`opencode/ade-free/<alias>`) or OpenCode's own (`ade-free/<alias>`).
func workAdeFreeModel(modelId: String?) -> WorkAdeFreeModel? {
  guard let modelId else { return nil }
  let id = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  let registryPrefix = "opencode/\(workAdeFreeOpenCodeProviderId)/"
  let ownPrefix = "\(workAdeFreeOpenCodeProviderId)/"
  let alias: String
  if id.hasPrefix(registryPrefix) {
    alias = String(id.dropFirst(registryPrefix.count))
  } else if id.hasPrefix(ownPrefix) {
    alias = String(id.dropFirst(ownPrefix.count))
  } else {
    return nil
  }
  return workAdeFreeModels.first { $0.alias == alias }
}

func workIsAdeFreeModel(_ modelId: String?) -> Bool {
  workAdeFreeModel(modelId: modelId) != nil
}

/// A free model that shows sponsored cards in its chats: never picked for a
/// person who did not choose it (`isAdSupportedFreeModelId`).
func workIsAdSupportedFreeModel(_ modelId: String) -> Bool {
  workFreeModelEntry(modelId: modelId)?.badge == .adSupported
}

/// OpenCode Zen's free models that do not end in `-free`
/// (`OPENCODE_ZEN_FREE_TIER_IDS` in `shared/harnessRoutes.ts`).
private let workOpenCodeZenFreeTierIds: Set<String> = ["big-pickle"]

/// The Free page row for a model id (`opencode/<provider>/<model>`), or nil
/// when the model is not free.
func workFreeModelEntry(modelId: String) -> WorkFreeModelEntry? {
  let id = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  if workIsAdeFreeModel(id) { return WorkFreeModelEntry(source: workAdeFreeModelsSource, badge: .adSupported) }
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
/// Ad-supported models are never picked here: their chats show cards, which
/// the person agrees to when they pick one themselves.
func workPickFreeDefaultModelId(freeModelIds: [String], preferred: [String]) -> String? {
  let candidates = freeModelIds.filter { !workIsAdSupportedFreeModel($0) }
  for id in preferred where candidates.contains(id) { return id }
  return candidates.first
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
///
/// The ADE Free Models come from the account, not from a machine: their rows
/// show only while `adeFree` lists them and says they are available, on any
/// machine, and a row the account lists but the catalog lacks is added from the
/// account. `cloudFree` is ADE Cloud's own marking (`free` on a `/cloud/models`
/// model), which wins over the id rule. `includeAdeFree` is false for a CLI
/// launch (a terminal can't show a card). `fillFromAccount` is false on a
/// surface that narrows the models (a fixed list, a filter): it then shows
/// only the ones its own catalog kept.
func workFreeModelGroups(
  _ catalog: [WorkModelCatalogGroup],
  adeFree: CloudFreeModelsState? = nil,
  cloudFree: [String: WorkFreeModelEntry] = [:],
  includeAdeFree: Bool = true,
  fillFromAccount: Bool = true
) -> [WorkFreeModelGroup] {
  var order: [String] = []
  var bySource: [String: [WorkModelOption]] = [:]
  var seen = Set<String>()
  func add(_ model: WorkModelOption, _ entry: WorkFreeModelEntry) {
    guard seen.insert(model.id).inserted else { return }
    if bySource[entry.source] == nil { order.append(entry.source) }
    bySource[entry.source, default: []].append(model)
  }
  for group in catalog {
    for provider in group.providers {
      for model in provider.models {
        guard let entry = cloudFree[model.id] ?? workFreeModelEntry(modelId: model.id) else { continue }
        if entry.badge == .adSupported || entry.source == workAdeFreeModelsSource {
          guard includeAdeFree, adeFree?.lists(model.id) == true else { continue }
        }
        add(model, entry)
      }
    }
  }
  if includeAdeFree, fillFromAccount, let adeFree, adeFree.available {
    for option in workAdeFreeAccountModelOptions(adeFree) {
      add(option, WorkFreeModelEntry(source: workAdeFreeModelsSource, badge: .adSupported))
    }
  }
  return order.map { WorkFreeModelGroup(source: $0, label: workFreeModelSourceLabel($0), models: bySource[$0] ?? []) }
}

/// ADE Cloud's own free marking of its models, by model id.
func workCloudFreeEntries(_ catalog: CloudModelCatalog) -> [String: WorkFreeModelEntry] {
  var entries: [String: WorkFreeModelEntry] = [:]
  for provider in catalog.providers {
    for model in provider.models {
      if let entry = model.free?.entry { entries[model.id] = entry }
    }
  }
  return entries
}

/// The ADE Free Models the account lists, as picker rows, for a machine whose
/// own catalog doesn't list them.
func workAdeFreeAccountModelOptions(_ state: CloudFreeModelsState) -> [WorkModelOption] {
  guard state.available else { return [] }
  var infos: [AgentChatModelInfo] = []
  for id in state.modelIds {
    guard let model = workAdeFreeModel(modelId: id), !infos.contains(where: { $0.id == model.id }) else { continue }
    infos.append(
      AgentChatModelInfo(
        id: model.id,
        displayName: model.displayName,
        description: "Ad-supported, free on any plan",
        isDefault: false,
        reasoningEfforts: [],
        defaultReasoningEffort: nil,
        serviceTiers: []
      )
    )
  }
  guard !infos.isEmpty else { return [] }
  return workModelCatalogGroups(availableModelsByProvider: ["opencode": infos], currentModelId: "", currentProvider: "")
    .flatMap { $0.providers.flatMap { $0.models } }
    .filter { workIsAdeFreeModel($0.id) }
}

/// The free model ids a host catalog lists that the machine can run now. The
/// ADE Free Models are not counted: they come from the account, and a machine
/// that lists only them still has no OpenCode Zen to offer.
func workFreeModelIds(in catalog: AgentChatModelCatalog) -> [String] {
  var ids: [String] = []
  for group in catalog.groups {
    for provider in group.providers {
      for subsection in provider.subsections {
        for model in subsection.models where model.isAvailable && workIsFreeModel(model.id) && !workIsAdSupportedFreeModel(model.id) && !ids.contains(model.id) {
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
final class WorkFreeModelsStatusStore: ObservableObject {
  static let shared = WorkFreeModelsStatusStore()

  private struct Entry {
    let status: WorkFreeModelsStatus?
    let at: Date
  }

  /// Per machine (`key(for:)`): goes up when its free models are read again
  /// (OpenCode finished downloading there, or the person tapped Refresh) and
  /// when its answer is forgotten (a sign-in). The New Chat page watches its
  /// machine's value to try its free default again.
  @Published private var generations: [String: Int] = [:]

  private var entries: [String: Entry] = [:]
  private var inFlight: [String: Task<(status: WorkFreeModelsStatus?, read: Bool), Never>] = [:]
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

  func generation(for host: ProviderAccountsHost) -> Int {
    generations[Self.key(for: host)] ?? 0
  }

  /// Forgets the machine's answer (a sign-in finished there).
  func invalidate(for host: ProviderAccountsHost) {
    let key = Self.key(for: host)
    entries[key] = nil
    // A read started before the sign-in must not answer a new ask.
    inFlight[key] = nil
    generations[key, default: 0] &+= 1
  }

  func freeCatalogDidRefresh(for host: ProviderAccountsHost) {
    generations[Self.key(for: host), default: 0] &+= 1
  }

  /// Keeps the block of an `ai.getStatus` answer read for another reason.
  /// `generation` is the machine's value when the read started: a read that
  /// a sign-in outran is not kept.
  func record(aiStatus: Any, for host: ProviderAccountsHost, readAtGeneration generation: Int) {
    let key = Self.key(for: host)
    guard (generations[key] ?? 0) == generation else { return }
    entries[key] = Entry(status: WorkFreeModelsStatus(aiStatus: aiStatus), at: Date())
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
    if let task = inFlight[key] { return await task.value.status }
    let generation = generations[key] ?? 0
    // A failed read is not kept: the next ask tries again.
    let task = Task { @MainActor () -> (status: WorkFreeModelsStatus?, read: Bool) in
      guard let raw = try? await host.runProviderAccountsCommand("ai.getStatus", args: [:]) else { return (nil, false) }
      return (WorkFreeModelsStatus(aiStatus: raw), true)
    }
    inFlight[key] = task
    let result = await task.value
    if inFlight[key] == task { inFlight[key] = nil }
    // The machine changed while this read ran (a sign-in): its answer is old.
    if result.read, generations[key] ?? 0 == generation {
      entries[key] = Entry(status: result.status, at: Date())
    }
    return result.status
  }
}

/// The model catalog of the machine behind `host`, or nil when it cannot be
/// read. The primary connection reads its project catalog; another machine
/// its machine-wide one. Free-model reads use this, so they go to the same
/// machine as the free-models status and the OpenCode download.
@MainActor
func workModelCatalog(
  on host: ProviderAccountsHost,
  mode: String,
  refreshProvider: String? = nil
) async -> AgentChatModelCatalog? {
  if let sync = host as? SyncService {
    return try? await sync.getChatModelCatalog(mode: mode, refreshProvider: refreshProvider)
  }
  let action = "personalChats.modelCatalog"
  guard host.providerAccountsConnected, host.supportsProviderAccountsAction(action) else { return nil }
  var args: [String: Any] = ["mode": mode]
  if let refreshProvider { args["refreshProvider"] = refreshProvider }
  guard let raw = try? await host.runProviderAccountsCommand(action, args: args),
        let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
  return try? JSONDecoder().decode(AgentChatModelCatalog.self, from: data)
}

/// The free models the machine behind `host` lists now. A cached catalog
/// with no free model can be older than OpenCode on the machine, so the
/// machine then reads OpenCode's models again before it answers.
@MainActor
func workFreeModelIds(on host: ProviderAccountsHost) async -> [String] {
  #if DEBUG
  if let pin = WorkFreeModelsStatusStore.shared.previewPin { return pin.freeModelIds }
  #endif
  if let cached = await workModelCatalog(on: host, mode: "cached") {
    let ids = workFreeModelIds(in: cached)
    if !ids.isEmpty { return ids }
  }
  // "refresh-stale" can answer with the same old list and refresh later.
  guard let fresh = await workModelCatalog(on: host, mode: "force", refreshProvider: "opencode") else { return [] }
  return workFreeModelIds(in: fresh)
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
  /// The machine the phase belongs to (`WorkFreeModelsStatusStore.key(for:)`).
  private var machineKey: String?
  private static let args: [String: Any] = ["provider": "opencode"]

  static func canCheck(_ host: ProviderAccountsHost?) -> Bool {
    guard let host else { return false }
    return host.providerAccountsConnected && host.supportsProviderAccountsAction("ai.pinnedToolStatus")
  }

  /// Reads where OpenCode stands on the machine, once. A download already
  /// running (the machine starts one for a new person) shows its progress.
  func check(host: ProviderAccountsHost?, onReady: @escaping @MainActor () async -> Void) async {
    follow(host: host)
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
    follow(host: host)
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

  /// Another machine now: the last one's setup and its poll end, and the
  /// page reads this one from the start. The same machine keeps its progress.
  func follow(host: ProviderAccountsHost?) {
    let key = host.map { WorkFreeModelsStatusStore.key(for: $0) }
    guard key != machineKey else { return }
    machineKey = key
    attempt += 1
    pollTask?.cancel()
    pollTask = nil
    phase = .idle
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

/// A model's name with its Free tag beside it when the model is free. The
/// picker rows and the current-model bar each style the name their own way.
struct WorkModelNameWithFreeBadge<Name: View>: View {
  let modelId: String?
  let name: Name

  init(modelId: String?, @ViewBuilder name: () -> Name) {
    self.modelId = modelId
    self.name = name()
  }

  var body: some View {
    HStack(spacing: 6) {
      name
      if let modelId, let entry = workFreeModelEntry(modelId: modelId) {
        WorkFreeModelBadgeTag(badge: entry.badge)
      }
    }
  }
}

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
    case .needsDownload: return "\(Brand.name) downloads OpenCode to run them. No account or key needed."
    case .unsupported: return "Get them from \(Brand.name) on your computer, then reopen this list."
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

/// The one-time sheet before a person's first ADE Free Model: they are free
/// because each chat that uses one shows sponsored cards, and what Gravity
/// receives. Agree saves the account's yes (`PUT /cloud/free-models/consent`),
/// on every device at once; Not now picks nothing.
struct WorkFreeModelsConsentSheet: View {
  let modelName: String
  /// Saves the yes: nil when it worked, else the sentence to show.
  let onAgree: @MainActor () async -> String?
  let onNotNow: () -> Void
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .center, spacing: 10) {
          Image(systemName: "megaphone.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 30, height: 30)
            .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            Text(CloudFreeModelsState.sheetTitle)
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(modelName)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .fixedSize(horizontal: false, vertical: true)
        }
        VStack(alignment: .leading, spacing: 8) {
          fact("eye", CloudFreeModelsState.sheetLead)
          fact("point.3.connected.trianglepath.dotted", CloudFreeModelsState.sheetReceives)
          fact("globe.americas", CloudFreeModelsState.sheetRegion)
        }
        if let error {
          Text(error)
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.danger)
        }
        HStack(spacing: 8) {
          WorkSponsoredCTA(title: "Agree", primary: true) { agree() }
            .disabled(busy)
          WorkSponsoredCTA(title: "Not now") { onNotNow() }
            .disabled(busy)
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .adeScreenBackground()
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .interactiveDismissDisabled(busy)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("ADE Free Models and sponsored cards")
  }

  private func fact(_ symbol: String, _ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 15)
        .accessibilityHidden(true)
      Text(text)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .lineSpacing(1.5)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func agree() {
    guard !busy else { return }
    busy = true
    error = nil
    Task { @MainActor in
      error = await onAgree()
      busy = false
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
