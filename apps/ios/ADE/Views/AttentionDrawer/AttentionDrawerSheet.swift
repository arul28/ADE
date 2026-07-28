import AppIntents
import SwiftUI

/// Account-wide attention center. It renders the same priority stack whether
/// its source is the signed-in account snapshot or the current
/// `WorkspaceSnapshot` fallback.
@available(iOS 17.0, *)
struct AttentionDrawerSheet: View {
    @EnvironmentObject private var drawer: AttentionDrawerModel
    @EnvironmentObject private var accountService: AccountService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var didAppear = false

    private var needsYou: [AttentionItem] { drawer.visibleItems(in: .needsYou) }
    private var live: [AttentionItem] { drawer.visibleItems(in: .live) }
    private var recent: [AttentionItem] { drawer.visibleItems(in: .recent) }

    var body: some View {
        NavigationStack {
            Group {
                if needsYou.isEmpty && live.isEmpty && recent.isEmpty {
                    emptyState
                } else {
                    priorityStack
                }
            }
            .navigationTitle("Attention")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            drawer.markAllSeen()
                        } label: {
                            Label("Mark all seen", systemImage: "checkmark.circle")
                        }
                        Button(role: .destructive) {
                            drawer.clearVisibleItems()
                        } label: {
                            Label("Dismiss pending", systemImage: "rectangle.stack.badge.minus")
                        }
                        .disabled(needsYou.isEmpty)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Attention actions")
                }
            }
            .adeScreenBackground()
            .adeNavigationGlass()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
        .task {
            await accountService.refreshAttentionSnapshot()
            await accountService.updateAttentionPresence(
                centerVisible: true,
                visibleItemIds: visibleItemIds
            )
        }
        .onDisappear {
            Task {
                await accountService.updateAttentionPresence(
                    centerVisible: false,
                    visibleItemIds: []
                )
            }
        }
        .onChange(of: drawer.selectedProjectId) {
            Task {
                await accountService.updateAttentionPresence(
                    centerVisible: true,
                    visibleItemIds: visibleItemIds
                )
            }
        }
        .onAppear {
            guard !didAppear else { return }
            if reduceMotion {
                didAppear = true
            } else {
                withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) {
                    didAppear = true
                }
            }
        }
    }

    private var visibleItemIds: [String] {
        Array((needsYou + live + recent).map(\.id).prefix(64))
    }

    private var priorityStack: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                overview
                    .opacity(didAppear ? 1 : 0)
                    .offset(y: didAppear ? 0 : 8)

                if !drawer.projectLenses.isEmpty {
                    projectLensStrip
                }

                if !needsYou.isEmpty {
                    AttentionSectionHeader(
                        title: "Needs you",
                        count: needsYou.count,
                        systemImage: "bell.badge.fill",
                        tint: ADESharedTheme.warningAmber,
                        detail: "Decisions, failures, and reviews"
                    )

                    AttentionHeroCard(item: needsYou[0]) {
                        follow(needsYou[0])
                    } markSeen: {
                        drawer.markSeen(needsYou[0].id)
                    }

                    ForEach(needsYou.dropFirst()) { item in
                        AttentionCenterCard(item: item) {
                            follow(item)
                        } markSeen: {
                            drawer.markSeen(item.id)
                        }
                    }
                } else {
                    allCaughtUpStrip
                }

                if !live.isEmpty {
                    AttentionSectionHeader(
                        title: "Live",
                        count: live.count,
                        systemImage: "waveform.path.ecg",
                        tint: ADESharedTheme.statusRunning,
                        detail: "Work moving across your machines"
                    )

                    VStack(spacing: 0) {
                        ForEach(Array(live.enumerated()), id: \.element.id) { index, item in
                            AttentionLiveRow(item: item) {
                                follow(item)
                            }
                            if index < live.count - 1 {
                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 50)
                            }
                        }
                    }
                    .background(ADEColor.cardBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(ADEColor.glassBorder, lineWidth: 0.7)
                    )
                }

                if !recent.isEmpty {
                    AttentionSectionHeader(
                        title: "Recent",
                        count: recent.count,
                        systemImage: "clock.arrow.circlepath",
                        tint: ADEColor.textSecondary,
                        detail: "Outcomes from the last 24 hours"
                    )

                    VStack(spacing: 10) {
                        ForEach(recent) { item in
                            AttentionRecentRow(item: item) {
                                follow(item)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 34)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private var overview: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                PrGlassPalette.purple.opacity(0.34),
                                PrGlassPalette.purple.opacity(0),
                            ],
                            center: .center,
                            startRadius: 2,
                            endRadius: 42
                        )
                    )
                    .frame(width: 74, height: 74)
                    .blur(radius: 5)

                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 48, height: 48)
                    .overlay(Circle().strokeBorder(PrGlassPalette.accentGradient, lineWidth: 0.8))

                Image(systemName: "scope")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(PrGlassPalette.purple)
                    .symbolEffect(.pulse, options: reduceMotion ? .nonRepeating : .repeating)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                Text(overviewTitle)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text(overviewSubtitle)
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                    .lineLimit(2)

                HStack(spacing: 7) {
                    AttentionCountPill(count: needsYou.count, label: "need you", tint: ADESharedTheme.warningAmber)
                    AttentionCountPill(count: live.count, label: "live", tint: ADESharedTheme.statusRunning)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.18), PrGlassPalette.purple.opacity(0.12)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 0.8
                )
        )
        .accessibilityElement(children: .combine)
    }

    private var overviewTitle: String {
        if let selected = drawer.projectLenses.first(where: { $0.id == drawer.selectedProjectId }) {
            return selected.name
        }
        return "Across your work"
    }

    private var overviewSubtitle: String {
        let count = drawer.visibleMachineCount
        if count == 0 { return "Your connected projects will appear here." }
        return count == 1
            ? "One machine, every active thread in one place."
            : "\(count) machines, every active thread in one place."
    }

    private var projectLensStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ProjectLensButton(
                    title: "All projects",
                    count: drawer.projectLenses.reduce(0) { $0 + $1.itemCount },
                    selected: drawer.selectedProjectId == nil
                ) {
                    selectProject(nil)
                }

                ForEach(drawer.projectLenses) { project in
                    ProjectLensButton(
                        title: project.name,
                        count: project.itemCount,
                        selected: drawer.selectedProjectId == project.id
                    ) {
                        selectProject(project.id)
                    }
                }
            }
            .padding(.horizontal, 1)
        }
        .scrollIndicators(.hidden)
        .accessibilityLabel("Project filter")
    }

    private var allCaughtUpStrip: some View {
        HStack(spacing: 11) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(ADESharedTheme.statusSuccess)
                .symbolEffect(.bounce, value: didAppear)
            VStack(alignment: .leading, spacing: 2) {
                Text("Nothing needs you")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text(live.isEmpty ? "Everything is quiet." : "Live work is moving without a blocker.")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(13)
        .background(ADESharedTheme.statusSuccess.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(ADESharedTheme.statusSuccess.opacity(0.2), lineWidth: 0.7)
        )
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [PrGlassPalette.purple.opacity(0.30), .clear],
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
                    .overlay(Circle().strokeBorder(PrGlassPalette.accentGradient, lineWidth: 1).opacity(0.6))

                Image(systemName: "sparkles")
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(PrGlassPalette.purple.opacity(0.95))
                    .modifier(DrawerPulseEffect(active: !reduceMotion))
            }

            VStack(spacing: 6) {
                Text("All clear")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("Agent work from your connected machines will gather here.")
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
        .accessibilityLabel("All clear. No pending attention items.")
    }

    private func selectProject(_ id: String?) {
        if reduceMotion {
            drawer.selectProject(id)
        } else {
            withAnimation(.snappy(duration: 0.28)) {
                drawer.selectProject(id)
            }
        }
    }

    private func follow(_ item: AttentionItem) {
        guard let url = item.deepLink else { return }
        drawer.markSeen(item.id)
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0 : 0.18)) {
            DeepLinkRouter.shared.handle(url)
        }
    }
}

@available(iOS 17.0, *)
private struct AttentionSectionHeader: View {
    let title: String
    let count: Int
    let systemImage: String
    let tint: Color
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.headline)
                    .foregroundStyle(ADEColor.textPrimary)
                Text("\(count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(tint)
                    .contentTransition(.numericText())
                Spacer(minLength: 0)
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
        }
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }
}

@available(iOS 17.0, *)
private struct AttentionHeroCard: View {
    let item: AttentionItem
    let open: () -> Void
    let markSeen: () -> Void

    var body: some View {
        let tint = AttentionIcon.tint(for: item.kind)
        VStack(alignment: .leading, spacing: 13) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .center, spacing: 11) {
                        AttentionBadge(kind: item.kind, size: 38, pulse: item.kind == .awaitingInput)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.phaseLabel.uppercased())
                                .font(.caption2.weight(.bold).monospaced())
                                .tracking(0.6)
                                .foregroundStyle(tint)
                            Text(item.scopeLabel)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(ADEColor.textSecondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        OfflineBadge(online: item.machineOnline)
                    }

                    Text(item.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    Text(item.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(ADEColor.textSecondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 7) {
                        if let provider = item.providerSlug {
                            BrandDot(slug: provider, size: 14, pulse: item.kind == .running)
                            Text(ADESharedTheme.providerDisplayName(for: provider) ?? provider)
                        }
                        if let lane = item.laneName, !lane.isEmpty {
                            Text("·")
                            Text(lane)
                        }
                        Spacer(minLength: 0)
                        Text(item.timestamp, style: .relative)
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(ADEColor.textSecondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            AttentionDrawerActionRow(item: item, open: open, markSeen: markSeen)
        }
        .padding(16)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(ADEColor.cardBackground.opacity(0.98))
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(
                        RadialGradient(
                            colors: [tint.opacity(0.16), tint.opacity(0.02), .clear],
                            center: .topLeading,
                            startRadius: 0,
                            endRadius: 260
                        )
                    )
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [tint.opacity(0.45), Color.white.opacity(0.08)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 0.9
                )
        )
        .shadow(color: tint.opacity(0.11), radius: 18, x: 0, y: 8)
        .accessibilityElement(children: .contain)
    }
}

@available(iOS 17.0, *)
private struct AttentionCenterCard: View {
    let item: AttentionItem
    let open: () -> Void
    let markSeen: () -> Void

    var body: some View {
        let tint = AttentionIcon.tint(for: item.kind)
        VStack(alignment: .leading, spacing: 11) {
            Button(action: open) {
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
                        Text(item.scopeLabel)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(ADEColor.textSecondary.opacity(0.86))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(item.timestamp, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(ADEColor.textSecondary)
                }
            }
            .buttonStyle(.plain)

            AttentionDrawerActionRow(item: item, open: open, markSeen: markSeen)
        }
        .padding(14)
        .background(ADEColor.cardBackground.opacity(0.96), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(tint.opacity(0.24), lineWidth: 0.7)
        )
    }
}

@available(iOS 17.0, *)
private struct AttentionLiveRow: View {
    let item: AttentionItem
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 11) {
                BrandDot(slug: item.providerSlug ?? "ade", size: 16, pulse: item.machineOnline)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                    Text(item.scopeLabel)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    Label(item.phaseLabel, systemImage: item.machineOnline ? "waveform.path" : "wifi.slash")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(AttentionIcon.tint(for: item.kind))
                        .labelStyle(.titleAndIcon)
                    Text(item.timestamp, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(ADEColor.textSecondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.title), \(item.phaseLabel), \(item.scopeLabel)")
        .accessibilityHint("Opens the related agent.")
    }
}

@available(iOS 17.0, *)
private struct AttentionRecentRow: View {
    let item: AttentionItem
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 11) {
                Image(systemName: AttentionIcon.symbol(for: item.kind))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AttentionIcon.tint(for: item.kind))
                    .frame(width: 30, height: 30)
                    .background(AttentionIcon.tint(for: item.kind).opacity(0.1), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                    Text(item.scopeLabel)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                Text(item.timestamp, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textSecondary)
            }
            .padding(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(ADEColor.cardBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(ADEColor.glassBorder.opacity(0.8), lineWidth: 0.6)
        )
    }
}

@available(iOS 17.0, *)
private struct AttentionDrawerActionRow: View {
    let item: AttentionItem
    let open: () -> Void
    let markSeen: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons }
            VStack(spacing: 8) { buttons }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        switch item.kind {
        case .awaitingInput:
            let canAnswerInline = item.inlineActionsAllowed
                && !(item.itemId ?? "").isEmpty
                && item.machineOnline
            if canAnswerInline {
                Button(intent: ApproveSessionIntent(sessionId: item.sessionId ?? "", itemId: item.itemId ?? "")) {
                    AttentionDrawerActionLabel("Approve", systemImage: "checkmark", variant: .primary(ADEColor.success))
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded(markSeen))

                Button(intent: DenySessionIntent(sessionId: item.sessionId ?? "", itemId: item.itemId ?? "")) {
                    AttentionDrawerActionLabel("Deny", systemImage: "xmark", variant: .danger)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded(markSeen))
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
            if item.inlineActionsAllowed && item.machineOnline {
                Button(intent: RestartSessionIntent(sessionId: item.sessionId ?? "")) {
                    AttentionDrawerActionLabel("Restart", systemImage: "arrow.uturn.backward", variant: .secondary)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded(markSeen))
            }

        case .ciFailing:
            Button(action: open) {
                AttentionDrawerActionLabel(prLabel("Open"), systemImage: "arrow.triangle.branch", variant: .primary(ADEColor.accent))
            }
            .buttonStyle(.plain)
            if item.inlineActionsAllowed && item.machineOnline {
                Button(intent: RetryCheckIntent(prNumber: item.prNumber ?? 0, prId: item.prId ?? "")) {
                    AttentionDrawerActionLabel("Rerun CI", systemImage: "arrow.uturn.backward", variant: .secondary)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded(markSeen))
            }

        case .reviewRequested:
            Button(action: open) {
                AttentionDrawerActionLabel(prLabel("Review"), systemImage: "eye", variant: .primary(ADEColor.accent))
            }
            .buttonStyle(.plain)

        case .mergeReady:
            Button(action: open) {
                AttentionDrawerActionLabel(prLabel("Review merge"), systemImage: "checkmark.seal", variant: .primary(ADEColor.success))
            }
            .buttonStyle(.plain)

        case .running, .open, .completed, .merged, .stale:
            Button(action: open) {
                AttentionDrawerActionLabel("Open", systemImage: "arrow.right", variant: .secondary)
            }
            .buttonStyle(.plain)
        }
    }

    private func prLabel(_ verb: String) -> String {
        guard let number = item.prNumber, number > 0 else { return "\(verb) PR" }
        return "\(verb) #\(number)"
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
    let systemImage: String
    let variant: AttentionDrawerActionVariant

    init(_ title: String, systemImage: String, variant: AttentionDrawerActionVariant) {
        self.title = title
        self.systemImage = systemImage
        self.variant = variant
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .bold))
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.76)
        }
        .foregroundStyle(variant.foreground)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(variant.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(variant.stroke, lineWidth: 0.6)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

@available(iOS 17.0, *)
private struct AttentionCountPill: View {
    let count: Int
    let label: String
    let tint: Color

    var body: some View {
        Text("\(count) \(label)")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(count > 0 ? tint : ADEColor.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background((count > 0 ? tint : ADEColor.textSecondary).opacity(0.1), in: Capsule())
    }
}

@available(iOS 17.0, *)
private struct ProjectLensButton: View {
    let title: String
    let count: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                    .lineLimit(1)
                Text("\(count)")
                    .font(.caption2.monospacedDigit())
                    .opacity(0.72)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(selected ? Color.white : ADEColor.textSecondary)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                selected ? AnyShapeStyle(PrGlassPalette.accentGradient) : AnyShapeStyle(Color.white.opacity(0.055)),
                in: Capsule(style: .continuous)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(selected ? Color.white.opacity(0.2) : ADEColor.glassBorder, lineWidth: 0.7)
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

@available(iOS 17.0, *)
private struct OfflineBadge: View {
    let online: Bool

    var body: some View {
        if !online {
            Label("Offline", systemImage: "wifi.slash")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ADESharedTheme.statusIdle)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(ADESharedTheme.statusIdle.opacity(0.1), in: Capsule())
        }
    }
}

@available(iOS 17.0, *)
private enum AttentionIcon {
    static func symbol(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput: return "bell.badge.fill"
        case .failed: return "xmark.octagon.fill"
        case .ciFailing: return "exclamationmark.triangle.fill"
        case .reviewRequested: return "eye.fill"
        case .mergeReady: return "checkmark.seal.fill"
        case .running: return "waveform.path.ecg"
        case .open: return "arrow.triangle.pull"
        case .completed: return "checkmark.circle.fill"
        case .merged: return "arrow.triangle.merge"
        case .stale: return "wifi.slash"
        }
    }

    static func tint(for kind: AttentionKind) -> Color {
        switch kind {
        case .awaitingInput: return ADESharedTheme.warningAmber
        case .failed, .ciFailing: return ADESharedTheme.statusFailed
        case .reviewRequested: return ADESharedTheme.statusReview
        case .mergeReady, .completed, .merged: return ADESharedTheme.statusSuccess
        case .running, .open: return ADESharedTheme.statusRunning
        case .stale: return ADESharedTheme.statusIdle
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
                    .phaseAnimator([false, true]) { circle, expanded in
                        circle
                            .scaleEffect(expanded ? 1.5 : 1)
                            .opacity(expanded ? 0 : 0.9)
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
                    .phaseAnimator([false, true]) { circle, expanded in
                        circle
                            .scaleEffect(expanded ? 1.6 : 1)
                            .opacity(expanded ? 0 : 0.34)
                    } animation: { _ in
                        .easeInOut(duration: 1.5)
                    }
            }
            Circle()
                .fill(color.opacity(0.18))
                .frame(width: size, height: size)
                .overlay {
                    if let assetName = ADESharedTheme.providerAssetName(for: slug) {
                        Image(assetName)
                            .resizable()
                            .scaledToFit()
                            .frame(width: size * 0.7, height: size * 0.7)
                    } else {
                        Circle()
                            .fill(color)
                            .frame(width: size * 0.48, height: size * 0.48)
                    }
                }
                .overlay(Circle().strokeBorder(color.opacity(0.32), lineWidth: 0.6))
                .shadow(color: color.opacity(0.3), radius: size * 0.22)
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
            content.keyframeAnimator(initialValue: 0.0, repeating: true) { view, rotation in
                view.rotationEffect(.degrees(rotation))
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(0, duration: 1.35)
                    CubicKeyframe(-13, duration: 0.16)
                    CubicKeyframe(11, duration: 0.16)
                    CubicKeyframe(-7, duration: 0.16)
                    CubicKeyframe(4, duration: 0.16)
                    CubicKeyframe(0, duration: 0.16)
                }
            }
        } else {
            content
        }
    }
}

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
