import SwiftUI

// The live setup card of a chat launch. Primitives: `WorkChatLaunchViews.swift`.

// MARK: - Setup card

struct WorkChatLaunchSetupCard: View {
  let launch: ChatLaunchSnapshot
  /// Nil hides the action row (read-only surfaces).
  var actions: WorkChatLaunchCardActions? = nil
  var busyAction: WorkChatLaunchCardAction? = nil

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var environmentExpanded = false
  @State private var detailsExpanded = false
  @State private var deleteConfirmationPresented = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      WorkChatLaunchProgressRail(segments: chatLaunchRailSegments(launch.stages))
        .padding(.top, 12)
        .padding(.bottom, 4)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(launch.stages.enumerated()), id: \.element.id) { index, stage in
          if index > 0 { WorkChatLaunchHairline() }
          stageBlock(stage)
        }
      }
      if let failure = failureText {
        Text(failure)
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .padding(.top, 8)
      }
      footer
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 16, padding: 14)
    .overlay {
      if launch.phase == .failed {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(ADEColor.warning.opacity(0.28), lineWidth: 1)
          .allowsHitTesting(false)
      }
    }
    .animation(ADEMotion.quick(reduceMotion: reduceMotion), value: launch.stages)
    .animation(ADEMotion.quick(reduceMotion: reduceMotion), value: launch.phase)
    .confirmationDialog(
      "Delete this lane and chat?",
      isPresented: $deleteConfirmationPresented,
      titleVisibility: .visible
    ) {
      Button("Delete lane and chat", role: .destructive) {
        actions?.onDelete()
      }
      Button("Keep", role: .cancel) {}
    } message: {
      Text("The lane's branch, worktree, and this chat are removed.")
    }
    .accessibilityElement(children: .contain)
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      WorkChatLaunchStageTile(symbol: headerSymbol, status: WorkChatLaunchTone.phaseStatus(launch), size: 26)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(chatLaunchCardTitle(launch))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(
              launch.phase == .failed || chatLaunchCompletedWithWarnings(launch) ? ADEColor.warning : ADEColor.textPrimary
            )
            .lineLimit(1)
            .contentTransition(.opacity)
          Spacer(minLength: 8)
          WorkChatLaunchDurationText(
            startedAt: launch.startedAt,
            endedAt: launch.endedAt,
            isLive: launch.endedAt == nil && (launch.phase == .running || launch.phase == .awaitingClient)
          )
          .accessibilityLabel("Elapsed")
        }
        chips
      }
    }
  }

  private var headerSymbol: String {
    switch launch.phase {
    case .failed: return "exclamationmark.triangle.fill"
    case .cancelled: return "minus"
    case .completed: return chatLaunchCompletedWithWarnings(launch) ? "exclamationmark.triangle.fill" : "checkmark"
    case .running, .awaitingClient: return chatLaunchLaneIsReady(launch) ? "checkmark" : "arrow.branch"
    }
  }

  private var chips: some View {
    HStack(spacing: 6) {
      let name = launch.laneName.trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty {
        chip(mono: false) {
          WorkLaneLogoMark(color: WorkChatLaunchTone.running, size: 9)
          Text(name)
            .lineLimit(1)
            .truncationMode(.middle)
            .contentTransition(.opacity)
          if launch.laneNaming {
            ProgressView()
              .controlSize(.mini)
              .scaleEffect(0.6)
              .frame(width: 10, height: 10)
              .accessibilityLabel("Naming lane")
          }
        }
        .layoutPriority(1)
        .accessibilityLabel("Lane \(name)")
      }
      if let base = chatLaunchBaseLabel(launch) {
        chip(mono: true) {
          Image(systemName: "arrow.triangle.branch")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          Text(base)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .accessibilityLabel("Base \(base)")
      }
    }
  }

  private func chip<Content: View>(mono: Bool, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 4) {
      content()
    }
    .font(mono ? .caption2.monospaced() : .caption2.weight(.medium))
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 7)
    .padding(.vertical, 2.5)
    .background(ADEColor.recessedBackground.opacity(0.5), in: Capsule(style: .continuous))
    .overlay(Capsule(style: .continuous).strokeBorder(ADEColor.glassBorder, lineWidth: 1))
  }

  // MARK: Stages

  @ViewBuilder
  private func stageBlock(_ stage: ChatLaunchStage) -> some View {
    let steps = stage.steps ?? []
    let autoShowsSteps = stage.status == .running || stage.status == .failed
    let expandable = stage.id == .environment && !steps.isEmpty && !autoShowsSteps
    let showsSteps = stage.id == .environment && !steps.isEmpty && (autoShowsSteps || environmentExpanded)
    VStack(alignment: .leading, spacing: 0) {
      WorkChatLaunchStageRow(
        stage: stage,
        kind: launch.kind,
        templateName: launch.templateName,
        isExpandable: expandable,
        isExpanded: environmentExpanded,
        onToggle: {
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            environmentExpanded.toggle()
          }
        }
      )
      if showsSteps {
        WorkChatLaunchEnvironmentSteps(steps: steps)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
      if stage.status == .failed || stage.status == .warning,
         let error = stage.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty,
         error != launch.error?.trimmingCharacters(in: .whitespacesAndNewlines) {
        Text(error)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(ADEColor.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
              .strokeBorder(ADEColor.warning.opacity(0.18), lineWidth: 1)
          )
          .padding(.leading, 32)
          .padding(.bottom, 6)
      }
    }
  }

  // MARK: Failure + details

  private var failureText: String? {
    guard launch.phase == .failed else { return nil }
    let summary = launch.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !summary.isEmpty { return summary }
    let stageError = launch.stages.first { $0.status == .failed }?.error?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return stageError.isEmpty ? nil : stageError
  }

  private var detailItems: [WorkChatLaunchDetailItem] {
    var items: [WorkChatLaunchDetailItem] = []
    func add(_ label: String, _ value: String?, _ style: WorkChatLaunchDetailItem.Style) {
      let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !trimmed.isEmpty { items.append(WorkChatLaunchDetailItem(label: label, value: trimmed, style: style)) }
    }
    add("Branch", launch.branchRef.map { $0.hasPrefix("refs/heads/") ? String($0.dropFirst("refs/heads/".count)) : $0 }, .mono)
    add("Base", launch.baseRef, .mono)
    add("Worktree", launch.worktreePath, .mono)
    add("Template", launch.templateName, .prose)
    add("Error", launch.phase == .failed ? launch.error : nil, .error)
    return items
  }

  /// Details toggle on the left, text actions on the right, over a hairline.
  @ViewBuilder
  private var footer: some View {
    let items = detailItems
    let available = actions == nil ? [] : availableActions
    if !items.isEmpty || !available.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        if detailsExpanded, !items.isEmpty {
          detailsList(items)
            .padding(.top, 8)
            .transition(.opacity)
        }
        WorkChatLaunchHairline()
          .padding(.top, 8)
        HStack(spacing: 6) {
          if !items.isEmpty {
            Button {
              withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
                detailsExpanded.toggle()
              }
            } label: {
              HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                  .font(.system(size: 8, weight: .bold))
                  .rotationEffect(.degrees(detailsExpanded ? 90 : 0))
                Text("Details")
                  .font(.caption.weight(.medium))
              }
              .foregroundStyle(ADEColor.textMuted)
              .padding(.vertical, 6)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(detailsExpanded ? "Hide details" : "Show details")
          }
          Spacer(minLength: 0)
          if let actions {
            ForEach(available, id: \.self) { action in
              actionButton(action, actions: actions)
            }
          }
        }
        .padding(.top, 6)
      }
    }
  }

  private func detailsList(_ items: [WorkChatLaunchDetailItem]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(item.label)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 58, alignment: .leading)
          Text(item.value)
            .font(item.style == .mono ? .caption2.monospaced() : .caption2)
            .foregroundStyle(item.style == .error ? ADEColor.warning : ADEColor.textSecondary)
            .lineLimit(item.style == .error ? 6 : 2)
            .truncationMode(.middle)
            .textSelection(.enabled)
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.recessedBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(ADEColor.glassBorder, lineWidth: 1)
    )
  }

  // MARK: Actions

  private var availableActions: [WorkChatLaunchCardAction] {
    workChatLaunchCardActions(launch)
  }

  private func actionButton(_ action: WorkChatLaunchCardAction, actions: WorkChatLaunchCardActions) -> some View {
    let isBusy = busyAction == action
    let isPrimary = action == .retry || action == .startNow
    return Button {
      switch action {
      case .cancel, .delete:
        deleteConfirmationPresented = true
      case .retry:
        actions.onRetry()
      case .startNow, .startAnyway:
        actions.onStartNow()
      }
    } label: {
      HStack(spacing: 4) {
        if isBusy {
          ProgressView()
            .controlSize(.mini)
        } else {
          Image(systemName: action.symbol)
            .font(.system(size: 9, weight: .bold))
        }
        Text(action.title)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(isPrimary ? WorkChatLaunchTone.running : ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(isPrimary ? WorkChatLaunchTone.running.opacity(0.12) : Color.clear, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(isPrimary ? WorkChatLaunchTone.running.opacity(0.32) : ADEColor.glassBorder, lineWidth: 1)
      )
      .contentShape(Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(busyAction != nil)
  }
}

enum WorkChatLaunchCardAction: Hashable {
  case cancel
  case startNow
  case retry
  case startAnyway
  case delete

  var title: String {
    switch self {
    case .cancel: return "Cancel"
    case .startNow: return "Start now"
    case .retry: return "Retry"
    case .startAnyway: return "Start anyway"
    case .delete: return "Delete"
    }
  }

  var symbol: String {
    switch self {
    case .cancel: return "xmark"
    case .startNow: return "bolt.fill"
    case .retry: return "arrow.clockwise"
    case .startAnyway: return "play.fill"
    case .delete: return "trash"
    }
  }
}

struct WorkChatLaunchCardActions {
  var onDelete: () -> Void
  var onRetry: () -> Void
  var onStartNow: () -> Void
}

/// Which buttons the card offers. Running: Start now (while the environment
/// runs) and Cancel. Failed: Retry, Start anyway (lane exists and the
/// environment is what failed), Delete.
func workChatLaunchCardActions(_ launch: ChatLaunchSnapshot) -> [WorkChatLaunchCardAction] {
  guard !launch.agentStarted else { return [] }
  switch launch.phase {
  case .running, .awaitingClient:
    return chatLaunchCanStartNow(launch) ? [.startNow, .cancel] : [.cancel]
  case .failed:
    return chatLaunchCanStartAnyway(launch) ? [.retry, .startAnyway, .delete] : [.retry, .delete]
  case .completed, .cancelled:
    return []
  }
}

/// One row of the setup card's Details panel; `style` (not the label text) decides how it renders.
struct WorkChatLaunchDetailItem {
  enum Style { case mono, prose, error }
  let label: String
  let value: String
  let style: Style
}
