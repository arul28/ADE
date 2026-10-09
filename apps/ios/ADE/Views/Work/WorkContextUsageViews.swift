import SwiftUI

/// Claude, Codex, and Pi honor `/compact` as a real compact action. Other
/// providers would treat the same text as a normal prompt.
func workProviderSupportsManualCompact(_ provider: String) -> Bool {
  switch provider.lowercased() {
  case "claude", "codex", "pi":
    return true
  default:
    return false
  }
}

enum WorkContextCompactControl: Equatable {
  case hidden
  case disabled(reason: String)
  case ready
}

func workResolveContextCompactControl(
  provider: String,
  usageState: WorkContextUsageState?,
  canSend: Bool,
  pendingInput: Bool,
  turnBusy: Bool,
  openCodeCompactAvailable: Bool = false
) -> WorkContextCompactControl {
  guard canSend,
        usageState == .measured,
        (workProviderSupportsManualCompact(provider) || (provider == "opencode" && openCodeCompactAvailable))
  else {
    return .hidden
  }
  if pendingInput {
    return .disabled(reason: "Answer or decline the pending request before compacting.")
  }
  if turnBusy {
    return .disabled(reason: "Wait for this turn to finish before compacting.")
  }
  return .ready
}

struct WorkContextUsageMeter: View {
  let usage: WorkContextUsageViewModel
  @Binding var isPresented: Bool

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var ringColor: Color {
    guard let ratio = usage.ratio else { return ADEColor.textSecondary }
    if ratio >= 0.9 { return ADEColor.danger }
    if ratio >= 0.8 { return ADEColor.warning }
    return Color(red: 0.22, green: 0.74, blue: 0.97)
  }

  private var accessibilityLabel: String {
    switch usage.state {
    case .compacting:
      return "Context usage: compacting"
    case .recalculating:
      return "Context usage: recalculating"
    case .unknown:
      return "Context usage unavailable"
    case .measured:
      return percent.map { "Context usage: \($0)% full" } ?? "Context usage"
    }
  }

  var body: some View {
    if usage.state != .measured || usage.ratio != nil || usage.usedTokens != nil {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          isPresented.toggle()
        }
      } label: {
        ZStack {
          if usage.state != .measured {
            Circle()
              .stroke(Color.white.opacity(0.12), lineWidth: 1.5)
              .frame(width: 22, height: 22)
            Text(usage.state == .unknown ? "?" : "…")
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .foregroundStyle(ADEColor.textSecondary)
          } else if let ratio = usage.ratio, let percent {
            Circle()
              .stroke(Color.white.opacity(0.10), lineWidth: 2.5)
              .frame(width: 22, height: 22)

            Circle()
              .trim(from: 0, to: CGFloat(ratio))
              .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .frame(width: 22, height: 22)

            if let point = usage.compactAtTokens, let window = usage.contextWindow, window > 0 {
              let fraction = min(1, max(0, Double(point) / Double(window)))
              Rectangle().fill(ADEColor.warning).frame(width: 1.5, height: 5)
                .offset(y: -11).rotationEffect(.degrees(fraction * 360))
            }

            Text("\(percent)")
              .font(.system(size: percent >= 100 ? 7 : 8, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textPrimary.opacity(0.78))
              .minimumScaleFactor(0.65)
          } else if let usedTokens = usage.usedTokens {
            Text(workAbbreviateCount(usedTokens))
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textSecondary)
              .minimumScaleFactor(0.7)
          }
        }
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityHint(isPresented ? "Dismisses context usage details" : "Shows context usage details")
      .adeInspectable(
        "Work.Chat.Composer.ContextUsageMeter",
        metadata: [
          "label": percent.map { "Context usage: \($0)% full" } ?? "Context usage",
          "role": "button"
        ]
      )
    }
  }
}

/// What the composer's context meter draws: the desktop `ContextUsageDial`
/// that sits in the composer, with the compact action in its popover.
struct WorkComposerContextMeterModel: Equatable {
  let usage: WorkContextUsageViewModel
  let modelLabel: String?
  let compact: WorkContextCompactControl
  var sessionId: String? = nil
}

/// The composer's context meter: the ring, and the usage popover it opens.
struct WorkComposerContextMeter: View {
  let model: WorkComposerContextMeterModel
  let onCompact: (() -> Void)?

  @State private var presented = false

  var body: some View {
    WorkContextUsageMeter(usage: model.usage, isPresented: $presented)
      .popover(
        isPresented: $presented,
        attachmentAnchor: .rect(.bounds),
        arrowEdge: .bottom
      ) {
        WorkContextUsagePopover(
          usage: model.usage,
          modelLabel: model.modelLabel,
          compact: model.compact,
          sessionId: model.sessionId,
          onCompact: {
            presented = false
            onCompact?()
          }
        )
        .presentationCompactAdaptation(.popover)
        .presentationBackground(ADEColor.surfaceBackground)
      }
  }
}

struct WorkContextUsagePopover: View {
  let usage: WorkContextUsageViewModel
  let modelLabel: String?
  var compact: WorkContextCompactControl = .hidden
  var sessionId: String? = nil
  @State private var settingsPresented = false
  var onCompact: (() -> Void)? = nil

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var windowLabel: String? {
    usage.contextWindow.map { workAbbreviateCount($0) }
  }

  private var usedLabel: String? {
    usage.usedTokens.map { workAbbreviateCount($0) }
  }

  private var description: String {
    if usage.state == .compacting {
      return "The runtime is compacting this chat. The previous exact reading is temporarily hidden."
    }
    if usage.state == .recalculating {
      return "Compaction finished. ADE is waiting for the next authoritative usage snapshot."
    }
    if usage.state == .unknown {
      return "The runtime did not return an authoritative context reading."
    }
    let model = modelLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let percent, let windowLabel {
      let owner: String
      if let model, !model.isEmpty {
        owner = "\(model)'s "
      } else {
        owner = "the "
      }
      let estimated = usage.windowSource == .registry ? " (estimated)" : ""
      return "Using \(percent)% of \(owner)\(windowLabel)-token context window\(estimated)."
    }
    let used = usedLabel ?? "--"
    if let model, !model.isEmpty {
      return "\(used) tokens used so far by \(model); context window unknown."
    }
    return "\(used) tokens used so far; context window unknown."
  }

  private var breakdown: String? {
    guard usage.state == .measured else { return nil }
    var segments: [String] = []
    if let value = usage.inputTokens { segments.append("in \(workAbbreviateCount(value))") }
    if let value = usage.outputTokens { segments.append("out \(workAbbreviateCount(value))") }
    if let value = usage.cacheReadTokens { segments.append("cached \(workAbbreviateCount(value)) *") }
    if let value = usage.reasoningTokens { segments.append("reasoning \(workAbbreviateCount(value))") }
    return segments.isEmpty ? nil : segments.joined(separator: " · ")
  }

  private var effect: String? {
    guard let percent, let windowLabel else { return nil }
    return "\(usedLabel ?? "--") / \(windowLabel) tokens · \(percent)% full"
  }

  private var compactAvailable: Bool {
    if case .hidden = compact { return false }
    return true
  }

  private var compactDisabledReason: String? {
    if case .disabled(let reason) = compact { return reason }
    return nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Context usage")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      Text("\(usedLabel ?? "Unknown") of \(windowLabel ?? "unknown") used" + (usage.compactAtTokens.map { " · compacts at \(workAbbreviateCount($0))" } ?? ""))
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
      if usage.compactAtTokens != nil {
        Text(usage.compactAtSource == "setting" ? "Your setting" : "\(usage.provider.capitalized) default")
          .font(.caption2).foregroundStyle(ADEColor.textMuted)
      }

      Text(description)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if breakdown != nil || effect != nil {
        Rectangle()
          .fill(ADEColor.border.opacity(0.35))
          .frame(height: 1)
      }

      if let breakdown {
        Text(breakdown)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let effect {
        Text(effect)
          .font(.caption.monospacedDigit())
          .foregroundStyle((usage.ratio ?? 0) >= 0.8 ? ADEColor.warning : ADEColor.success)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }

      if usage.state == .measured, let ratio = usage.ratio, ratio >= 0.8 {
        Text(
          compactAvailable
            ? "Nearing the limit."
            : "Nearing the limit; older context may be auto-trimmed or compacted."
        )
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let sessionId {
        Button("Provider compaction setting") { settingsPresented = true }
          .font(.caption).foregroundStyle(ADEColor.accent)
          .sheet(isPresented: $settingsPresented) {
            WorkProviderCompactionSettings(provider: usage.provider, sessionId: sessionId)
          }
      }
      if compactAvailable {
        if let compactDisabledReason {
          Text(compactDisabledReason)
            .font(.caption2)
            .foregroundStyle(ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
        }

        Button {
          onCompact?()
        } label: {
          Text("Compact now")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(compactDisabledReason == nil ? ADEColor.accent : ADEColor.textMuted)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
              ADEColor.cardBackground.opacity(0.62),
              in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(
                  compactDisabledReason == nil ? ADEColor.accent.opacity(0.28) : ADEColor.border.opacity(0.45),
                  lineWidth: 1
                )
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(compactDisabledReason != nil || onCompact == nil)
        .accessibilityLabel("Compact context")
        .accessibilityHint("Summarizes for the model. Your visible chat stays.")
        .adeInspectable(
          "Work.Chat.Composer.CompactContext",
          metadata: [
            "label": "Compact context",
            "role": "button",
            "disabled": compactDisabledReason == nil ? "false" : "true"
          ]
        )

        Text("Summarizes for the model. Your visible chat stays.")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .frame(minWidth: 240, idealWidth: 300, maxWidth: 320, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("Work.Chat.Composer.ContextUsagePopover")
  }
}


struct WorkCompactFirstOffer: Equatable {
  let endedAt: Date
  let contextTokens: Int
  let estimatedPostTokens: Int
  let mode: String
  func isEligible(at now: Date) -> Bool { now.timeIntervalSince(endedAt) >= 3600 }
}

struct WorkCompactFirstPill: View {
  let offer: WorkCompactFirstOffer
  @Binding var choice: Bool?
  var body: some View {
    TimelineView(.periodic(from: offer.endedAt.addingTimeInterval(3600), by: 60)) { context in
      if offer.isEligible(at: context.date) {
        let enabled = choice ?? (offer.mode == "always")
        Button { choice = !enabled } label: {
          Text("Compact first · \(workAbbreviateCount(offer.contextTokens))")
            .font(.caption2).padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(enabled ? ADEColor.accent : ADEColor.textSecondary)
            .background((enabled ? ADEColor.accent : ADEColor.textMuted).opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityValue(enabled ? "On" : "Off")
        .help("The cache expired after an hour. Compacting first re-sends about \(workAbbreviateCount(offer.estimatedPostTokens)) tokens instead of \(workAbbreviateCount(offer.contextTokens)).")
      }
    }
    .onChange(of: offer.endedAt) { _, _ in choice = nil }
  }
}


/// Provider defaults are the same project config the desktop and web settings edit.
struct WorkProviderCompactionSettings: View {
  let provider: String
  let sessionId: String
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @State private var settings: [String: Any] = [:]
  @State private var tokens = ""
  @State private var idleMode = "ask"
  @State private var enabled = true
  @State private var loading = true
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      Form {
        if provider == "claude" {
          Toggle("Auto-compact", isOn: $enabled)
          Picker("Auto-compact at", selection: $tokens) {
            Text("Auto (recommended)").tag("")
            ForEach(1...10, id: \.self) { step in Text(workAbbreviateCount(step * 100_000)).tag(String(step * 100_000)) }
          }
          Picker("After an hour idle", selection: $idleMode) {
            Text("Ask (pill)").tag("ask")
            Text("Always compact first").tag("always")
            Text("Never").tag("never")
          }
        } else if provider == "codex" {
          TextField("Auto-compact at (default if empty)", text: $tokens).keyboardType(.numberPad)
        } else if provider == "opencode" || provider == "pi" {
          Toggle("Auto-compact", isOn: $enabled)
        } else {
          Text("This provider compacts by itself. ADE cannot change when.")
        }
        Text("Provider default. Account overrides still apply. Changes apply at the next query start.").font(.caption).foregroundStyle(ADEColor.textSecondary)
        if let errorMessage { Text(errorMessage).foregroundStyle(ADEColor.warning) }
      }
      .disabled(loading)
      .navigationTitle("\(provider.capitalized) compaction")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(loading) }
      }
      .task { await load() }
    }
  }
  @MainActor private func load() async {
    defer { loading = false }
    do {
      let scope = syncService.chatCommandScope(for: sessionId)
      let result = try await syncService.sendCommand(action: "projectConfig.get", args: [:], targetProjectId: scope.projectId, targetProjectRootPath: scope.rootPath) as? [String: Any]
      let effective = result?["effective"] as? [String: Any]
      let ai = effective?["ai"] as? [String: Any]
      let compaction = ai?["compaction"] as? [String: Any]
      settings = compaction?[provider] as? [String: Any] ?? [:]
      tokens = (settings["atTokens"] as? Int).map(String.init) ?? ""
      idleMode = settings["idleMode"] as? String ?? "ask"
      enabled = settings["enabled"] as? Bool ?? true
    } catch { errorMessage = error.localizedDescription }
  }
  @MainActor private func save() async {
    loading = true
    defer { loading = false }
    var value = settings
    value["enabled"] = enabled
    if provider == "claude" || provider == "codex" {
      if !tokens.isEmpty {
        guard let number = Int(tokens), number > 0 else { errorMessage = "Enter a positive token count."; return }
        value["atTokens"] = number
      } else { value["atTokens"] = NSNull() }
    }
    if provider == "claude" { value["idleMode"] = idleMode }
    do {
      let scope = syncService.chatCommandScope(for: sessionId)
      _ = try await syncService.sendCommand(action: "ai.updateConfig", args: ["compaction": [provider: value]], targetProjectId: scope.projectId, targetProjectRootPath: scope.rootPath)
      dismiss()
    } catch { errorMessage = error.localizedDescription }
  }
}
