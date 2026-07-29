import AppKit
import SwiftUI
import ADEAttentionNotchCore

/// ADE design tokens, mirrored from `apps/desktop/src/renderer/index.css` and
/// the Attention center's tone system. Values are duplicated rather than
/// derived because the helper is a separate process with no access to the
/// renderer stylesheet; keep them in step with the CSS custom properties named
/// in each comment.
private func adeColor(_ hex: UInt32) -> Color {
    Color(
        .sRGB,
        red: Double((hex >> 16) & 0xFF) / 255,
        green: Double((hex >> 8) & 0xFF) / 255,
        blue: Double(hex & 0xFF) / 255,
        opacity: 1
    )
}

private enum ADE {
    static let bg = adeColor(0x0C0B10)          // --color-bg
    static let surface = adeColor(0x16141E)     // --color-surface
    static let card = adeColor(0x1A1830)        // --color-card
    static let fg = adeColor(0xF0F0F2)          // --color-fg
    static let secondaryFg = adeColor(0xA8A8B4) // --color-secondary-fg
    static let mutedFg = adeColor(0x908FA0)     // --color-muted-fg
    static let border = adeColor(0x302C42)      // --color-border
    static let accent = adeColor(0xA78BFA)      // --color-accent
    static let accentDeep = adeColor(0x7C3AED)  // --color-accent-deep

    /// `--attn-hdr-hairline`: color-mix(--color-border 70%, transparent).
    static let hairline = border.opacity(0.7)

    // ADE's attention type scale (`--attn-hdr-fs-*`).
    static let fs2xs: CGFloat = 9.5
    static let fsXs: CGFloat = 10.5
    static let fsSm: CGFloat = 11.5
    static let fsMd: CGFloat = 12.5
    static let fsLg: CGFloat = 15
}

/// The renderer's dark-theme `.attention-tone-*` values.
private func notchToneColor(_ tone: NotchStatusTone) -> Color {
    switch tone {
    case .amber: return adeColor(0xFBBF24)
    case .red: return adeColor(0xF87171)
    case .violet: return adeColor(0xA78BFA)
    case .blue: return adeColor(0x60A5FA)
    case .cyan: return adeColor(0x22D3EE)
    case .emerald: return adeColor(0x34D399)
    case .neutral: return adeColor(0xA1A1AA)
    }
}

private func notchStatusColor(for phase: String?) -> Color {
    notchToneColor(notchStatusTone(for: phase))
}

struct NotchSurfaceView: View {
    @ObservedObject var model: NotchViewModel
    let hasPhysicalNotch: Bool
    let physicalNotchWidth: Double?
    let safeAreaTop: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var state: NotchPresentationState { model.interaction.presentation }
    private var resolvedNotchWidth: Double? { hasPhysicalNotch ? physicalNotchWidth : nil }

    private var size: NotchSize {
        notchSurfaceSize(
            presentation: state,
            physicalNotchWidth: resolvedNotchWidth,
            safeAreaTop: hasPhysicalNotch ? safeAreaTop : 0
        )
    }

    private var corners: NotchSurfaceCorners {
        notchSurfaceCorners(presentation: state, hasPhysicalNotch: hasPhysicalNotch, size: size)
    }

    /// Height of the menu-bar strip the hardware cutout occupies. Zero without
    /// a physical notch, where the whole surface floats below the menu bar.
    private var bandHeight: CGFloat {
        guard hasPhysicalNotch else { return 0 }
        return CGFloat(min(size.height, notchMenuBarBandHeight(safeAreaTop: safeAreaTop)))
    }

    private var item: AttentionItem? { model.selectedItem }
    private var itemPresentation: AttentionItemPresentation? {
        item?.presentation(hideDetails: model.settings.hideDetails)
    }
    private var status: NotchStatusPresentation? { model.statusPresentation }

    /// Tone of the whole surface: the selected item's phase, or the stream's
    /// own health when there is no item to show.
    private var surfaceTone: NotchStatusTone {
        if let item { return notchStatusTone(for: item.phase) }
        return status?.tone ?? .neutral
    }

    private var toneColor: Color { notchToneColor(surfaceTone) }

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            surface
                .frame(width: size.width, height: size.height)
                .opacity(model.isDormantHoverSurface ? 0 : 1)
                .animation(surfaceAnimation, value: state)
        }
        .frame(
            width: NotchDisplayGeometry.panelSize.width,
            height: NotchDisplayGeometry.panelSize.height,
            alignment: .top
        )
    }

    private var shape: NotchSurfaceShape {
        NotchSurfaceShape(topRadius: CGFloat(corners.top), bottomRadius: CGFloat(corners.bottom))
    }

    private var surface: some View {
        ZStack(alignment: .top) {
            shape
                .fill(backgroundStyle)
                .overlay {
                    // The contour is the only thing separating the surface from a
                    // dark menu bar when a full-screen window sits behind it, so
                    // it carries a tone-tinted hairline rather than none at all.
                    shape.strokeBorder(edgeStyle, lineWidth: 0.8)
                }

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.top, contentTopInset)
                .transition(.opacity)
        }
        .compositingGroup()
        .shadow(color: .black.opacity(0.55), radius: hasPhysicalNotch ? 14 : 22, y: hasPhysicalNotch ? 6 : 12)
        .contentShape(shape)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint(accessibilityHint)
    }

    @ViewBuilder
    private var content: some View {
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

    // MARK: - Compact

    private var compactContent: some View {
        Group {
            if hasPhysicalNotch, let physicalNotchWidth {
                physicalCompactContent(notchWidth: physicalNotchWidth)
            } else {
                floatingCompactContent
            }
        }
    }

    /// Split around the hardware cutout: identity on the left ear, live status
    /// on the right. Nothing is ever drawn under the cutout itself.
    private func physicalCompactContent(notchWidth: Double) -> some View {
        let reserved = min(size.width - 120, notchWidth + 14)
        let earWidth = max(64, (size.width - reserved) / 2)
        return HStack(spacing: 0) {
            HStack(spacing: 7) {
                Spacer(minLength: 0)
                Text(compactIdentityLabel)
                    .font(.system(size: ADE.fsXs, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                ProviderMark(item: item, status: status, diameter: 18, active: isMarkActive, reducedMotion: reduceMotion)
            }
            .padding(.leading, 10)
            .padding(.trailing, 7)
            .frame(width: earWidth)

            Color.clear
                .frame(width: reserved)
                .accessibilityHidden(true)

            HStack(spacing: 0) {
                compactStatusCluster
                Spacer(minLength: 0)
            }
            .padding(.leading, 7)
            .padding(.trailing, 10)
            .frame(width: earWidth)
        }
        .frame(width: size.width, height: bandHeight)
    }

    private var floatingCompactContent: some View {
        HStack(spacing: 8) {
            ProviderMark(item: item, status: status, diameter: 18, active: isMarkActive, reducedMotion: reduceMotion)
            // The identity is the only elastic element: it truncates so the
            // status never collapses to an ellipsis.
            Text(compactIdentityLabel)
                .font(.system(size: ADE.fsSm, weight: .semibold))
                .foregroundStyle(ADE.fg)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            compactStatusCluster
        }
        .padding(.horizontal, 13)
        .frame(height: CGFloat(size.height))
    }

    /// Status is short, fixed, and always fully legible.
    private var compactStatusCluster: some View {
        HStack(spacing: 5) {
            if status?.isProblem == true, item != nil {
                // Items are still showing, but they may be stale.
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(notchToneColor(status?.tone ?? .amber))
            }
            Circle()
                .fill(toneColor)
                .frame(width: 5, height: 5)
                .shadow(color: toneColor.opacity(0.6), radius: reduceMotion ? 0 : 2)
            Text(compactStatusLabel)
                .font(.system(size: ADE.fs2xs, weight: .semibold))
                .foregroundStyle(toneColor)
                .lineLimit(1)
                .truncationMode(.tail)
            if let item {
                ElapsedTimeLabel(isoDate: item.occurredAt)
                    .fixedSize()
            }
        }
        .layoutPriority(1)
    }

    // MARK: - Peek

    private var peekContent: some View {
        HStack(spacing: 11) {
            ProviderMark(item: item, status: status, diameter: 26, active: isMarkActive, reducedMotion: reduceMotion)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(peekTitle)
                        .font(.system(size: ADE.fsMd, weight: .semibold))
                        .foregroundStyle(ADE.fg)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(peekStatusLabel)
                        .font(.system(size: ADE.fs2xs, weight: .bold))
                        .foregroundStyle(toneColor)
                        .lineLimit(1)
                }
                if let progress = itemPresentation?.planProgress, progress.total > 0 {
                    PlanProgressBar(progress: progress, tone: toneColor)
                } else {
                    Text(peekSubtitle)
                        .font(.system(size: ADE.fsXs, weight: .medium))
                        .foregroundStyle(ADE.secondaryFg)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 15)
        .padding(.top, 9)
    }

    // MARK: - Expanded

    private var expandedContent: some View {
        VStack(spacing: 0) {
            expandedHeader
            Rectangle().fill(ADE.hairline).frame(height: 0.8)
            // Only a banner when items are still on screen and may be stale;
            // with no items the body below already carries the same copy.
            if let status, status.isProblem, item != nil {
                StatusBanner(status: status)
                Rectangle().fill(ADE.hairline).frame(height: 0.8)
            }
            if let item {
                expandedItemBody(item: item)
                Spacer(minLength: 4)
                actionBar
                    .padding(.horizontal, 15)
                    .padding(.bottom, 14)
            } else if let status {
                StatusBody(status: status)
            }
        }
    }

    private var expandedHeader: some View {
        HStack(spacing: 10) {
            AttentionGlyph(tone: surfaceTone)
            VStack(alignment: .leading, spacing: 2) {
                Text("ADE Attention Center")
                    .font(.system(size: ADE.fsMd, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                Text(accountScopeLabel)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
            }
            Spacer(minLength: 8)
            if model.items.count > 1 {
                navigationControls
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
    }

    private func expandedItemBody(item: AttentionItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(itemPresentation?.title ?? "ADE attention")
                        .font(.system(size: ADE.fsLg, weight: .semibold))
                        .foregroundStyle(ADE.fg)
                        .lineLimit(2)
                    Text(itemPresentation?.scopeLabel ?? "Account-wide activity")
                        .font(.system(size: ADE.fsXs, weight: .medium))
                        .foregroundStyle(ADE.mutedFg)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                PhasePill(label: item.statusLabel, tone: surfaceTone)
            }

            Text(model.visiblePreview)
                .font(.system(size: ADE.fsSm, weight: .regular))
                .foregroundStyle(ADE.secondaryFg)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let progress = itemPresentation?.planProgress, progress.total > 0 {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(progress.current ?? "Plan progress")
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(progress.completed)/\(progress.total)")
                            .monospacedDigit()
                    }
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    PlanProgressBar(progress: progress, tone: toneColor)
                }
            } else if let activity = itemPresentation?.recentActivity, !activity.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(activity.prefix(2).enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Circle()
                                .fill(toneColor.opacity(0.75))
                                .frame(width: 3.5, height: 3.5)
                            Text(line)
                                .font(.system(size: ADE.fsXs, weight: .regular))
                                .foregroundStyle(ADE.mutedFg)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 13)
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            if model.items.count > 1 {
                Text("\(model.interaction.selectedIndex + 1) of \(model.items.count)")
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .monospacedDigit()
                    .padding(.leading, 2)
            }
            Spacer(minLength: 4)
            secondaryActionButtons
            Button {
                model.openSelected()
            } label: {
                Label("Open in ADE", systemImage: "arrow.up.forward")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(NotchButtonStyle(prominent: true))
            .accessibilityHint("Opens the exact agent or pull request in ADE")
        }
    }

    /// `model.navigationActions` already drops a plain `open`, which the
    /// prominent button covers; one extra is all this footer has room for.
    private var secondaryActionButtons: some View {
        ForEach(Array(model.navigationActions.prefix(1))) { action in
            Button(action.navigationLabel) {
                model.openFor(action)
            }
            .buttonStyle(NotchButtonStyle(prominent: false))
            .accessibilityLabel(action.navigationLabel)
            .accessibilityHint(action.navigationAccessibilityHint)
        }
    }

    private var navigationControls: some View {
        HStack(spacing: 4) {
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

    // MARK: - Attention / celebration

    private var attentionContent: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                ProviderMark(item: item, status: status, diameter: 26, active: true, reducedMotion: reduceMotion)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item?.statusLabel ?? status?.title ?? "Needs you")
                        .font(.system(size: ADE.fs2xs, weight: .bold))
                        .foregroundStyle(toneColor)
                    Text(itemPresentation?.title ?? "ADE needs your attention")
                        .font(.system(size: ADE.fsSm + 1, weight: .semibold))
                        .foregroundStyle(ADE.fg)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            Text(model.visiblePreview)
                .font(.system(size: ADE.fsXs, weight: .regular))
                .foregroundStyle(ADE.secondaryFg)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Spacer(minLength: 4)
                secondaryActionButtons
                Button {
                    model.openSelected()
                } label: {
                    Text("Open in ADE")
                }
                .buttonStyle(NotchButtonStyle(prominent: true))
            }
        }
        .padding(.horizontal, 15)
        .padding(.top, 11)
        .padding(.bottom, 13)
    }

    private var celebrationContent: some View {
        ZStack {
            CelebrationParticles(active: state == .celebration, reducedMotion: reduceMotion)
                .allowsHitTesting(false)
            VStack(spacing: 7) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(ADE.bg, notchToneColor(.emerald))
                Text("Merged")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                Text(itemPresentation?.celebrationTitle ?? "Pull request merged")
                    .font(.system(size: ADE.fsXs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .lineLimit(1)
                    .padding(.horizontal, 16)
            }
            .padding(.top, 10)
        }
    }

    // MARK: - Style

    /// Black across the menu-bar band so the surface is continuous with the
    /// hardware cutout, lifting to ADE's card/background gradient below it so
    /// the panel reads as an ADE surface instead of a hole.
    private var backgroundStyle: AnyShapeStyle {
        guard hasPhysicalNotch else {
            if reduceTransparency {
                return AnyShapeStyle(ADE.surface)
            }
            return AnyShapeStyle(
                LinearGradient(colors: [ADE.card, ADE.bg], startPoint: .top, endPoint: .bottom)
            )
        }
        let height = max(1, CGFloat(size.height))
        let bandStop = min(1, bandHeight / height)
        guard bandStop < 0.999 else { return AnyShapeStyle(Color.black) }
        return AnyShapeStyle(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: bandStop),
                    .init(color: ADE.card, location: min(1, bandStop + 0.001)),
                    .init(color: ADE.bg, location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    /// A neutral hairline would disappear against a dark menu bar, so the
    /// contour carries a low-alpha wash of the current tone on top of ADE's
    /// border token.
    private var edgeStyle: LinearGradient {
        LinearGradient(
            colors: [
                toneColor.opacity(surfaceTone == .neutral ? 0.16 : 0.34),
                ADE.hairline,
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var surfaceAnimation: Animation? {
        if reduceMotion {
            return nil
        }
        if state == .compact {
            return .spring(response: 0.42, dampingFraction: 1, blendDuration: 0.08)
        }
        return .spring(response: 0.38, dampingFraction: 0.86, blendDuration: 0.1)
    }

    /// Content clears the hardware cutout in every state that grows past the
    /// menu bar; compact lives inside the band, in the ears.
    private var contentTopInset: CGFloat {
        guard hasPhysicalNotch else { return 0 }
        switch state {
        case .compact, .prehover:
            return 0
        case .peek, .expanded, .attention, .celebration:
            return bandHeight
        }
    }

    private var isMarkActive: Bool {
        item?.isAttention == true || state == .prehover || state == .peek
    }

    // MARK: - Copy

    private var compactIdentityLabel: String {
        itemPresentation?.compactIdentity ?? "ADE"
    }

    /// The canonical phase vocabulary from the renderer; no shortened synonyms.
    private var compactStatusLabel: String {
        item?.statusLabel ?? status?.compactLabel ?? "Ready"
    }

    private var peekTitle: String {
        itemPresentation?.title ?? status?.title ?? "ADE Attention Center"
    }

    private var peekSubtitle: String {
        item == nil ? (status?.message ?? "ADE is ready") : model.visiblePreview
    }

    private var peekStatusLabel: String {
        item?.statusLabel ?? status?.compactLabel ?? "Ready"
    }

    private var accountScopeLabel: String {
        if let status, model.items.isEmpty {
            return status.isProblem ? "Account attention unavailable" : "Account-wide activity"
        }
        if model.settings.hideDetails {
            return "Account-wide activity"
        }
        return attentionScopeSummary(
            itemCount: model.items.count,
            projectCount: Set(model.items.map(\.project.projectId)).count,
            machineCount: Set(model.items.map(\.machine.machineKey)).count
        )
    }

    private var accessibilitySummary: String {
        if let presentation = itemPresentation { return presentation.accessibilitySummary }
        if let status { return "\(status.title). \(status.message)" }
        return "ADE Attention Center"
    }

    private var accessibilityHint: String {
        if model.interaction.isExplicitlyInteractive {
            return "Press Escape to close"
        }
        return model.settings.expandedPanelEnabled
            ? "Click to expand ADE Attention Center"
            : "Click to preview ADE Attention Center"
    }
}

// MARK: - Shape

/// Rounded rectangle with independent top and bottom radii.
///
/// With a physical notch the top radius is zero and the surface is anchored to
/// the top of the display, so its black is continuous with the cutout. Built
/// from tangent arcs so `NotchPanelController`'s `NSBezierPath` hit region can
/// be assembled from the identical construction.
private struct NotchSurfaceShape: InsettableShape {
    let topRadius: CGFloat
    let bottomRadius: CGFloat
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let bounds = rect.insetBy(dx: insetAmount, dy: insetAmount)
        guard bounds.width > 0, bounds.height > 0 else { return Path() }
        let limit = min(bounds.width, bounds.height) / 2
        let top = max(0, min(topRadius, limit))
        let bottom = max(0, min(bottomRadius, limit))
        var path = Path()
        path.move(to: CGPoint(x: bounds.midX, y: bounds.minY))
        path.addArc(
            tangent1End: CGPoint(x: bounds.maxX, y: bounds.minY),
            tangent2End: CGPoint(x: bounds.maxX, y: bounds.maxY),
            radius: top
        )
        path.addArc(
            tangent1End: CGPoint(x: bounds.maxX, y: bounds.maxY),
            tangent2End: CGPoint(x: bounds.minX, y: bounds.maxY),
            radius: bottom
        )
        path.addArc(
            tangent1End: CGPoint(x: bounds.minX, y: bounds.maxY),
            tangent2End: CGPoint(x: bounds.minX, y: bounds.minY),
            radius: bottom
        )
        path.addArc(
            tangent1End: CGPoint(x: bounds.minX, y: bounds.minY),
            tangent2End: CGPoint(x: bounds.maxX, y: bounds.minY),
            radius: top
        )
        path.closeSubpath()
        return path
    }

    func inset(by amount: CGFloat) -> some InsettableShape {
        var copy = self
        copy.insetAmount += amount
        return copy
    }
}

// MARK: - Components

/// Bundled provider SVGs are loose resources, not asset-catalog entries, so
/// `Image(_:bundle:)` never resolves them. Load by URL and fall back to a
/// monogram rather than rendering an empty tile.
@MainActor
private enum ProviderIconStore {
    private static var cache: [String: NSImage?] = [:]

    static func image(named name: String) -> NSImage? {
        if let cached = cache[name] { return cached }
        let url = Bundle.module.url(forResource: name, withExtension: "svg", subdirectory: "ProviderIcons")
            ?? Bundle.module.url(forResource: name, withExtension: "svg")
        let image = url.flatMap { NSImage(contentsOf: $0) }
        image?.isTemplate = true
        cache[name] = image
        return image
    }
}

private struct ProviderMark: View {
    let item: AttentionItem?
    let status: NotchStatusPresentation?
    let diameter: CGFloat
    let active: Bool
    let reducedMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: !active || reducedMotion)) { timeline in
            let pulse = active && !reducedMotion
                ? (sin(timeline.date.timeIntervalSinceReferenceDate * 3.2) + 1) / 2
                : 0
            ZStack {
                RoundedRectangle(cornerRadius: diameter * 0.3, style: .continuous)
                    .fill(markGradient)
                    .overlay {
                        RoundedRectangle(cornerRadius: diameter * 0.3, style: .continuous)
                            .stroke(.white.opacity(0.14), lineWidth: 0.7)
                    }
                glyph
                    .foregroundStyle(.white.opacity(0.95))
                Circle()
                    .fill(toneColor)
                    .frame(width: diameter * 0.26, height: diameter * 0.26)
                    .overlay(Circle().stroke(ADE.bg, lineWidth: 1.1))
                    .shadow(color: toneColor.opacity(0.7), radius: 1.5 + pulse * 2)
                    .offset(x: diameter * 0.37, y: diameter * 0.37)
            }
            .frame(width: diameter, height: diameter)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var glyph: some View {
        if item == nil, let symbol = status?.symbolName {
            Image(systemName: symbol)
                .font(.system(size: diameter * 0.5, weight: .semibold))
        } else if let icon = providerIconName, let image = ProviderIconStore.image(named: icon) {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: diameter * 0.56, height: diameter * 0.56)
        } else if item?.kind == "pull_request" {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: diameter * 0.46, weight: .bold))
        } else {
            Text(monogram)
                .font(.system(size: diameter * 0.46, weight: .heavy))
        }
    }

    private var toneColor: Color {
        item.map { notchStatusColor(for: $0.phase) } ?? notchToneColor(status?.tone ?? .neutral)
    }

    private var providerName: String {
        let value = item?.provider?.lowercased() ?? ""
        if value.contains("codex") || value.contains("openai") { return "Codex" }
        if value.contains("claude") || value.contains("anthropic") { return "Claude" }
        if value.contains("cursor") { return "Cursor" }
        if value.contains("opencode") { return "OpenCode" }
        if value.contains("droid") || value.contains("factory") { return "Droid" }
        if let provider = item?.provider, !provider.isEmpty { return provider }
        return "ADE"
    }

    private var providerIconName: String? {
        switch providerName {
        case "Codex": return "openai"
        case "Claude": return "claude"
        case "Cursor": return "cursor"
        case "OpenCode": return "opencode"
        default: return item?.kind == "pull_request" ? "github" : nil
        }
    }

    private var monogram: String {
        String(providerName.prefix(1)).uppercased()
    }

    private var markGradient: LinearGradient {
        let colors: [Color]
        switch providerName {
        case "Claude": colors = [adeColor(0xD97757), adeColor(0x7A3F2C)]
        case "Cursor": colors = [adeColor(0x4C4F5A), adeColor(0x16181F)]
        case "OpenCode": colors = [adeColor(0x3FBF8F), adeColor(0x14503F)]
        case "Droid": colors = [adeColor(0xF5B23C), adeColor(0x7F4712)]
        case "Codex": colors = [adeColor(0x4A4F5C), adeColor(0x14171F)]
        default: colors = [ADE.accent, ADE.accentDeep]
        }
        return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// ADE's mark for the panel header: the accent gradient tile the app uses for
/// its own identity, tinted by the current tone.
private struct AttentionGlyph: View {
    let tone: NotchStatusTone

    var body: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(LinearGradient(colors: [ADE.accent, ADE.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(.white.opacity(0.16), lineWidth: 0.7)
            }
            .overlay {
                Image(systemName: "bell.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ADE.bg)
            }
            .frame(width: 26, height: 26)
            .accessibilityHidden(true)
    }
}

/// Matches `.attention-phase-pill`.
private struct PhasePill: View {
    let label: String
    let tone: NotchStatusTone

    var body: some View {
        let color = notchToneColor(tone)
        Text(label.uppercased())
            .font(.system(size: 8.5, weight: .heavy))
            .tracking(0.6)
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.24), lineWidth: 0.7))
    }
}

private struct PlanProgressBar: View {
    let progress: AttentionPlanProgress
    let tone: Color

    var body: some View {
        GeometryReader { geometry in
            let ratio = progress.total > 0
                ? min(1, max(0, Double(progress.completed) / Double(progress.total)))
                : 0
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.10))
                Capsule().fill(tone).frame(width: geometry.size.width * ratio)
            }
        }
        .frame(height: 3)
        .accessibilityLabel("\(progress.completed) of \(progress.total) steps complete")
    }
}

/// One-line truth about the stream when items are still on screen but may be
/// stale.
private struct StatusBanner: View {
    let status: NotchStatusPresentation

    var body: some View {
        let color = notchToneColor(status.tone)
        HStack(spacing: 8) {
            Image(systemName: status.symbolName)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(color)
            Text(status.title)
                .font(.system(size: ADE.fsXs, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let hint = status.hint {
                Text(hint)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.10))
    }
}

/// The expanded body when there is no item: empty-but-healthy, or broken.
private struct StatusBody: View {
    let status: NotchStatusPresentation

    var body: some View {
        let color = notchToneColor(status.tone)
        VStack(spacing: 9) {
            Spacer(minLength: 0)
            Image(systemName: status.symbolName)
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(color.opacity(status.isProblem ? 0.9 : 0.7))
            Text(status.title)
                .font(.system(size: ADE.fsSm + 1, weight: .semibold))
                .foregroundStyle(ADE.fg)
                .multilineTextAlignment(.center)
            Text(status.message)
                .font(.system(size: ADE.fsXs, weight: .regular))
                .foregroundStyle(ADE.secondaryFg)
                .multilineTextAlignment(.center)
                .lineLimit(3)
            if let hint = status.hint {
                Text(hint)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
    }
}

private struct ElapsedTimeLabel: View {
    let isoDate: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            Text(attentionElapsedLabel(since: isoDate, now: timeline.date))
                .font(.system(size: ADE.fs2xs, weight: .medium, design: .monospaced))
                .foregroundStyle(ADE.mutedFg)
        }
        .accessibilityLabel("Elapsed time")
    }
}

/// Primary uses ADE's accent on `--color-accent-fg`; secondary is the app's
/// ghost button.
private struct NotchButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: ADE.fsXs, weight: .semibold))
            .foregroundStyle(prominent ? ADE.bg : ADE.secondaryFg)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background {
                if prominent {
                    Capsule().fill(
                        LinearGradient(
                            colors: [ADE.accent, ADE.accentDeep],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .brightness(configuration.isPressed ? -0.06 : 0)
                } else {
                    Capsule()
                        .fill(.white.opacity(configuration.isPressed ? 0.12 : 0.06))
                        .overlay(Capsule().stroke(ADE.hairline, lineWidth: 0.8))
                }
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.12),
                value: configuration.isPressed
            )
    }
}

private struct NotchIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADE.secondaryFg)
            .frame(width: 24, height: 24)
            .background {
                Circle()
                    .fill(.white.opacity(configuration.isPressed ? 0.14 : 0.06))
                    .overlay(Circle().stroke(ADE.hairline, lineWidth: 0.8))
            }
    }
}

private struct CelebrationParticles: View {
    let active: Bool
    let reducedMotion: Bool

    @ViewBuilder
    var body: some View {
        if active && !reducedMotion {
            TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
                Canvas { context, size in
                    let elapsed = timeline.date.timeIntervalSinceReferenceDate
                    for index in 0..<16 {
                        let seed = Double((index * 47) % 101) / 101
                        let phase = elapsed.truncatingRemainder(dividingBy: 1.65) / 1.65
                        let x = size.width * (0.12 + 0.76 * Double((index * 37) % 97) / 97)
                        let drift = sin(seed * 19 + phase * 7) * 12
                        let y = size.height * (0.10 + phase * 0.84)
                        let opacity = max(0, 1 - phase * 1.18)
                        let rect = CGRect(x: x + drift, y: y, width: 3.5 + seed * 3, height: 6 + seed * 4)
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
    }

    private var palette: [Color] {
        [ADE.accent, notchToneColor(.cyan), notchToneColor(.emerald), notchToneColor(.violet), notchToneColor(.blue)]
    }
}
