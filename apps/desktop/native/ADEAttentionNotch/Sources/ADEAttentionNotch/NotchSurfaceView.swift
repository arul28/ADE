import SwiftUI
import ADEAttentionNotchCore

struct NotchSurfaceView: View {
    @ObservedObject var model: NotchViewModel
    let hasPhysicalNotch: Bool
    let physicalNotchWidth: Double?
    let safeAreaTop: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var state: NotchPresentationState { model.interaction.presentation }
    private var size: NotchSize {
        notchSurfaceSize(
            presentation: state,
            physicalNotchWidth: hasPhysicalNotch ? physicalNotchWidth : nil,
            safeAreaTop: hasPhysicalNotch ? safeAreaTop : 0
        )
    }
    private var item: AttentionItem? { model.selectedItem }
    private var itemPresentation: AttentionItemPresentation? {
        item?.presentation(hideDetails: model.settings.hideDetails)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            surface
                .frame(width: size.width, height: size.height)
                .animation(surfaceAnimation, value: state)
                .animation(surfaceAnimation, value: size)
        }
        .frame(
            width: NotchDisplayGeometry.panelSize.width,
            height: NotchDisplayGeometry.panelSize.height,
            alignment: .top
        )
    }

    private var surface: some View {
        ZStack(alignment: .top) {
            NotchContainerShape(
                floating: !hasPhysicalNotch,
                physicalNotchWidth: physicalNotchWidth
            )
                .fill(backgroundStyle)
                .overlay {
                    if !hasPhysicalNotch {
                        NotchContainerShape(floating: true, physicalNotchWidth: nil)
                            .strokeBorder(
                                LinearGradient(
                                    colors: [.white.opacity(0.20), .white.opacity(0.035)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                lineWidth: 0.8
                            )
                    } else {
                        VStack {
                            Spacer()
                            LinearGradient(
                                colors: [.clear, .white.opacity(0.18), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: min(size.width * 0.68, 230), height: 0.7)
                        }
                    }
                }
                .shadow(
                    color: .black.opacity(hasPhysicalNotch ? 0.34 : 0.46),
                    radius: hasPhysicalNotch ? 20 : 28,
                    y: hasPhysicalNotch ? 8 : 14
                )

            Group {
                switch state {
                case .compact, .prehover:
                    compactContent
                case .peek:
                    peekContent
                case .expanded:
                    expandedContent
                case .attention:
                    attentionContent
                case .celebration:
                    celebrationContent
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, physicalContentTopInset)
            .transition(.opacity.combined(with: .scale(scale: 0.965, anchor: .top)))

            if !reduceMotion, state == .prehover || state == .peek {
                SurfaceSheen()
                    .clipShape(NotchContainerShape(
                        floating: !hasPhysicalNotch,
                        physicalNotchWidth: physicalNotchWidth
                    ))
                    .allowsHitTesting(false)
            }
        }
        .contentShape(NotchContainerShape(
            floating: !hasPhysicalNotch,
            physicalNotchWidth: physicalNotchWidth
        ))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint("Click to expand ADE Attention Center")
    }

    private var compactContent: some View {
        Group {
            if hasPhysicalNotch, let physicalNotchWidth {
                physicalCompactContent(notchWidth: physicalNotchWidth)
            } else {
                floatingCompactContent
            }
        }
    }

    private var floatingCompactContent: some View {
        HStack(spacing: 8) {
            ProviderMark(
                provider: item?.provider,
                kind: item?.kind ?? "agent",
                phase: item?.phase ?? "running",
                active: item?.isAttention == true || state == .prehover,
                reducedMotion: reduceMotion
            )
            Text(compactIdentityLabel)
                .font(.system(size: 11.5, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .layoutPriority(1)
            Spacer(minLength: 4)
            Circle()
                .fill(statusColor)
                .frame(width: 5, height: 5)
                .shadow(color: statusColor.opacity(0.6), radius: reduceMotion ? 0 : 2)
            Text(compactStatusLabel)
                .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                .foregroundStyle(statusColor.opacity(0.92))
                .lineLimit(1)
            if let item {
                ElapsedTimeLabel(isoDate: item.occurredAt)
            }
        }
        .padding(.horizontal, 13)
    }

    private func physicalCompactContent(notchWidth: Double) -> some View {
        let reservedWidth = max(120, min(size.width - 40, notchWidth + 16))
        let earWidth = max(74, (size.width - reservedWidth) / 2)
        return HStack(spacing: 0) {
            HStack(spacing: 7) {
                Text(physicalCompactIdentityLabel)
                    .font(.system(size: 10.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                ProviderMark(
                    provider: item?.provider,
                    kind: item?.kind ?? "agent",
                    phase: item?.phase ?? "running",
                    active: item?.isAttention == true || state == .prehover,
                    reducedMotion: reduceMotion
                )
            }
            .padding(.leading, 9)
            .padding(.trailing, 7)
            .frame(width: earWidth)

            Color.clear
                .frame(width: reservedWidth)
                .accessibilityHidden(true)

            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 5, height: 5)
                    .shadow(color: statusColor.opacity(0.62), radius: reduceMotion ? 0 : 2)
                Text(compactEarStatusLabel)
                    .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(statusColor.opacity(0.94))
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                if let item {
                    ElapsedTimeLabel(isoDate: item.occurredAt)
                }
            }
            .padding(.leading, 7)
            .padding(.trailing, 9)
            .frame(width: earWidth, alignment: .leading)
        }
        .frame(width: size.width, height: max(34, min(size.height, safeAreaTop)))
    }

    private var peekContent: some View {
        HStack(spacing: 12) {
            ProviderMark(
                provider: item?.provider,
                kind: item?.kind ?? "agent",
                phase: item?.phase ?? "running",
                active: item?.isAttention == true,
                reducedMotion: reduceMotion
            )
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(itemPresentation?.title ?? "ADE Attention Center")
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(item?.statusLabel ?? "Ready")
                        .font(.system(size: 9.5, weight: .bold, design: .rounded))
                        .foregroundStyle(statusColor)
                }
                Text(model.visiblePreview)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                if let progress = itemPresentation?.planProgress, progress.total > 0 {
                    ProgressView(value: Double(progress.completed), total: Double(progress.total))
                        .tint(statusColor)
                        .scaleEffect(x: 1, y: 0.58)
                }
            }
        }
        .padding(.horizontal, 17)
        .padding(.top, hasPhysicalNotch ? 5 : 0)
    }

    private var expandedContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ProviderMark(
                    provider: item?.provider,
                    kind: item?.kind ?? "agent",
                    phase: item?.phase ?? "running",
                    active: item?.isAttention == true,
                    reducedMotion: reduceMotion
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text("ADE Attention Center")
                        .font(.system(size: 12.5, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(accountScopeLabel)
                        .font(.system(size: 9.5, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.48))
                }
                Spacer()
                navigationControls
            }
            .padding(.horizontal, 18)
            .padding(.top, hasPhysicalNotch ? 10 : 14)
            .padding(.bottom, 13)

            Divider().overlay(.white.opacity(0.08))

            if let item {
                VStack(alignment: .leading, spacing: 11) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(itemPresentation?.title ?? "ADE attention")
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(2)
                            Text(itemPresentation?.scopeLabel ?? "Account-wide activity")
                                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.48))
                        }
                        Spacer(minLength: 10)
                        StatusChip(label: item.statusLabel, color: statusColor)
                    }

                    Text(model.visiblePreview)
                        .font(.system(size: 11.5, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.72))
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let progress = itemPresentation?.planProgress, progress.total > 0 {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(progress.current ?? "Plan progress")
                                    .lineLimit(1)
                                Spacer()
                                Text("\(progress.completed)/\(progress.total)")
                            }
                            .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.48))
                            ProgressView(value: Double(progress.completed), total: Double(progress.total))
                                .tint(statusColor)
                        }
                    } else if let activity = itemPresentation?.recentActivity, !activity.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(activity.prefix(3).enumerated()), id: \.offset) { _, line in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    Circle().fill(statusColor.opacity(0.8)).frame(width: 4, height: 4)
                                    Text(line)
                                        .font(.system(size: 10, weight: .medium, design: .rounded))
                                        .foregroundStyle(.white.opacity(0.56))
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 15)

                Spacer(minLength: 6)
                actionBar
                    .padding(.horizontal, 15)
                    .padding(.bottom, 15)
            } else {
                Spacer()
                Text("Nothing needs your attention.")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
                Spacer()
            }
        }
    }

    private var attentionContent: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 9) {
                ProviderMark(
                    provider: item?.provider,
                    kind: item?.kind ?? "agent",
                    phase: item?.phase ?? "needs_you",
                    active: true,
                    reducedMotion: reduceMotion
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(item?.statusLabel ?? "Needs you")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(statusColor)
                    Text(itemPresentation?.title ?? "ADE needs your attention")
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                Spacer()
            }
            Text(model.visiblePreview)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.66))
                .lineLimit(2)
            HStack {
                Spacer()
                compactActionButtons
            }
        }
        .padding(.horizontal, 17)
        .padding(.top, hasPhysicalNotch ? 10 : 14)
        .padding(.bottom, 13)
    }

    private var celebrationContent: some View {
        ZStack {
            CelebrationParticles(active: state == .celebration, reducedMotion: reduceMotion)
                .allowsHitTesting(false)
            VStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 28, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.green)
                Text("Merged")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text(itemPresentation?.celebrationTitle ?? "Pull request merged")
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.58))
                    .lineLimit(1)
            }
            .padding(.top, hasPhysicalNotch ? 6 : 10)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            Text("\(model.interaction.selectedIndex + 1) of \(max(model.items.count, 1))")
                .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.36))
                .padding(.leading, 4)
            Spacer()
            compactActionButtons
            Button {
                model.openSelected()
            } label: {
                Label("Open in ADE", systemImage: "arrow.up.forward.app.fill")
                    .font(.system(size: 10.5, weight: .bold, design: .rounded))
            }
            .buttonStyle(NotchButtonStyle(prominent: true))
            .accessibilityHint("Opens the exact agent or pull request in ADE")
        }
    }

    private var compactActionButtons: some View {
        ForEach(Array(model.navigationActions.prefix(2))) { action in
            Button(action.navigationLabel) {
                model.openFor(action)
            }
            .buttonStyle(NotchButtonStyle(prominent: action.kind == "approve"))
            .accessibilityLabel(action.navigationLabel)
            .accessibilityHint(action.navigationAccessibilityHint)
        }
    }

    private var navigationControls: some View {
        HStack(spacing: 5) {
            Button {
                model.navigate(delta: -1)
            } label: {
                Image(systemName: "chevron.left")
            }
            .accessibilityLabel("Previous attention item")
            Button {
                model.navigate(delta: 1)
            } label: {
                Image(systemName: "chevron.right")
            }
            .accessibilityLabel("Next attention item")
        }
        .buttonStyle(NotchIconButtonStyle())
    }

    private var accountScopeLabel: String {
        if model.settings.hideDetails {
            return "Account-wide activity"
        }
        let projectCount = Set(model.items.map(\.project.projectId)).count
        let machineCount = Set(model.items.map(\.machine.machineKey)).count
        return "\(model.items.count) items · \(projectCount) projects · \(machineCount) machines"
    }

    private var statusColor: Color {
        notchStatusColor(for: item?.phase)
    }

    private var compactIdentityLabel: String {
        itemPresentation?.compactIdentity ?? "ADE"
    }

    private var physicalCompactIdentityLabel: String {
        compactIdentityLabel.count > 12
            ? String(compactIdentityLabel.prefix(12))
            : compactIdentityLabel
    }

    private var compactStatusLabel: String {
        switch item?.phase {
        case "starting": return "Starting"
        case "running": return "Working"
        case "needs_you": return "Needs you"
        case "completed": return "Done"
        case "merged": return "Merged"
        case "checks_failing": return "Checks failed"
        case "merge_ready": return "Merge ready"
        default: return item?.statusLabel ?? "Ready"
        }
    }

    private var compactEarStatusLabel: String {
        switch item?.phase {
        case "checks_failing", "failed": return "Failed"
        case "changes_requested": return "Changes"
        case "review_requested": return "Review"
        case "merge_ready": return "Ready"
        default: return compactStatusLabel
        }
    }

    private var backgroundStyle: AnyShapeStyle {
        if reduceTransparency {
            return AnyShapeStyle(Color(red: 0.025, green: 0.028, blue: 0.04))
        }
        return AnyShapeStyle(
            LinearGradient(
                colors: [
                    Color.black.opacity(hasPhysicalNotch ? 0.985 : 0.92),
                    Color(red: 0.035, green: 0.038, blue: 0.058).opacity(0.96),
                ],
                startPoint: .top,
                endPoint: .bottomTrailing
            )
        )
    }

    private var surfaceAnimation: Animation? {
        if reduceMotion {
            return .linear(duration: 0.01)
        }
        if state == .compact {
            return .spring(response: 0.45, dampingFraction: 1, blendDuration: 0.08)
        }
        return .spring(response: 0.42, dampingFraction: 0.8, blendDuration: 0.12)
    }

    private var physicalContentTopInset: CGFloat {
        guard hasPhysicalNotch else { return 0 }
        switch state {
        case .compact, .prehover:
            return 0
        case .peek, .expanded, .attention, .celebration:
            return CGFloat(max(0, safeAreaTop))
        }
    }

    private var accessibilitySummary: String {
        itemPresentation?.accessibilitySummary ?? "ADE Attention Center"
    }
}

private struct NotchContainerShape: InsettableShape {
    let floating: Bool
    let physicalNotchWidth: Double?
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: insetAmount, dy: insetAmount)
        if !floating, let physicalNotchWidth {
            return physicalPath(in: rect, notchWidth: physicalNotchWidth)
        }
        let bottomRadius = min(24, rect.height * 0.24)
        let topRadius: CGFloat = floating ? min(18, bottomRadius) : 5
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + topRadius, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - topRadius, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY + topRadius),
            control: CGPoint(x: rect.maxX, y: rect.minY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - bottomRadius, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + bottomRadius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - bottomRadius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + topRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + topRadius, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }

    private func physicalPath(in rect: CGRect, notchWidth: Double) -> Path {
        let centerX = rect.midX
        let resolvedNotchWidth = min(rect.width - 20, max(120, notchWidth - insetAmount * 2))
        let notchLeft = centerX - resolvedNotchWidth / 2
        let notchRight = centerX + resolvedNotchWidth / 2
        let shoulderDepth = min(24, max(15, rect.height * 0.18))
        let bottomRadius = min(25, max(12, rect.height * 0.16))
        var path = Path()
        path.move(to: CGPoint(x: notchLeft, y: rect.minY))
        path.addLine(to: CGPoint(x: notchRight, y: rect.minY))
        path.addLine(to: CGPoint(x: notchRight, y: rect.minY + shoulderDepth * 0.34))
        path.addCurve(
            to: CGPoint(x: rect.maxX - 7, y: rect.minY + shoulderDepth),
            control1: CGPoint(x: notchRight + 2, y: rect.minY + shoulderDepth * 0.72),
            control2: CGPoint(x: rect.maxX - 18, y: rect.minY + shoulderDepth * 0.84)
        )
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY + shoulderDepth + 7),
            control: CGPoint(x: rect.maxX, y: rect.minY + shoulderDepth)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - bottomRadius, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + bottomRadius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - bottomRadius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + shoulderDepth + 7))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + 7, y: rect.minY + shoulderDepth),
            control: CGPoint(x: rect.minX, y: rect.minY + shoulderDepth)
        )
        path.addCurve(
            to: CGPoint(x: notchLeft, y: rect.minY + shoulderDepth * 0.34),
            control1: CGPoint(x: rect.minX + 18, y: rect.minY + shoulderDepth * 0.84),
            control2: CGPoint(x: notchLeft - 2, y: rect.minY + shoulderDepth * 0.72)
        )
        path.addLine(to: CGPoint(x: notchLeft, y: rect.minY))
        path.closeSubpath()
        return path
    }

    func inset(by amount: CGFloat) -> some InsettableShape {
        var copy = self
        copy.insetAmount += amount
        return copy
    }
}

private struct ProviderMark: View {
    let provider: String?
    let kind: String
    let phase: String
    let active: Bool
    let reducedMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24, paused: !active || reducedMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let pulse = active && !reducedMotion ? (sin(t * 3.4) + 1) / 2 : 0
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(providerGradient)
                    .overlay {
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(.white.opacity(0.16), lineWidth: 0.7)
                    }
                Group {
                    if let providerIconName {
                        Image(providerIconName, bundle: .module)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 13, height: 13)
                    } else if kind == "pull_request" {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 10, weight: .bold))
                    } else {
                        Text(monogram)
                            .font(.system(size: monogram.count > 1 ? 7.5 : 10.5, weight: .heavy, design: .rounded))
                            .tracking(monogram.count > 1 ? -0.4 : 0)
                    }
                }
                .foregroundStyle(.white.opacity(0.92))

                Circle()
                    .fill(statusColor)
                    .frame(width: 5.5, height: 5.5)
                    .overlay(Circle().stroke(Color.black.opacity(0.88), lineWidth: 1.2))
                    .shadow(color: statusColor.opacity(0.72), radius: 2 + pulse * 2)
                    .offset(x: 8.5, y: 8.5)
            }
            .frame(width: 23, height: 23)
        }
        .accessibilityLabel("\(providerName) provider, \(phase.replacingOccurrences(of: "_", with: " "))")
    }

    private var statusColor: Color {
        notchStatusColor(for: phase)
    }

    private var providerName: String {
        let value = provider?.lowercased() ?? ""
        if value.contains("codex") || value.contains("openai") { return "Codex" }
        if value.contains("claude") || value.contains("anthropic") { return "Claude" }
        if value.contains("cursor") { return "Cursor" }
        if value.contains("opencode") { return "OpenCode" }
        if value.contains("droid") || value.contains("factory") { return "Droid" }
        if let provider, !provider.isEmpty { return provider }
        return "ADE"
    }

    private var providerIconName: String? {
        let value = providerName.lowercased()
        if value.contains("codex") || value.contains("openai") { return "openai" }
        if value.contains("claude") || value.contains("anthropic") { return "claude" }
        if value.contains("cursor") { return "cursor" }
        if value.contains("opencode") { return "opencode" }
        if value.contains("github") { return "github" }
        return nil
    }

    private var monogram: String {
        String(providerName.prefix(1)).uppercased()
    }

    private var providerGradient: LinearGradient {
        let colors: [Color]
        switch providerName {
        case "Claude": colors = [Color(red: 0.88, green: 0.42, blue: 0.25), Color(red: 0.52, green: 0.22, blue: 0.17)]
        case "Cursor": colors = [Color(red: 0.35, green: 0.36, blue: 0.42), Color(red: 0.10, green: 0.11, blue: 0.15)]
        case "OpenCode": colors = [Color(red: 0.26, green: 0.76, blue: 0.56), Color(red: 0.09, green: 0.34, blue: 0.27)]
        case "Droid": colors = [Color(red: 0.96, green: 0.69, blue: 0.25), Color(red: 0.51, green: 0.29, blue: 0.09)]
        case "ADE": colors = [Color(red: 0.48, green: 0.30, blue: 0.94), Color(red: 0.18, green: 0.12, blue: 0.38)]
        default: colors = [Color(red: 0.32, green: 0.36, blue: 0.44), Color(red: 0.10, green: 0.12, blue: 0.16)]
        }
        return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

private func notchStatusColor(for phase: String?) -> Color {
    switch notchStatusTone(for: phase) {
    case .blue:
        return Color(red: 0.35, green: 0.66, blue: 1)
    case .amber:
        return Color(red: 1, green: 0.69, blue: 0.32)
    case .red:
        return Color(red: 1, green: 0.39, blue: 0.44)
    case .violet:
        return Color(red: 0.68, green: 0.52, blue: 1)
    case .green:
        return Color(red: 0.37, green: 0.88, blue: 0.58)
    case .neutral:
        return Color.white.opacity(0.44)
    }
}

private struct SurfaceSheen: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            LinearGradient(
                colors: [.clear, .white.opacity(0.075), .clear],
                startPoint: .leading,
                endPoint: .trailing
            )
            .rotationEffect(.degrees(-18))
            .offset(x: sin(t * 1.8) * 110)
        }
    }
}

private struct StatusChip: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label.uppercased())
            .font(.system(size: 8.5, weight: .heavy, design: .rounded))
            .tracking(0.6)
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.22), lineWidth: 0.7))
    }
}

private struct ElapsedTimeLabel: View {
    let isoDate: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            Text(elapsed(at: timeline.date))
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.36))
        }
        .accessibilityLabel("Elapsed time")
    }

    private func elapsed(at now: Date) -> String {
        attentionElapsedLabel(since: isoDate, now: now)
    }
}

private struct NotchButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10.5, weight: .bold, design: .rounded))
            .foregroundStyle(prominent ? Color.black.opacity(0.82) : .white.opacity(0.75))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                prominent
                    ? AnyShapeStyle(Color.white)
                    : AnyShapeStyle(Color.white.opacity(configuration.isPressed ? 0.14 : 0.08)),
                in: Capsule()
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct NotchIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white.opacity(0.62))
            .frame(width: 25, height: 24)
            .background(.white.opacity(configuration.isPressed ? 0.15 : 0.07), in: Circle())
    }
}

private struct CelebrationParticles: View {
    let active: Bool
    let reducedMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !active || reducedMotion)) { timeline in
            Canvas { context, size in
                let elapsed = timeline.date.timeIntervalSinceReferenceDate
                for index in 0..<18 {
                    let seed = Double((index * 47) % 101) / 101
                    let phase = reducedMotion ? 0.42 : elapsed.truncatingRemainder(dividingBy: 1.65) / 1.65
                    let x = size.width * (0.12 + 0.76 * Double((index * 37) % 97) / 97)
                    let drift = sin(seed * 19 + phase * 7) * 13
                    let y = size.height * (0.10 + phase * 0.84)
                    let opacity = max(0, 1 - phase * 1.18)
                    let rect = CGRect(x: x + drift, y: y, width: 4 + seed * 3, height: 7 + seed * 4)
                    context.opacity = opacity
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: 1.5),
                        with: .color(palette[index % palette.count])
                    )
                }
            }
        }
        .accessibilityHidden(true)
    }

    private var palette: [Color] {
        [.cyan, .indigo, .purple, .pink, .green, .yellow]
    }
}
