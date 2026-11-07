import SwiftUI

// MARK: - Inline suggestion strip

/// Compact suggestion strip pinned directly above the composer text field. Rows
/// are filtered by the live query; tapping one splices a styled chip into the
/// draft. Visibility follows the controller's trigger state, not focus.
struct WorkComposerSuggestionStrip: View {
  @ObservedObject var controller: WorkComposerSuggestionController

  /// Rows grouped by section, in the order the controller produced them. The
  /// `@` menu has several groups; `/` and `#` have one.
  private var groups: [(section: WorkComposerSuggestionSection, rows: [WorkComposerSuggestion])] {
    var out: [(section: WorkComposerSuggestionSection, rows: [WorkComposerSuggestion])] = []
    for suggestion in controller.suggestions {
      if let last = out.last, last.section == suggestion.section {
        out[out.count - 1].rows.append(suggestion)
      } else {
        out.append((suggestion.section, [suggestion]))
      }
    }
    return out
  }

  var body: some View {
    if controller.isVisible {
      VStack(alignment: .leading, spacing: 0) {
        if controller.suggestions.isEmpty {
          header(title: fallbackTitle, symbol: fallbackSymbol, accent: ADEColor.textMuted, showsProgress: true)
          loadingRow
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
              ForEach(Array(groups.enumerated()), id: \.element.section) { index, group in
                Section {
                  ForEach(group.rows) { suggestion in
                    Button {
                      controller.commit(suggestion)
                    } label: {
                      if suggestion.modelId != nil {
                        modelRow(suggestion)
                      } else {
                        row(suggestion)
                      }
                    }
                    .buttonStyle(.plain)
                  }
                  if let hidden = controller.hiddenAtCounts[group.section], hidden > 0 {
                    moreRow(section: group.section, count: hidden)
                  }
                } header: {
                  header(
                    title: group.section.title,
                    symbol: group.section.symbolName,
                    accent: accent(for: group.section),
                    showsProgress: index == 0 && controller.isLoading
                  )
                }
              }
            }
          }
          .frame(maxHeight: 280)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.glassBackground)
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .shadow(color: Color.black.opacity(0.10), radius: 12, y: 4)
      .transition(.opacity.combined(with: .move(edge: .bottom)))
      .accessibilityIdentifier("Work.Chat.Composer.SuggestionStrip")
    } else if let chip = controller.editingModelChip, let segment = controller.editingSegment {
      WorkModelChipEditorBar(controller: controller, chip: chip, segment: segment)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
  }

  private var fallbackSymbol: String {
    switch controller.activeMatch?.kind {
    case .at: return "at"
    case .hash: return WorkComposerSuggestionSection.pullRequests.symbolName
    default: return WorkComposerSuggestionSection.commands.symbolName
    }
  }

  private var fallbackTitle: String {
    switch controller.activeMatch?.kind {
    case .at: return "Mentions"
    case .hash: return WorkComposerSuggestionSection.pullRequests.title
    default: return WorkComposerSuggestionSection.commands.title
    }
  }

  /// One colour per `@` group, the desktop menu's `SECTION_ACCENT`. The `/`
  /// and `#` menus keep the chat's provider accent.
  private func accent(for section: WorkComposerSuggestionSection) -> Color {
    guard controller.activeMatch?.kind == .at else {
      return ADEColor.providerChatAccent(for: controller.provider)
    }
    switch section {
    case .models, .commands: return ADEColor.purpleAccent
    case .chats: return Color(uiColor: .systemBlue)
    case .lanes: return ADEColor.success
    case .files: return ADEColor.warning
    case .terminals: return Color(uiColor: .systemCyan)
    case .pullRequests: return Color(uiColor: .systemIndigo)
    case .machines: return ADEColor.textSecondary
    case .mcpServers: return Color(uiColor: .systemTeal)
    }
  }

  private func header(title: String, symbol: String, accent: Color, showsProgress: Bool) -> some View {
    HStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(accent)
      Text(title.uppercased())
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      if showsProgress {
        ProgressView().controlSize(.mini)
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.ultraThinMaterial)
    .accessibilityAddTraits(.isHeader)
  }

  private var loadingRow: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.mini)
      Text(loadingCopy)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
  }

  private var loadingCopy: String {
    switch controller.activeMatch?.kind {
    case .hash: return "Searching pull requests…"
    case .at: return "Searching…"
    default: return "Loading commands…"
    }
  }

  /// A model row, like the desktop `@` menu's: the maker's mark, the name,
  /// the harness it runs through with that harness's mark, and the thinking
  /// level a new chip starts on.
  private func modelRow(_ suggestion: WorkComposerSuggestion) -> some View {
    let entry = suggestion.modelId.flatMap { WorkModelMentionDirectory.shared.entry(for: $0) }
    let harness = entry?.provider ?? ""
    return HStack(spacing: 10) {
      WorkProviderLogo(provider: entry?.brandKey, fallbackSymbol: "cpu", tint: ADEColor.purpleAccent, size: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(suggestion.title)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let subtitle = suggestion.subtitle, !subtitle.isEmpty {
          HStack(spacing: 4) {
            if !harness.isEmpty {
              WorkProviderBareLogo(
                provider: harness,
                fallbackSymbol: providerIcon(harness),
                tint: providerTint(harness),
                size: 10
              )
              .accessibilityHidden(true)
            }
            Text(subtitle)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
      }
      Spacer(minLength: 0)
      if let effort = entry?.defaultEffort {
        let tint = Color(uiColor: WorkModelChipStyle.effortTint(effort, tiers: entry?.reasoningTiers ?? []))
        Text(WorkModelMentionDetector.effortLabel(effort))
          .font(.caption2.weight(.semibold))
          .foregroundStyle(tint)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(tint.opacity(0.14), in: Capsule(style: .continuous))
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .frame(minHeight: 48)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(rowAccessibilityLabel(suggestion))
  }

  private func row(_ suggestion: WorkComposerSuggestion) -> some View {
    let tint = accent(for: suggestion.section)
    return HStack(spacing: 10) {
      Image(systemName: suggestion.symbolName)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(tint)
        .frame(width: 28, height: 28)
        .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        // Decorative: the title and subtitle already say what the row is, and
        // VoiceOver reading "arrow triangle pull" before every PR is noise.
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(suggestion.title)
          .font(suggestion.kind == .slash
            ? .footnote.weight(.semibold).monospaced()
            : .footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(suggestion.section == .files ? .middle : .tail)
        if let subtitle = suggestion.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    // A row with no subtitle (a slash command, a root-level file) is otherwise
    // barely 33pt tall. The tap target is the whole row, so it holds the 44pt
    // floor rather than the text's intrinsic height.
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityLabel(rowAccessibilityLabel(suggestion))
  }

  /// The desktop's `+ N more` row: opens the rest of one section in place.
  private func moreRow(section: WorkComposerSuggestionSection, count: Int) -> some View {
    Button {
      withAnimation(.snappy(duration: 0.2)) {
        controller.expandAtSection(section)
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.bold))
        Text("Show \(count) more")
          .font(.caption.weight(.semibold))
        Spacer(minLength: 0)
      }
      .foregroundStyle(accent(for: section))
      .padding(.leading, 50)
      .padding(.trailing, 12)
      .frame(minHeight: 34)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Show \(count) more \(section.title.lowercased())")
    .accessibilityIdentifier("Work.Chat.Composer.SuggestionMore.\(section.rawValue)")
  }

  private func rowAccessibilityLabel(_ suggestion: WorkComposerSuggestion) -> String {
    let kind: String
    switch suggestion.section {
    case .models: kind = "Model"
    case .chats: kind = "Chat"
    case .lanes: kind = "Lane"
    case .terminals: kind = "Terminal"
    case .pullRequests: kind = "Pull request"
    case .machines: kind = "Machine"
    case .mcpServers: kind = "MCP server"
    case .files: kind = suggestion.isDirectory ? "Folder" : "File"
    case .commands: kind = "Command"
    }
    let subtitle = suggestion.subtitle.map { ", \($0)" } ?? ""
    return "\(kind): \(suggestion.title)\(subtitle)"
  }
}
