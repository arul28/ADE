import Foundation
import SwiftUI

// MARK: - Newer model versions (ADE-300)

/// One row of a newer-version chain.
///
/// Mirrors `successorId` in apps/desktop/src/shared/modelRegistry.ts and
/// `findModelUpgrade` in apps/desktop/src/shared/modelSuccessors.ts; keep the
/// three in step.
private struct WorkModelVersionRow {
  /// Canonical registry id, as the host's catalog names it.
  let id: String
  /// The provider's own id for it, which other harnesses wrap
  /// (`opencode/anthropic/claude-fable-5-1`, Cursor's `claude-fable-5-1-thinking-high`).
  let wireId: String
  let displayName: String
  /// The provider's next version of this same model.
  let successorId: String?
  /// The maker's mark and tint key (`providerTint`, `WorkProviderBareLogo`).
  let brand: String

  private static let brandByPrefix = ["anthropic": "claude", "openai": "codex", "xai": "grok"]

  init(id: String, wireId: String, displayName: String, successorId: String?) {
    self.id = id
    self.wireId = wireId
    self.displayName = displayName
    self.successorId = successorId
    let prefix = id.split(separator: "/").first.map(String.init) ?? id
    brand = Self.brandByPrefix[prefix] ?? prefix
  }
}

private let workModelVersionRows: [WorkModelVersionRow] = [
  WorkModelVersionRow(id: "anthropic/claude-fable-5-1", wireId: "claude-fable-5-1", displayName: "Claude Fable 5.1", successorId: "anthropic/claude-fable-5-2"),
  WorkModelVersionRow(id: "anthropic/claude-fable-5-2", wireId: "claude-fable-5-2", displayName: "Claude Fable 5.2", successorId: nil),
  WorkModelVersionRow(id: "anthropic/claude-opus-5", wireId: "claude-opus-5", displayName: "Claude Opus 5", successorId: "anthropic/claude-opus-5-5"),
  WorkModelVersionRow(id: "anthropic/claude-opus-5-5", wireId: "claude-opus-5-5", displayName: "Claude Opus 5.5", successorId: nil),
  WorkModelVersionRow(id: "anthropic/claude-sonnet-5", wireId: "claude-sonnet-5", displayName: "Claude Sonnet 5", successorId: "anthropic/claude-sonnet-5-5"),
  WorkModelVersionRow(id: "anthropic/claude-sonnet-5-5", wireId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", successorId: nil),
  WorkModelVersionRow(id: "openai/gpt-5.6-sol", wireId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", successorId: "openai/gpt-6-sol"),
  WorkModelVersionRow(id: "openai/gpt-6-sol", wireId: "gpt-6-sol", displayName: "GPT-6 Sol", successorId: "openai/gpt-6.1-sol"),
  WorkModelVersionRow(id: "openai/gpt-6.1-sol", wireId: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", successorId: "openai/gpt-6.2-sol"),
  WorkModelVersionRow(id: "openai/gpt-6.2-sol", wireId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", successorId: nil),
  WorkModelVersionRow(id: "openai/gpt-6-astra", wireId: "gpt-6-astra", displayName: "GPT-6 Astra", successorId: "openai/gpt-6.2-astra"),
  WorkModelVersionRow(id: "openai/gpt-6.2-astra", wireId: "gpt-6.2-astra", displayName: "GPT-6.2 Astra", successorId: nil),
  WorkModelVersionRow(id: "openai/gpt-5.6-terra", wireId: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", successorId: "openai/gpt-6.1-terra"),
  WorkModelVersionRow(id: "openai/gpt-6.1-terra", wireId: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", successorId: nil),
  WorkModelVersionRow(id: "openai/gpt-5.6-luna", wireId: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", successorId: "openai/gpt-6-luna"),
  WorkModelVersionRow(id: "openai/gpt-6-luna", wireId: "gpt-6-luna", displayName: "GPT-6 Luna", successorId: nil),
  WorkModelVersionRow(id: "muse/muse-spark-1.2", wireId: "muse-spark-1.2", displayName: "Muse Spark 1.2", successorId: "muse/muse-spark-1.3"),
  WorkModelVersionRow(id: "muse/muse-spark-1.3", wireId: "muse-spark-1.3", displayName: "Muse Spark 1.3", successorId: nil),
  WorkModelVersionRow(id: "xai/grok-4-5", wireId: "grok-4.5", displayName: "Grok 4.5", successorId: "xai/grok-4-6"),
  WorkModelVersionRow(id: "xai/grok-4-6", wireId: "grok-4.6", displayName: "Grok 4.6", successorId: nil),
]

private let workModelVersionRowsById: [String: WorkModelVersionRow] = Dictionary(
  uniqueKeysWithValues: workModelVersionRows.map { ($0.id, $0) }
)

/// Rows with a successor, longest wire id first so `claude-opus-5-5` is tried
/// before `claude-opus-5`.
private let workModelVersionPredecessors: [WorkModelVersionRow] = workModelVersionRows
  .filter { $0.successorId != nil }
  .sorted { $0.wireId.count > $1.wireId.count }

/// The row `modelId` names itself: its registry id, a saved alias the
/// catalog's canonical maps know (`fable`, `claude-fable-5`, `sonnet-4-6`,
/// `gpt-6-sol`), or the same harness's short id (`muse-spark-1.2`,
/// `grok-4.5`). A wrapped id (`opencode/anthropic/claude-fable-5-1`) is not the
/// row: it is a twin.
private func workModelVersionRow(for modelId: String) -> WorkModelVersionRow? {
  let id = modelId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if let row = workModelVersionRowsById[id] { return row }
  // The canonical maps also fold OpenCode's ids into the registry id; those
  // stay twins, so the newer version stays on OpenCode.
  if !id.hasPrefix("opencode/"),
     let canonical = workCanonicalClaudeRegistryId(for: id) ?? workCanonicalCodexRegistryId(for: id) {
    return workModelVersionRowsById[canonical]
  }
  return workModelVersionRows.first { row in
    guard let slash = row.id.firstIndex(of: "/") else { return false }
    return String(row.id[row.id.index(after: slash)...]) == id || row.wireId == id
  }
}

/// The successor chain of a row, oldest first.
private func workModelSuccessorChain(_ row: WorkModelVersionRow) -> [WorkModelVersionRow] {
  var chain: [WorkModelVersionRow] = []
  var seen: Set<String> = [row.id]
  var next = row.successorId.flatMap { workModelVersionRowsById[$0] }
  while let current = next, !seen.contains(current.id), chain.count < 8 {
    chain.append(current)
    seen.insert(current.id)
    next = current.successorId.flatMap { workModelVersionRowsById[$0] }
  }
  return chain
}

/// `wire` with each `<digit><from><digit>` separator turned into `to`.
private func workRespelledWireId(_ wire: String, from: Character, to: Character) -> String {
  let chars = Array(wire)
  var out = chars
  for index in chars.indices where chars[index] == from
    && index > 0 && index + 1 < chars.count
    && chars[index - 1].isNumber && chars[index + 1].isNumber {
    out[index] = to
  }
  return String(out)
}

/// The spellings a wire id takes inside another harness's id: as written,
/// dotted (Cursor's `claude-fable-5.1-thinking-high`), dashed (`grok-4-5`).
/// The successor's wire id takes the same spelling.
private let workWireIdSpellings: [(String) -> String] = [
  { $0 },
  { workRespelledWireId($0, from: "-", to: ".") },
  { workRespelledWireId($0, from: ".", to: "-") },
]

/// Where `token` sits in `id` as a whole wire id, as the desktop's
/// `wireIdIndex`: only the last path segment is the model
/// (`pi/<profile>/<provider>/<model>`: a profile named like a model is not
/// one). It starts that segment or follows `:` or an encoded `/` (OpenRouter's
/// `anthropic%2Fclaude-opus-5`), and is not followed by more version digits
/// (`claude-opus-5` is not inside `claude-opus-5-5`).
private func workWireIdRange(in id: String, token: String) -> Range<String.Index>? {
  let segmentStart = id.lastIndex(of: "/").map { id.index(after: $0) } ?? id.startIndex
  var searchStart = segmentStart
  while searchStart < id.endIndex, let range = id.range(of: token, range: searchStart..<id.endIndex) {
    let before = id[segmentStart..<range.lowerBound]
    let startsClean = range.lowerBound == segmentStart
      || before.hasSuffix(":")
      || before.uppercased().hasSuffix("%2F")
    let rest = id[range.upperBound...]
    var endsClean = true
    if let first = rest.first, first == "-" || first == ".",
       let second = rest.dropFirst().first, second.isNumber {
      endsClean = false
    }
    if startsClean && endsClean { return range }
    searchStart = id.index(after: range.lowerBound)
  }
  return nil
}

/// A newer version of the model a chat or draft is on.
struct WorkModelUpgrade: Equatable {
  /// The model the chat or draft is on now.
  let fromModelId: String
  /// The newest successor the chat's machine lists, as it lists it.
  let toModelId: String
  /// Short names, without "Claude " ("Fable 5.2").
  let fromName: String
  let toName: String
  /// The newer model's mark and tint key.
  let brand: String
}

/// "Claude Fable 5.2" → "Fable 5.2", as the desktop's `shortName`.
func workShortModelName(_ name: String) -> String {
  var short = name.trimmingCharacters(in: .whitespacesAndNewlines)
  if short.hasPrefix("Claude ") { short = String(short.dropFirst("Claude ".count)) }
  return short
}

/// The name the strip shows: the host's own title for that id when the phone
/// has seen it, else the version row's.
private func workUpgradeModelName(_ modelId: String, fallback: String) -> String {
  workShortModelName(WorkModelMentionDirectory.shared.entry(for: modelId)?.title ?? fallback)
}

/// The newer model's mark: the host's maker key for that id when the phone
/// has seen it (an OpenCode row names its upstream maker), else the row's.
private func workUpgradeBrand(_ modelId: String, fallback: String) -> String {
  WorkModelMentionDirectory.shared.entry(for: modelId)?.brandKey ?? fallback
}

/// The newer version of `modelId` the chat's machine can run, or nil. Follows
/// the successor chain and returns its newest member in `available`, so a chat
/// on GPT-6 Sol moves straight to GPT-6.2 Sol. A model reached through another
/// harness moves to the same harness's newer id, spelled the same way.
func workFindModelUpgrade(modelId: String, available: [String]) -> WorkModelUpgrade? {
  let id = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !id.isEmpty, !available.isEmpty else { return nil }

  if let row = workModelVersionRow(for: id) {
    guard row.successorId != nil else { return nil }
    for successor in workModelSuccessorChain(row).reversed() {
      // The id as the machine lists it: its registry id or the short form.
      if let listed = available.first(where: { workModelVersionRow(for: $0)?.id == successor.id }) {
        return WorkModelUpgrade(
          fromModelId: id,
          toModelId: listed,
          fromName: workUpgradeModelName(id, fallback: row.displayName),
          toName: workUpgradeModelName(listed, fallback: successor.displayName),
          brand: workUpgradeBrand(listed, fallback: successor.brand)
        )
      }
    }
    return nil
  }

  // A twin through another harness: swap the wire id inside the longer id.
  let listed = Set(available)
  for predecessor in workModelVersionPredecessors {
    // Every spelling that finds the old version. `claude-opus-5` has no
    // separator to respell, so as written and dotted both match, and the
    // harness may list the newer one either way (`claude-opus-5-5`, `-5.5`).
    let matches = workWireIdSpellings.compactMap { spell -> (spell: (String) -> String, range: Range<String.Index>)? in
      workWireIdRange(in: id, token: spell(predecessor.wireId)).map { (spell, $0) }
    }
    guard !matches.isEmpty else { continue }
    for successor in workModelSuccessorChain(predecessor).reversed() {
      for match in matches {
        let candidate = id.replacingCharacters(in: match.range, with: match.spell(successor.wireId))
        if candidate != id && listed.contains(candidate) {
          return WorkModelUpgrade(
            fromModelId: id,
            toModelId: candidate,
            fromName: workUpgradeModelName(id, fallback: predecessor.displayName),
            toName: workUpgradeModelName(candidate, fallback: successor.displayName),
            brand: workUpgradeBrand(candidate, fallback: successor.brand)
          )
        }
      }
    }
    return nil
  }
  return nil
}

/// The short name of the provider's newer version of `modelId`, when the model
/// is an older version (the picker's "Previous" tag). Nil for the newest one
/// and for models with no newer version.
func workModelNewerVersionName(_ modelId: String) -> String? {
  func successorName(_ row: WorkModelVersionRow) -> String? {
    row.successorId.flatMap { workModelVersionRowsById[$0] }.map { workShortModelName($0.displayName) }
  }
  if let row = workModelVersionRow(for: modelId) { return successorName(row) }
  for predecessor in workModelVersionPredecessors
  where workWireIdSpellings.contains(where: { workWireIdRange(in: modelId, token: $0(predecessor.wireId)) != nil }) {
    return successorName(predecessor)
  }
  return nil
}

/// The models a host catalog lets a chat run, for the upgrade lookup. A CLI
/// launch lists only the models its CLI runs, as the picker does.
func workAvailableCatalogModelIds(
  _ catalog: AgentChatModelCatalog,
  mode: WorkCursorAvailabilityMode = .chat
) -> [String] {
  catalog.groups.flatMap { group in
    group.providers.flatMap { provider in
      provider.subsections.flatMap { subsection in
        subsection.models
          .filter { model in
            guard model.isAvailable else { return false }
            guard let availability = model.cursorAvailability else { return true }
            return mode == .cli ? availability.cli : availability.sdk
          }
          .map(\.id)
      }
    }
  }
}

/// Newer-version suggestions the person turned down (ADE-300), on this
/// device, like the remembered model they are about. One entry per pair
/// (`from>to`, the desktop's `ade.chat.dismissedModelUpgrades.v1`): closing
/// "Fable 5.2 is out" on Fable 5.1 hides that pair in every chat, and a later
/// Fable 5.3 is offered again. Picking the older version by hand turns its
/// pair down too.
enum WorkModelUpgradeMemory {
  private static let dismissedKey = "ade.chat.dismissedModelUpgrades.v1"
  private static let dismissedMax = 64

  private static func pairKey(_ upgrade: WorkModelUpgrade) -> String {
    "\(upgrade.fromModelId)>\(upgrade.toModelId)"
  }

  static func isDismissed(_ upgrade: WorkModelUpgrade) -> Bool {
    (UserDefaults.standard.stringArray(forKey: dismissedKey) ?? []).contains(pairKey(upgrade))
  }

  static func dismiss(_ upgrade: WorkModelUpgrade) {
    let key = pairKey(upgrade)
    let dismissed = UserDefaults.standard.stringArray(forKey: dismissedKey) ?? []
    guard dismissed.first != key else { return }
    UserDefaults.standard.set(Array(([key] + dismissed.filter { $0 != key }).prefix(dismissedMax)), forKey: dismissedKey)
  }

  /// The suggestion to show for `modelId` on a machine that runs `available`,
  /// unless the person turned that pair down.
  static func suggestion(for modelId: String, available: [String]) -> WorkModelUpgrade? {
    guard let upgrade = workFindModelUpgrade(modelId: modelId, available: available),
          !isDismissed(upgrade) else { return nil }
    return upgrade
  }

  /// A model picked by hand (the picker, the `@` menu): when it is an older
  /// version, the pair it would be offered now is turned down.
  static func notePicked(_ modelId: String, available: [String]) {
    if let upgrade = workFindModelUpgrade(modelId: modelId, available: available) { dismiss(upgrade) }
  }
}

/// Bumped when a machine's model list or ADE Cloud's is read fresh, so the
/// newer-version suggestion reads its list again: a list that was empty at
/// first, or that gained the newer version later, is offered without a new
/// screen. Not bumped by a read the cache answered, so a refresh never loops.
@MainActor
final class WorkModelCatalogRevision: ObservableObject {
  static let shared = WorkModelCatalogRevision()
  @Published private(set) var value = 0
  /// The available ids each machine's personal-chat list last held. That list
  /// has no cache, so the suggestion's own re-read must not bump: only a list
  /// whose models changed does (a provider refreshed in the picker).
  private var personalListByMachine: [String: [String]] = [:]

  func bump() { value &+= 1 }

  func notePersonalCatalog(_ catalog: AgentChatModelCatalog, machineKey: String) {
    let ids = workAvailableCatalogModelIds(catalog).sorted()
    guard personalListByMachine[machineKey] != ids else { return }
    personalListByMachine[machineKey] = ids
    bump()
  }
}

/// Runs the suggestion's refresh when its key changes and when a model list
/// is read fresh. Only this modifier observes the revision, so the screen
/// around it does not redraw for it.
struct WorkModelUpgradeRefreshTask: ViewModifier {
  @ObservedObject private var revision = WorkModelCatalogRevision.shared
  let key: String
  let refresh: @MainActor () async -> Void

  init(key: String, refresh: @escaping @MainActor () async -> Void) {
    self.key = key
    self.refresh = refresh
  }

  func body(content: Content) -> some View {
    content.task(id: "\(key)|\(revision.value)") { await refresh() }
  }
}

// MARK: - The open chat's suggestion

extension WorkChatSessionView {
  /// The chat's composer can change its model now (the model chip opens the picker).
  var canSwitchChatModel: Bool {
    chatSummaryContext.isAvailable
      && !chatSummaryContext.isSideChat
      && !(isPersonalChat && (!personalModelCatalogAvailable || !personalSessionUpdatesAvailable))
  }

  /// "A newer version is out", while the chat is still on the older one.
  /// The sign-in card takes the composer's place, and this with it.
  var shownModelUpgradeOffer: WorkModelUpgrade? {
    guard inputLockMessage == nil, canSwitchChatModel, let modelUpgradeOffer,
          modelUpgradeOffer.fromModelId == chatSummaryContext.currentModelId else { return nil }
    return modelUpgradeOffer
  }

  var modelUpgradeTaskKey: String {
    "\(session.id)|\(chatSummaryContext.currentModelId)|\(canSwitchChatModel)|\(loadModelUpgradeCandidates != nil)|\(modelPickerCloudCatalog != nil)"
  }

  /// Reads the chat machine's models and suggests the newest version of the
  /// chat's model it runs, unless the person turned that pair down. An older
  /// version just picked by hand has its pair turned down here, once the
  /// list is read, so the strip never offers back what was just chosen.
  @MainActor
  func refreshModelUpgradeOffer() async {
    modelUpgradeOffer = nil
    let modelId = chatSummaryContext.currentModelId
    guard canSwitchChatModel, let load = loadModelUpgradeCandidates, !modelId.isEmpty,
          workModelNewerVersionName(modelId) != nil else { return }
    guard let available = await load(), !Task.isCancelled,
          chatSummaryContext.currentModelId == modelId else { return }
    modelUpgradeAvailable = available
    if let picked = modelUpgradeHandPicked, workModelIdsEquivalent(picked, modelId) {
      WorkModelUpgradeMemory.notePicked(modelId, available: available)
      modelUpgradeHandPicked = nil
    }
    modelUpgradeOffer = WorkModelUpgradeMemory.suggestion(for: modelId, available: available)
  }

  /// A model picked by hand in the picker, before the chat changes to it.
  func noteModelHandPicked(_ modelId: String) {
    guard workModelNewerVersionName(modelId) != nil else { return }
    modelUpgradeHandPicked = modelId
  }

  /// "Switch": the same model change the picker makes, on the chat's machine.
  func switchToNewerModelVersion() {
    guard let offer = modelUpgradeOffer, !modelUpdateInFlight else { return }
    ADEHaptics.light()
    Task { @MainActor in
      modelUpdateInFlight = true
      defer { modelUpdateInFlight = false }
      if await onSelectModel(offer.toModelId) { modelUpgradeOffer = nil }
    }
  }

  /// ×: this pair is turned down on this device, in every chat.
  func dismissModelUpgradeOffer() {
    guard let offer = modelUpgradeOffer else { return }
    WorkModelUpgradeMemory.dismiss(offer)
    modelUpgradeOffer = nil
  }
}
