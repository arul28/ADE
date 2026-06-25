import SwiftUI

enum WorkNewSessionMode: String, CaseIterable, Identifiable {
  case chat
  case cli

  var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: return "Chat"
    case .cli: return "CLI"
    }
  }

  var systemImage: String {
    switch self {
    case .chat: return "bubble.left.and.bubble.right"
    case .cli: return "chevron.left.forwardslash.chevron.right"
    }
  }

  var accessibilityDescription: String {
    switch self {
    case .chat: return "In-app chat agent"
    case .cli: return "Terminal CLI agent"
    }
  }
}

/// Desktop `ModeSwitcherPills` parity: compact Chat/CLI toggle for the nav bar.
struct WorkSessionTypeSwitcher: View {
  @Binding var selection: WorkNewSessionMode

  var body: some View {
    HStack(spacing: 4) {
      ForEach(WorkNewSessionMode.allCases) { mode in
        let isSelected = selection == mode
        Button {
          guard !isSelected else { return }
          withAnimation(.snappy(duration: 0.16)) {
            selection = mode
          }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: mode.systemImage)
              .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
              .opacity(0.85)
            Text(mode.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background {
            if isSelected {
              Capsule(style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.85))
            }
          }
          .overlay {
            if isSelected {
              Capsule(style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            }
          }
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.title)
        .accessibilityHint(mode.accessibilityDescription)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(4)
    .background(ADEColor.recessedBackground.opacity(0.72), in: Capsule(style: .continuous))
    .overlay {
      Capsule(style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Session type")
  }
}

/// Serializes the single allowed resume of the auto-create lane-naming race so
/// the naming call and the 10s timeout can both attempt to finish it: the first
/// to arrive resumes the continuation, and any later arrival is a no-op. This
/// lets the timeout proceed without waiting on a stuck host naming command.
private actor AutoLaneNameResolver {
  private var continuation: CheckedContinuation<String, Never>?

  init(_ continuation: CheckedContinuation<String, Never>) {
    self.continuation = continuation
  }

  func resume(with value: String) {
    guard let continuation else { return }
    self.continuation = nil
    continuation.resume(returning: value)
  }
}

/// `yyyyMMdd-HHmmss` stamp for generic auto-created lane fallback names.
private let workAutoLaneNameFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyyMMdd-HHmmss"
  return formatter
}()

private let workGenericLaneFallbackName = "parallel-task"

private let workLaneFallbackStopwords: Set<String> = [
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but",
  "can", "chat", "context", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "help", "how", "i", "if", "im", "in", "into",
  "is", "it", "just", "let", "make", "me", "my", "of", "on", "please",
  "pls", "prompt", "the", "this", "though", "thought", "to", "use", "we",
  "with", "wrong", "you",
]

private let workNamingTlds: Set<String> = [
  "com", "org", "io", "net", "dev", "app", "co", "ai", "gov", "edu", "sh", "xyz", "me",
]

func workAutoLaneGenericSuffix(date: Date = Date()) -> String {
  workAutoLaneNameFormatter.string(from: date)
}

func workDeterministicAutoLaneName(from prompt: String, genericSuffix: String? = nil) -> String {
  let collapsed = workCleanPromptForNaming(prompt)
  guard !collapsed.isEmpty else {
    return workGenericLaneFallback(genericSuffix: genericSuffix)
  }
  let priorityWords = workPriorityLaneNamingWords(cleanedPrompt: collapsed)
  if !priorityWords.isEmpty {
    return priorityWords.joined(separator: "-")
  }
  let tokens = workRegexMatches(
    in: collapsed.lowercased(),
    pattern: #"[a-z0-9]+"#
  )
  let meaningfulWords = Array(tokens
    .filter { $0.count > 1 && !workLaneFallbackStopwords.contains($0) }
    .prefix(5))
  let fallbackWords = Array(tokens
    .filter { $0.count > 1 }
    .prefix(4))
  let words = meaningfulWords.isEmpty ? fallbackWords : meaningfulWords
  let slug = workSlugify(words.joined(separator: "-"))
  if !slug.isEmpty {
    return String(slug.prefix(48))
  }
  return workGenericLaneFallback(genericSuffix: genericSuffix)
}

private func workCleanPromptForNaming(_ prompt: String) -> String {
  var value = prompt
  value = value.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
  value = value.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
  value = workReplacingRegexMatches(in: value, pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#) { match in
    " \(workNamingTokens(fromURLText: match)) "
  }
  value = value.replacingOccurrences(
    of: #"\b([a-z0-9][a-z0-9-]*)\.(?:com|org|io|net|dev|app|co|ai|gov|edu|sh|xyz|me)\b"#,
    with: " $1 ",
    options: [.regularExpression, .caseInsensitive]
  )
  value = value.replacingOccurrences(
    of: #"\b(?:ok so|okay so|correct me if i'?m wrong|correct me if im wrong|correct if i'?m wrong|correct if im wrong|if i'?m wrong|if im wrong|please|pls|kindly|can you|could you|would you|will you|help me|i need(?: you)? to|i want(?: you)? to|i'?d like(?: you)? to|let'?s|lets|we need to|take a look at|have a look at|take a look|look at|look into|check out|go over|show me|give me|tell me about|use context skill|use the context skill)\b"#,
    with: " ",
    options: [.regularExpression, .caseInsensitive]
  )
  value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
  return value.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func workNamingTokens(fromURLText urlText: String) -> String {
  let withoutScheme = urlText.replacingOccurrences(
    of: #"^[a-z][a-z0-9+.-]*://"#,
    with: "",
    options: [.regularExpression, .caseInsensitive]
  )
  let segments = withoutScheme
    .components(separatedBy: CharacterSet(charactersIn: "/?#&="))
    .filter { !$0.isEmpty }
  guard let host = segments.first else { return "" }
  let hostLabels = host
    .split(separator: ".")
    .map(String.init)
    .filter { label in
      let normalized = label.lowercased()
      return !normalized.isEmpty && normalized != "www" && !workNamingTlds.contains(normalized)
    }
  let pathLabels = segments.dropFirst().filter { !$0.isEmpty && $0.count <= 24 }
  return (hostLabels + pathLabels).joined(separator: " ")
}

private func workPriorityLaneNamingWords(cleanedPrompt: String) -> [String] {
  let normalized = cleanedPrompt
    .lowercased()
    .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else { return [] }
  let provider = ["claude", "codex", "cursor", "droid", "opencode"].first {
    workRegexContains(normalized, pattern: #"\b\#($0)\b"#)
  } ?? (workRegexContains(normalized, pattern: #"\bopen code\b"#) ? "opencode" : nil)
  guard let provider else { return [] }
  let mentionsAuth = workRegexContains(
    normalized,
    pattern: #"\b(auth|authenticate|authentication|credential|credentials|creds|oauth)\b"#
  )
  let mentionsLogin = workRegexContains(normalized, pattern: #"\b(log\s*in|login|signin|sign\s*in)\b"#)
  guard mentionsAuth || mentionsLogin else { return [] }
  var words = [provider, "auth"]
  if mentionsLogin {
    words.append("login")
  }
  if workRegexContains(normalized, pattern: #"\b(button|cta|call to action|chip|banner)\b"#) {
    words.append("button")
  }
  var seen: Set<String> = []
  return words.filter { seen.insert($0).inserted }.prefix(5).map { $0 }
}

private func workGenericLaneFallback(genericSuffix: String?) -> String {
  guard let suffix = workNormalizeGenericLaneSuffix(genericSuffix) else {
    return workGenericLaneFallbackName
  }
  return "\(workGenericLaneFallbackName)-\(suffix)"
}

private func workNormalizeGenericLaneSuffix(_ raw: String?) -> String? {
  let normalized = workSlugify((raw ?? "").lowercased())
  let clipped = String(normalized.prefix(24))
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
  return clipped.isEmpty ? nil : clipped
}

private func workSlugify(_ value: String) -> String {
  value
    .replacingOccurrences(of: #"[^a-z0-9-]+"#, with: "-", options: .regularExpression)
    .replacingOccurrences(of: #"-+"#, with: "-", options: .regularExpression)
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}

private func workRegexContains(_ value: String, pattern: String) -> Bool {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.firstMatch(in: value, range: range) != nil
}

private func workRegexMatches(in value: String, pattern: String) -> [String] {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.matches(in: value, range: range).compactMap { match in
    guard let tokenRange = Range(match.range, in: value) else { return nil }
    return String(value[tokenRange])
  }
}

private func workReplacingRegexMatches(
  in value: String,
  pattern: String,
  transform: (String) -> String
) -> String {
  guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
    return value
  }
  let nsValue = value as NSString
  let matches = regex.matches(in: value, range: NSRange(location: 0, length: nsValue.length))
  guard !matches.isEmpty else { return value }
  var result = ""
  var cursor = 0
  for match in matches {
    let range = match.range
    if range.location > cursor {
      result += nsValue.substring(with: NSRange(location: cursor, length: range.location - cursor))
    }
    result += transform(nsValue.substring(with: range))
    cursor = range.location + range.length
  }
  if cursor < nsValue.length {
    result += nsValue.substring(from: cursor)
  }
  return result
}

/// Full-screen "Start a new conversation" composer that replaces the modal
/// WorkNewChatSheet. Mirrors the desktop welcome screen: big ADE word-mark,
/// one-line tagline, a minimal workspace pill users can change inline, and a
/// prominent composer anchored at the bottom. Sending fires the host create
/// call and immediately pushes the new session route on top of the current
/// navigation path so the screen flows straight into the live chat instead
/// of bouncing back to the sidebar.
struct WorkNewChatScreen: View {
  @EnvironmentObject var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  let preferredLaneId: String?
  let onStarted: @MainActor (AgentChatSessionSummary, String) async -> Void
  let onCliStarted: @MainActor (TerminalSessionSummary) async -> Void
  let onRefreshLanes: @MainActor () async -> Void

  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var runtimeMode: String = "default"
  @State private var reasoningEffort: String = ""
  @State private var codexFastMode: Bool = false
  /// The catalog option the picker handed us, kept so fast-tier support is read
  /// from the live host-advertised model (its `serviceTiers`) rather than
  /// re-derived from the curated iOS catalog — which can miss a freshly
  /// advertised fast model and wrongly hide the toggle.
  @State private var selectedModelOption: WorkModelOption?
  @State private var sessionMode: WorkNewSessionMode = .chat
  /// Status banner shown above the composer during auto-create lane naming,
  /// mirroring desktop's "Naming lane with <model>… → Creating lane…" flow.
  @State private var autoCreateStatus: String?

  init(
    lanes: [LaneSummary],
    preferredLaneId: String?,
    onStarted: @escaping @MainActor (AgentChatSessionSummary, String) async -> Void,
    onCliStarted: @escaping @MainActor (TerminalSessionSummary) async -> Void,
    onRefreshLanes: @escaping @MainActor () async -> Void
  ) {
    self.lanes = lanes
    self.preferredLaneId = preferredLaneId
    self.onStarted = onStarted
    self.onCliStarted = onCliStarted
    self.onRefreshLanes = onRefreshLanes
    // Restore the last-used model + access mode so a fresh New Chat screen opens
    // on the user's most recent choices. Seeding the @State initial values here
    // (rather than assigning in onAppear) avoids the provider/model onChange
    // handlers firing and resetting runtimeMode back to the provider default.
    if let saved = WorkComposerPreferences.load() {
      _provider = State(initialValue: saved.provider)
      _modelId = State(initialValue: saved.modelId)
      _runtimeMode = State(initialValue: saved.runtimeMode)
      _reasoningEffort = State(initialValue: saved.reasoningEffort)
      _codexFastMode = State(initialValue: saved.codexFastMode)
    }
  }

  /// The live composer selection. Persisted as the app-wide "last used" choice
  /// whenever it changes (see `.onChange` in `body`) so the next New Chat —
  /// chat or CLI — restores it.
  private var composerSelection: WorkComposerPreferences.Selection {
    WorkComposerPreferences.Selection(
      provider: provider,
      modelId: modelId,
      runtimeMode: runtimeMode,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode
    )
  }

  /// Whether the synthetic "Auto-create lane" entry is the current selection.
  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  private var defaultNewSessionLane: LaneSummary? {
    if let preferredLaneId, let lane = lanes.first(where: { $0.id == preferredLaneId }) {
      return lane
    }
    return lanes.first { $0.laneType == "primary" }
      ?? lanes.first { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "primary" }
      ?? lanes.first
  }

  /// Fast mode only applies to in-app chat sessions on fast-tier models — the
  /// CLI launcher has no fast-mode parameter — so the lightning toggle (and the
  /// value we send) is gated on both. The picker's option can only *add* support
  /// (a live host-advertised fast tier the curated catalog may miss); it never
  /// suppresses the catalog/allow-list fallback, so a known-fast model whose
  /// option ships empty `serviceTiers` still shows the toggle.
  private var fastModeSupported: Bool {
    guard sessionMode == .chat else { return false }
    if let option = selectedModelOption,
       workModelIdsEquivalent(option.id, modelId),
       option.supportsServiceTier("fast") {
      return true
    }
    return workComposerSupportsFastMode(modelId: modelId, provider: provider)
  }

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)

      ScrollView {
        VStack(spacing: 18) {
          brandMark
          VStack(spacing: 6) {
            Text("Start a new conversation")
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Ask ADE anything — refactor code, debug issues, or explore ideas.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
          }

          laneSelector
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)

      if let autoCreateStatus, busy {
        HStack(spacing: 8) {
          ProgressView().controlSize(.mini)
          Text(autoCreateStatus)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
        .transition(.opacity)
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .padding(.horizontal, 20)
          .padding(.bottom, 6)
      }

      composerBar
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .toolbar {
      ToolbarItem(placement: .principal) {
        WorkSessionTypeSwitcher(selection: $sessionMode)
      }
      ToolbarItem(placement: .topBarTrailing) {
        if busy {
          ProgressView().controlSize(.small)
        }
      }
    }
    .onAppear {
      // A restored selection (see init) can carry a model only valid in the mode
      // it was last used in — e.g. a CLI-only Cursor model. The screen opens in
      // .chat and normalizeSelection only runs on a sessionMode *change*, which
      // never fires for the initial state, so a CLI-only model would otherwise
      // reach Send → createChatSession. Normalize here, but only when the model is
      // actually disallowed, so a valid restored selection keeps its runtimeMode.
      let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
      if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) {
        normalizeSelection(for: sessionMode)
      }
      if selectedLaneId.isEmpty {
        selectedLaneId = defaultNewSessionLane?.id ?? ""
      }
      if runtimeMode.isEmpty {
        runtimeMode = workDefaultRuntimeMode(provider: provider)
      }
    }
    .onChange(of: provider) { _, newProvider in
      runtimeMode = workDefaultRuntimeMode(provider: newProvider)
      if !workNewChatModel(modelId, belongsTo: workNormalizedNewChatProvider(newProvider)) {
        modelId = workDefaultNewChatModelId(provider: newProvider)
      }
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      normalizeSelection(for: newMode)
    }
    .onChange(of: modelId) { _, newModel in
      if !modelSupportsReasoning(modelId: newModel, provider: provider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: composerSelection) { _, newValue in
      // Persist every model / access-mode change so the next New Chat restores
      // it. Captures the full tuple atomically — a single field change here
      // already reflects any cascading provider/model normalization above.
      WorkComposerPreferences.save(newValue)
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider in
          selectedModelOption = option
          modelId = option.id
          provider = sessionMode == .chat
            ? workNormalizedNewChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          reasoningEffort = pickedReasoning ?? ""
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          modelPickerPresented = false
        }
      )
    }
  }

  @ViewBuilder
  private var brandMark: some View {
    ZStack {
      Text("ADE")
        .font(.system(size: 84, weight: .heavy, design: .default))
        .foregroundStyle(ADEColor.accent.opacity(0.18))
        .offset(x: 4, y: 4)
      Text("ADE")
        .font(.system(size: 84, weight: .heavy, design: .default))
        .foregroundStyle(
          LinearGradient(
            colors: [ADEColor.textPrimary, ADEColor.accent.opacity(0.9)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
    }
    .padding(.top, 8)
    .accessibilityLabel("ADE")
  }

  @ViewBuilder
  private var laneSelector: some View {
    HStack {
      Spacer(minLength: 0)
      WorkLanePickerDropdown(
        lanes: lanes,
        selectedLaneId: $selectedLaneId,
        onRefresh: onRefreshLanes
      )
      Spacer(minLength: 0)
    }
  }

  @ViewBuilder
  private var composerBar: some View {
    WorkNewChatComposerBar(
      sessionMode: sessionMode,
      provider: $provider,
      modelId: modelId,
      modelName: prettyNewChatModelName(modelId),
      busy: busy,
      canStart: !busy && (isAutoCreateLane || !selectedLaneId.isEmpty) && !modelId.isEmpty,
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      fastModeSupported: fastModeSupported,
      codexFastMode: $codexFastMode,
      onOpenModelPicker: { modelPickerPresented = true },
      onSubmit: submit(openingMessage:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    let lower = trimmed.lowercased()
    switch lower {
    case "opus": return "Claude Opus 4.7"
    case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
    case "sonnet": return "Claude Sonnet 4.6"
    case "haiku": return "Claude Haiku 4.5"
    default: break
    }
    if lower.hasPrefix("claude-") {
      let tail = trimmed.dropFirst("claude-".count)
      let joined = tail.split(separator: "-").map { part -> String in
        let s = String(part)
        if s.range(of: #"^\d+$"#, options: .regularExpression) != nil { return s }
        return s.prefix(1).uppercased() + s.dropFirst()
      }.joined(separator: " ")
      return "Claude " + joined.replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
    }
    return trimmed
  }

  @MainActor
  private func submit(openingMessage: String) async -> Bool {
    let opener = openingMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !busy && (isAutoCreateLane || !selectedLaneId.isEmpty) else { return false }
    guard !opener.isEmpty && !modelId.isEmpty else { return false }
    // Anchor the "last time you sent a message" choice — covers the case where
    // the user sent with the restored/default selection without changing it.
    WorkComposerPreferences.save(composerSelection)
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Resolve the target lane. When auto-create is selected we mint a fresh
    // lane first; on failure we surface the error and never create the session.
    // Track whether we created the lane so we can clean it up if the session
    // launch fails immediately afterwards (desktop parity).
    let targetLaneId: String
    var createdLaneId: String?
    if isAutoCreateLane {
      // Resolve the lane name first (desktop parity): try the host's small
      // naming model, but never let naming block or fail lane creation. Any
      // error / timeout / offline / host-disabled falls back to the same
      // deterministic name mobile already used.
      let deterministicName = autoCreatedLaneName(opener: opener)
      var resolvedName = deterministicName
      if let contextLaneId = defaultNewSessionLane?.id, !contextLaneId.isEmpty {
        withAnimation(.snappy(duration: 0.16)) {
          autoCreateStatus = "Naming lane with \(prettyNewChatModelName(modelId))…"
        }
        // Race the naming call against a 10s deadline (mirrors desktop's
        // Promise.race([suggestLaneName, timeout])). A Swift task group would
        // await BOTH children on scope exit, and the sync request continuation
        // is not cancellation-aware, so a slow/stuck host naming command could
        // keep the banner and lane creation blocked well past 10s. Using a
        // continuation lets us proceed the instant the timeout wins; the losing
        // task keeps running detached and its result is harmlessly discarded.
        // The naming task swallows its own errors into the deterministic
        // fallback so a host/offline failure never throws here.
        resolvedName = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
          let resolver = AutoLaneNameResolver(continuation)
          Task {
            let name = (try? await syncService.suggestLaneName(
              laneId: contextLaneId,
              prompt: opener,
              modelId: modelId,
              fallbackName: deterministicName
            )) ?? deterministicName
            await resolver.resume(with: name)
          }
          Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            await resolver.resume(with: deterministicName)
          }
        }
      }

      withAnimation(.snappy(duration: 0.16)) {
        autoCreateStatus = "Creating lane…"
      }
      do {
        let lane = try await syncService.createLane(
          name: resolvedName,
          description: opener.isEmpty ? "" : String(opener.prefix(280))
        )
        targetLaneId = lane.id
        createdLaneId = lane.id
        await onRefreshLanes()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        autoCreateStatus = nil
        busy = false
        return false
      }
    } else {
      targetLaneId = selectedLaneId
    }

    // Lane is ready; the naming/creating banner is done — the composer + nav
    // spinner carry the remaining "starting session" state.
    autoCreateStatus = nil

    do {
      if sessionMode == .cli {
        let cliProvider = workResolveCliProvider(for: modelId, provider: provider)
        let cliReasoningEffort = workCliSupportsReasoningSelection(provider: cliProvider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: targetLaneId,
          provider: cliProvider,
          permissionMode: workCliPermissionMode(provider: cliProvider, runtimeMode: runtimeMode),
          title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
          initialInput: opener,
          modelId: modelId,
          reasoningEffort: cliReasoningEffort,
          cols: 48,
          rows: 24
        )
        if let session = result.session {
          await onCliStarted(session)
        } else {
          let lane = lanes.first(where: { $0.id == targetLaneId })
          await onCliStarted(TerminalSessionSummary(
            id: result.sessionId,
            laneId: targetLaneId,
            laneName: lane?.name ?? targetLaneId,
            ptyId: result.ptyId,
            tracked: true,
            pinned: false,
            manuallyNamed: nil,
            goal: opener.isEmpty ? nil : opener,
            toolType: workCliToolType(provider: cliProvider),
            title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
            status: "running",
            startedAt: workDateFormatter.string(from: Date()),
            endedAt: nil,
            exitCode: nil,
            transcriptPath: "",
            headShaStart: nil,
            headShaEnd: nil,
            lastOutputPreview: nil,
            summary: nil,
            runtimeState: "running",
            resumeCommand: nil,
            resumeMetadata: nil,
            chatIdleSinceAt: nil
          ))
        }
        busy = false
        return true
      }
      let summary = try await syncService.createChatSession(
        laneId: targetLaneId,
        provider: provider,
        model: modelId,
        reasoningEffort: normalizedReasoning.isEmpty ? nil : normalizedReasoning,
        // Send an explicit true/false when the model supports fast mode so the
        // user's choice (including an explicit OFF) is honored rather than
        // falling back to the host default; nil only when fast mode is N/A.
        codexFastMode: fastModeSupported ? codexFastMode : nil,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      )
      await onStarted(summary, opener)
      busy = false
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      // The session never launched into a lane we just minted — tear it back
      // down so an auto-create failure doesn't leave an orphaned empty lane.
      if let createdLaneId {
        try? await syncService.deleteLane(createdLaneId)
        await onRefreshLanes()
      }
      busy = false
      return false
    }
  }

  /// Builds the desktop-parity deterministic fallback name for an auto-created
  /// lane. The host can still replace this through the best-effort naming call.
  private func autoCreatedLaneName(opener: String) -> String {
    workDeterministicAutoLaneName(from: opener, genericSuffix: workAutoLaneGenericSuffix())
  }

  private func normalizeSelection(for mode: WorkNewSessionMode) {
    let availabilityMode: WorkCursorAvailabilityMode = mode == .cli ? .cli : .chat
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode),
       let replacement = workDefaultModelIdForAvailabilityMode(preferredProvider: provider, mode: availabilityMode) {
      modelId = replacement.modelId
      provider = mode == .chat
        ? workNormalizedNewChatProvider(replacement.provider)
        : workResolveCliProvider(for: replacement.modelId, provider: replacement.provider)
    } else if mode == .chat {
      provider = workNormalizedNewChatProvider(provider)
      if !workNewChatModel(modelId, belongsTo: provider) {
        modelId = workDefaultNewChatModelId(provider: provider)
      }
    } else {
      provider = workResolveCliProvider(for: modelId, provider: provider)
    }
    runtimeMode = workDefaultRuntimeMode(provider: provider)
    if !modelSupportsReasoning(modelId: modelId, provider: provider) {
      reasoningEffort = ""
    }
    if !fastModeSupported {
      codexFastMode = false
    }
  }
}

private func workNormalizedNewChatProvider(_ provider: String) -> String {
  let family = providerFamilyKey(provider)
  // Droid (Factory) is a first-class in-app chat runtime, and its Droid Core
  // models (GLM / Kimi / MiniMax) only run under the droid provider — desktop
  // and the TUI already derive provider from the model's family. Without droid
  // in this allowlist, picking a Droid Core model silently collapsed the
  // provider to "claude", sending a GLM model id to the Claude runtime.
  return ["claude", "codex", "cursor", "opencode", "droid"].contains(family) ? family : "claude"
}

private func workNewChatModel(_ modelId: String, belongsTo provider: String) -> Bool {
  let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return false }
  return workModelCatalogGroupKey(for: trimmed, currentProvider: provider) == provider
}

private func workDefaultNewChatModelId(provider: String) -> String {
  let family = providerFamilyKey(provider)
  if let defaultModel = workDefaultCatalogModelId(provider: family) {
    return defaultModel
  }
  switch workNormalizedNewChatProvider(provider) {
  case "codex": return workDefaultCatalogModelId(provider: "codex") ?? "gpt-5.5"
  case "cursor": return "auto"
  case "opencode": return "opencode/anthropic/claude-sonnet-4-6"
  default: return "claude-sonnet-4-6"
  }
}

private func workCliSupportsReasoningSelection(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "droid"
}

private func workCliInitialSessionTitle(provider: String, opener: String) -> String {
  let fallback = providerLabel(provider)
  let seed = opener
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !seed.isEmpty else {
    return fallback
  }
  let clipped: String
  if seed.count > 72 {
    let prefix = String(seed.prefix(72))
    clipped = prefix.replacingOccurrences(of: #"\s+\S*$"#, with: "", options: .regularExpression)
  } else {
    clipped = seed
  }
  return clipped.trimmingCharacters(in: CharacterSet(charactersIn: ".?!,:; ").union(.whitespacesAndNewlines))
}

func workCliPermissionMode(provider: String, runtimeMode: String) -> String? {
  let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
  guard let permissionMode = wire.permissionMode, !permissionMode.isEmpty else {
    return nil
  }
  return permissionMode
}

private func workCliToolType(provider: String) -> String {
  switch providerFamilyKey(provider) {
  case "claude": return "claude"
  case "codex": return "codex"
  case "cursor": return "cursor-cli"
  case "opencode": return "opencode"
  case "droid": return "droid"
  default: return "opencode"
  }
}

private struct WorkNewChatComposerBar: View {
  let sessionMode: WorkNewSessionMode
  @Binding var provider: String
  let modelId: String
  let modelName: String
  let busy: Bool
  let canStart: Bool
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  let fastModeSupported: Bool
  @Binding var codexFastMode: Bool
  let onOpenModelPicker: () -> Void
  let onSubmit: @MainActor (String) async -> Bool

  @State private var draft: String = ""
  @FocusState private var composerFocused: Bool
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  /// Live viewport width of the controls scroll area, so the access control
  /// collapses to the in-session composer's dot-Menu at the same threshold.
  @State private var controlsWidth: CGFloat = 0
  private let dictationTargetId = "work-new-chat-screen"

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    canStart && !trimmedDraft.isEmpty
  }

  private var runtimeOptions: [WorkRuntimeModeOption] {
    workRuntimeModeOptions(provider: provider)
  }

  private var isControlsCollapsed: Bool {
    controlsWidth > 0 && controlsWidth <= workComposerControlsCollapseThreshold
  }

  private var placeholder: String {
    "Type to vibecode…"
  }

  @MainActor
  private func dispatch() {
    let text = trimmedDraft
    draft = ""
    Task {
      let started = await onSubmit(text)
      if !started {
        draft = text
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(placeholder, text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.accent)
        .autocorrectionDisabled(false)
        .textInputAutocapitalization(.sentences)
        .focused($composerFocused)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

      HStack(alignment: .center, spacing: 8) {
        if !isDictating {
          ScrollView(.horizontal, showsIndicators: false) {
            WorkComposerControlsRow(
              provider: provider,
              modelDisplayName: modelName,
              reasoningEffort: reasoningEffort,
              currentMode: runtimeMode,
              modeOptions: runtimeOptions,
              modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
              isCollapsed: isControlsCollapsed,
              fastModeSupported: fastModeSupported,
              fastModeEnabled: codexFastMode,
              settingsMutationInFlight: busy,
              onOpenModelPicker: onOpenModelPicker,
              onSelectMode: { runtimeMode = $0 },
              onToggleFastMode: { codexFastMode = $0 }
            )
            .padding(.trailing, 4)
          }
          .background(
            GeometryReader { proxy in
              Color.clear
                .onAppear { controlsWidth = proxy.size.width }
                .onChange(of: proxy.size.width) { _, newValue in
                  controlsWidth = newValue
                }
            }
          )

          DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
        }

        DictationMicButton(
          draft: $draft,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

        if !isDictating {
          foregroundSendButton
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(ADEColor.composerBackground)
    )
    .glassEffect(in: .rect(cornerRadius: 24))
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.10), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .allowsHitTesting(false)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.32), radius: 14, y: 6)
    .padding(.horizontal, 16)
    .padding(.bottom, 0)
  }

  /// Primary foreground launch button — the compact arrow-in-circle send glyph
  /// shared with the in-session composer (desktop parity), navigating into the
  /// new live chat.
  private var foregroundSendButton: some View {
    ADEComposerSendButton(
      enabled: canSend && !busy,
      sending: busy,
      accessibilityLabelText: "Send",
      disabledAccessibilityLabel: "Enter a message to send"
    ) {
      dispatch()
    }
  }

}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}
