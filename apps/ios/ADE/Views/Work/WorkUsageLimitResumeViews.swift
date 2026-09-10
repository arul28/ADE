import SwiftUI

/// The usage-limit resume pill and its bottom sheet.
///
/// Replaces the old amber `WorkUsageLimitBanner`. A usage limit is a wait with a
/// scheduled end, not a failure, so the pill is a neutral card-tinted capsule —
/// no warning hue, no exclamation, one line. Everything actionable lives behind
/// a tap, which keeps the composer's neighbourhood calm while a chat is parked.

// MARK: - Pill

struct WorkUsageLimitResumePill: View {
  let model: WorkUsageLimitResumeModel
  /// Disables the sheet's actions (offline host, or another action in flight).
  var enabled: Bool = true
  var onResumeNow: (@MainActor () async -> Void)? = nil
  var onFork: (@MainActor () async -> Void)? = nil
  /// `chat.updateSession { autoContinueAtUsageLimit: }` — false for Don't
  /// continue, true for Try again / Turn on.
  var onSetAutoContinue: (@MainActor (Bool) async -> Void)? = nil

  @State private var sheetPresented = false
  /// Drives the countdown. Seeded once and stepped by the adaptive ticker below
  /// so the label is never redrawn faster than it can actually change.
  @State private var now = Date()

  private var label: String { workUsageLimitPillLabel(model, now: now) }

  var body: some View {
    Button {
      sheetPresented = true
    } label: {
      HStack(spacing: 7) {
        Image(systemName: workUsageLimitPillGlyph(model.state))
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        Text(label)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        Image(systemName: "chevron.up")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(minHeight: 44)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        ADEColor.cardBackground.opacity(0.72),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.3), lineWidth: 0.8)
      )
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(workUsageLimitPillAccessibilityLabel(model, now: now))
    .accessibilityHint("Opens usage limit options.")
    .task(id: model) { await runCountdownTicker() }
    .sheet(isPresented: $sheetPresented) {
      WorkUsageLimitResumeSheet(
        model: model,
        enabled: enabled,
        onResumeNow: onResumeNow,
        onFork: onFork,
        onSetAutoContinue: onSetAutoContinue
      )
    }
  }

  /// One timer, two rates: per second inside the last five minutes, per minute
  /// above it. A pill with nothing to count down to never starts a timer at all.
  private func runCountdownTicker() async {
    now = Date()
    guard model.countdownTarget != nil else { return }
    while !Task.isCancelled {
      let interval = workUsageLimitTickInterval(fireAt: model.countdownTarget, now: now)
      do {
        try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
      } catch {
        return
      }
      now = Date()
    }
  }
}

// MARK: - Sheet

struct WorkUsageLimitResumeSheet: View {
  let model: WorkUsageLimitResumeModel
  var enabled: Bool = true
  var onResumeNow: (@MainActor () async -> Void)? = nil
  var onFork: (@MainActor () async -> Void)? = nil
  var onSetAutoContinue: (@MainActor (Bool) async -> Void)? = nil

  @Environment(\.dismiss) private var dismiss
  @State private var actionInFlight = false
  @State private var detailsExpanded = false
  @State private var now = Date()

  private var primaryAction: WorkUsageLimitResumePrimaryAction {
    workUsageLimitPrimaryAction(model.state)
  }

  private var controlsEnabled: Bool { enabled && !actionInFlight }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text(workUsageLimitSheetTitle(model))
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)

        VStack(alignment: .leading, spacing: 6) {
          ForEach(Array(workUsageLimitSheetBodyLines(model, now: now).enumerated()), id: \.offset) { _, line in
            Text(line)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        if let detail = model.providerDetail {
          detailsDisclosure(detail)
        }

        VStack(spacing: 8) {
          if showsPrimaryButton {
            primaryButton
          }
          forkButton
          if workUsageLimitShowsOptOut(model.state), onSetAutoContinue != nil {
            optOutButton
          }
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 22)
      .padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(ADEColor.surfaceBackground)
    // A height detent keeps this a quiet sheet rather than a full takeover;
    // `.large` stays available so the largest Dynamic Type sizes still have
    // somewhere to go.
    .presentationDetents([.height(sheetHeight), .large])
    .presentationDragIndicator(.visible)
    .onAppear { now = Date() }
  }

  /// `Resume now` is hidden — not greyed — when the paired host predates
  /// `chat.resumeUsageLimitNow`: there is no version of this session where that
  /// button becomes tappable, and a permanently dead primary reads as a bug.
  /// `Try again` / `Turn on` keep the disabled treatment, because they only
  /// lose their handler transiently.
  private var showsPrimaryButton: Bool {
    workUsageLimitShowsPrimaryButton(
      state: model.state,
      hasResumeNowAction: onResumeNow != nil
    )
  }

  private var sheetHeight: CGFloat {
    var height: CGFloat = 300
    if model.providerDetail != nil { height += 44 }
    if !workUsageLimitShowsOptOut(model.state) || onSetAutoContinue == nil { height -= 52 }
    if !showsPrimaryButton { height -= 52 }
    return height
  }

  private var primaryButton: some View {
    Button {
      switch primaryAction {
      case .resumeNow:
        run { await onResumeNow?() }
      case .tryAgain, .turnOn:
        run { await onSetAutoContinue?(true) }
      }
    } label: {
      buttonLabel(primaryAction.label, filled: true)
    }
    .buttonStyle(.plain)
    .disabled(!controlsEnabled || primaryActionUnavailable)
    .opacity(primaryActionUnavailable ? 0.5 : 1)
    .accessibilityLabel(primaryAction.label)
    .accessibilityHint(primaryAction.hint)
  }

  // Resume now is hidden, not dimmed, when `onResumeNow` is missing — it is
  // never the primary action without its handler, so only the other two dim.
  private var primaryActionUnavailable: Bool {
    primaryAction != .resumeNow && onSetAutoContinue == nil
  }

  private var forkButton: some View {
    Button {
      run { await onFork?() }
    } label: {
      buttonLabel("Fork in this lane", filled: false)
    }
    .buttonStyle(.plain)
    .disabled(!controlsEnabled || onFork == nil)
    .opacity(onFork == nil ? 0.5 : 1)
    .accessibilityLabel("Fork in this lane")
    .accessibilityHint("Starts a copy of this chat in the same lane so you can keep working now.")
  }

  private var optOutButton: some View {
    Button {
      run { await onSetAutoContinue?(false) }
    } label: {
      Text("Don't continue")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!controlsEnabled)
    .accessibilityLabel("Don't continue")
    .accessibilityHint("Stops this chat from resuming when the usage limit resets.")
  }

  private func detailsDisclosure(_ detail: String) -> some View {
    DisclosureGroup(isExpanded: $detailsExpanded) {
      Text(detail)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 6)
    } label: {
      Text("Details")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(minHeight: 44)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    .tint(ADEColor.accent)
    .accessibilityHint("Shows the raw message from the provider.")
  }

  @ViewBuilder
  private func buttonLabel(_ title: String, filled: Bool) -> some View {
    Group {
      if actionInFlight {
        ProgressView().controlSize(.small)
      } else {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(filled ? Color.white : ADEColor.textPrimary)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 44)
    .background(
      Group {
        if filled {
          RoundedRectangle(cornerRadius: 11, style: .continuous).fill(ADEColor.accent)
        } else {
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .stroke(ADEColor.border.opacity(0.5), lineWidth: 0.8)
        }
      }
    )
    .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !actionInFlight else { return }
    actionInFlight = true
    Task { @MainActor in
      await operation()
      actionInFlight = false
      dismiss()
    }
  }
}
