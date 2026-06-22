import AppIntents
import SwiftUI

/// Presented as a `medium`/`large` sheet from any root screen when the user
/// taps `AttentionDrawerButton`. Groups every pending attention item by
/// kind and offers the same action chips as the lock-screen card.
@available(iOS 17.0, *)
struct AttentionDrawerSheet: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: AttentionDrawerModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Sections are rendered in this fixed priority order so the UI feels
    // consistent even as counts shift.
    private static let sectionOrder: [AttentionKind] = [
        .awaitingInput, .failed, .ciFailing, .reviewRequested, .mergeReady,
    ]

    var body: some View {
        NavigationStack {
            Group {
                if drawer.items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Attention")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear all") {
                        drawer.clearVisibleItems()
                    }
                    .disabled(drawer.items.isEmpty)
                }
            }
            .adeScreenBackground()
            .adeNavigationGlass()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { drawer.markAllSeen() }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            ZStack {
                // Radial purple bloom behind the disc — signals the "PRs / attention" surface.
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                PrGlassPalette.purple.opacity(0.30),
                                PrGlassPalette.purple.opacity(0.0),
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 56
                        )
                    )
                    .frame(width: 120, height: 120)
                    .blur(radius: 10)

                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 64, height: 64)
                    .overlay(
                        Circle()
                            .strokeBorder(
                                PrGlassPalette.accentGradient,
                                lineWidth: 1
                            )
                            .opacity(0.6)
                    )
                    .shadow(color: PrGlassPalette.purple.opacity(0.25), radius: 10, x: 0, y: 4)

                Image(systemName: "sparkles")
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(PrGlassPalette.purple.opacity(0.95))
                    .modifier(DrawerPulseEffect(active: !reduceMotion))
            }

            VStack(spacing: 6) {
                Text("No pending items")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("All agents are running smoothly.")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No pending attention items. All agents are running smoothly.")
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(Self.sectionOrder, id: \.self) { kind in
                    let subset = drawer.items.filter { $0.kind == kind }
                    if !subset.isEmpty {
                        section(kind: kind, items: subset)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func section(kind: AttentionKind, items: [AttentionItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AttentionBadge(kind: kind, size: 20, pulse: false)
                Text(Self.label(for: kind))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("\(items.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(ADEColor.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(.ultraThinMaterial)
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 10) {
                ForEach(items) { item in
                    AttentionDrawerCard(item: item) {
                        follow(item)
                    }
                }
            }
        }
    }

    // MARK: - Deep-link

    private func follow(_ item: AttentionItem) {
        guard let url = item.deepLink else { return }
        drawer.markAllSeen()
        dismiss()
        // Small delay so the sheet finishes dismissing before the tab
        // switch animation fires — otherwise the system cross-fades the
        // two transitions and the destination push feels jittery.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            DeepLinkRouter.shared.handle(url)
        }
    }

    private static func label(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput:   return "Awaiting input"
        case .failed:          return "Failed"
        case .ciFailing:       return "CI failing"
        case .reviewRequested: return "Review requested"
        case .mergeReady:      return "Merge ready"
        }
    }
}

/// Lightweight attention card used inside the drawer. Shares the visual
/// language of the lock-screen `AttentionCard` (tinted bg, thin border,
/// badge + copy + action row) but lives inline here so the drawer is
/// self-contained and doesn't drag the widget target's card into the app.
@available(iOS 17.0, *)
private struct AttentionDrawerCard: View {
    let item: AttentionItem
    let onTap: () -> Void

    var body: some View {
        let tint = AttentionIcon.tint(for: item.kind)

        VStack(alignment: .leading, spacing: 10) {
            Button(action: onTap) {
                HStack(alignment: .top, spacing: 12) {
                    AttentionBadge(kind: item.kind, size: 30, pulse: item.kind == .awaitingInput)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(item.subtitle)
                            .font(.caption)
                            .foregroundStyle(ADEColor.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)

                    if let slug = item.providerSlug {
                        BrandDot(slug: slug, size: 10, pulse: false)
                            .padding(.top, 4)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.title). \(item.subtitle)")
            .accessibilityHint(item.deepLink == nil ? "" : "Opens the related surface.")

            AttentionDrawerActionRow(item: item, open: onTap)
        }
        .padding(14)
        .background(cardBackground(tint: tint))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.06), .clear],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .allowsHitTesting(false)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            tint.opacity(0.32),
                            tint.opacity(0.10),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.75
                )
        )
        .shadow(color: Color.black.opacity(0.18), radius: 3, x: 0, y: 1)
        .accessibilityElement(children: .contain)
    }

    private func cardBackground(tint: Color) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(ADEColor.cardBackground.opacity(0.98))
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(tint.opacity(0.045))
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(
                    RadialGradient(
                        colors: [tint.opacity(0.06), tint.opacity(0.0)],
                        center: .topLeading,
                        startRadius: 0,
                        endRadius: 180
                    )
                )
        }
    }
}

@available(iOS 17.0, *)
private struct AttentionDrawerActionRow: View {
    let item: AttentionItem
    let open: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            switch item.kind {
            case .awaitingInput:
                let canAnswerInline = !(item.itemId ?? "").isEmpty
                if canAnswerInline {
                    Button(intent: ApproveSessionIntent(sessionId: item.sessionId ?? "", itemId: item.itemId ?? "")) {
                        AttentionDrawerActionLabel("Approve", systemImage: "checkmark", variant: .primary(ADEColor.success))
                    }
                    .buttonStyle(.plain)

                    Button(intent: DenySessionIntent(sessionId: item.sessionId ?? "", itemId: item.itemId ?? "")) {
                        AttentionDrawerActionLabel("Deny", systemImage: "xmark", variant: .danger)
                    }
                    .buttonStyle(.plain)
                }

                Button(action: open) {
                    AttentionDrawerActionLabel(canAnswerInline ? "Reply" : "Open session", systemImage: "text.bubble", variant: .secondary)
                }
                .buttonStyle(.plain)

            case .failed:
                Button(action: open) {
                    AttentionDrawerActionLabel("Open agent", systemImage: "arrow.right", variant: .primary(ADEColor.accent))
                }
                .buttonStyle(.plain)

                Button(intent: RestartSessionIntent(sessionId: item.sessionId ?? "")) {
                    AttentionDrawerActionLabel("Restart", systemImage: "arrow.uturn.backward", variant: .secondary)
                }
                .buttonStyle(.plain)

            case .ciFailing:
                Button(action: open) {
                    AttentionDrawerActionLabel(prLabel("Open"), systemImage: "arrow.triangle.branch", variant: .primary(ADEColor.accent))
                }
                .buttonStyle(.plain)

                Button(intent: RetryCheckIntent(prNumber: item.prNumber ?? 0, prId: item.prId ?? "")) {
                    AttentionDrawerActionLabel("Rerun CI", systemImage: "arrow.uturn.backward", variant: .secondary)
                }
                .buttonStyle(.plain)

            case .reviewRequested:
                Button(action: open) {
                    AttentionDrawerActionLabel(prLabel("Review"), systemImage: "eye", variant: .primary(ADEColor.accent))
                }
                .buttonStyle(.plain)

            case .mergeReady:
                Button(action: open) {
                    AttentionDrawerActionLabel(prLabel("Merge"), systemImage: "checkmark.seal", variant: .primary(ADEColor.success))
                }
                .buttonStyle(.plain)

                Button(action: open) {
                    AttentionDrawerActionLabel("View", systemImage: "arrow.right", variant: .secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func prLabel(_ verb: String) -> String {
        if let number = item.prNumber, number > 0 {
            return "\(verb) #\(number)"
        }
        return "\(verb) PR"
    }
}

@available(iOS 17.0, *)
private enum AttentionDrawerActionVariant {
    case primary(Color)
    case secondary
    case danger

    var foreground: Color {
        switch self {
        case .primary(let tint): return tint
        case .secondary: return ADEColor.textPrimary
        case .danger: return ADEColor.danger
        }
    }

    var background: Color {
        switch self {
        case .primary(let tint): return tint.opacity(0.18)
        case .secondary: return ADEColor.surfaceBackground.opacity(0.72)
        case .danger: return ADEColor.danger.opacity(0.14)
        }
    }

    var stroke: Color {
        switch self {
        case .primary(let tint): return tint.opacity(0.32)
        case .secondary: return ADEColor.glassBorder
        case .danger: return ADEColor.danger.opacity(0.30)
        }
    }
}

@available(iOS 17.0, *)
private struct AttentionDrawerActionLabel: View {
    let title: String
    let systemImage: String?
    let variant: AttentionDrawerActionVariant

    init(
        _ title: String,
        systemImage: String? = nil,
        variant: AttentionDrawerActionVariant
    ) {
        self.title = title
        self.systemImage = systemImage
        self.variant = variant
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
        }
        .foregroundStyle(variant.foreground)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .padding(.horizontal, 10)
        .background(variant.background, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(variant.stroke, lineWidth: 0.6)
        )
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

@available(iOS 17.0, *)
private enum AttentionIcon {
    static func symbol(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput:   return "bell.badge.fill"
        case .failed:          return "xmark.octagon.fill"
        case .ciFailing:       return "exclamationmark.triangle.fill"
        case .reviewRequested: return "eye.fill"
        case .mergeReady:      return "checkmark.seal.fill"
        }
    }

    static func tint(for kind: AttentionKind) -> Color {
        switch kind {
        case .awaitingInput:   return ADESharedTheme.warningAmber
        case .failed:          return ADESharedTheme.statusFailed
        case .ciFailing:       return ADESharedTheme.statusFailed
        case .reviewRequested: return ADESharedTheme.warningAmber
        case .mergeReady:      return ADESharedTheme.statusSuccess
        }
    }
}

@available(iOS 17.0, *)
private struct AttentionBadge: View {
    let kind: AttentionKind
    let size: CGFloat
    let pulse: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = AttentionIcon.tint(for: kind)
        ZStack {
            Circle()
                .fill(color.opacity(0.13))
                .frame(width: size, height: size)

            if pulse && kind == .awaitingInput && !reduceMotion {
                Circle()
                    .stroke(color, lineWidth: 1.5)
                    .frame(width: size, height: size)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.5)
                            .opacity(phase == 0 ? 0.9 : 0)
                    } animation: { _ in
                        .easeOut(duration: 1.6)
                    }
            }

            Image(systemName: AttentionIcon.symbol(for: kind))
                .font(.system(size: size * 0.5, weight: .semibold))
                .foregroundStyle(color)
                .modifier(BellWiggle(active: pulse && kind == .awaitingInput && !reduceMotion))
        }
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct BrandDot: View {
    let slug: String
    let size: CGFloat
    let pulse: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = ADESharedTheme.brandColor(for: slug)
        ZStack {
            if pulse && !reduceMotion {
                Circle()
                    .fill(color)
                    .frame(width: size, height: size)
                    .phaseAnimator([0, 1]) { circle, phase in
                        circle
                            .scaleEffect(phase == 0 ? 1.0 : 1.4)
                            .opacity(phase == 0 ? 0.35 : 0)
                    } animation: { _ in
                        .easeInOut(duration: 1.4)
                    }
            }
            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .shadow(color: color.opacity(0.4), radius: size * 0.3, x: 0, y: 0)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct BellWiggle: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.keyframeAnimator(
                initialValue: 0.0,
                repeating: true
            ) { view, rotation in
                view.rotationEffect(.degrees(rotation))
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(0, duration: 1.32)
                    CubicKeyframe(-14, duration: 0.176)
                    CubicKeyframe(12, duration: 0.176)
                    CubicKeyframe(-8, duration: 0.176)
                    CubicKeyframe(5, duration: 0.176)
                    CubicKeyframe(0, duration: 0.176)
                }
            }
        } else {
            content
        }
    }
}

/// `.symbolEffect(.pulse)` is gated behind Reduce Motion — when the user has
/// that system setting on, the glyph renders statically.
@available(iOS 17.0, *)
private struct DrawerPulseEffect: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.symbolEffect(.pulse, options: .repeating)
        } else {
            content
        }
    }
}
