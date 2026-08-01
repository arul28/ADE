import AppKit
import SwiftUI
import ADEAttentionNotchCore

/// ADE design tokens, mirrored from `apps/desktop/src/renderer/index.css` and
/// the Activity pane's tone system. Values are duplicated rather than
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
            toastContent
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

    /// Split around the hardware cutout: the agents at work on the left ear,
    /// the account's counts on the right. Nothing is ever drawn under the
    /// cutout itself.
    private func physicalCompactContent(notchWidth: Double) -> some View {
        let reserved = min(size.width - 120, notchWidth + 14)
        let earWidth = max(64, (size.width - reserved) / 2)
        return HStack(spacing: 0) {
            HStack(spacing: 7) {
                Spacer(minLength: 0)
                compactIdentityCluster
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
            compactIdentityCluster
            Spacer(minLength: 4)
            if showsTicker {
                NotchTickerView(items: model.tickerItems, hideDetails: model.settings.hideDetails)
                    .frame(maxWidth: 150)
            }
            compactStatusCluster
        }
        .padding(.horizontal, 13)
        .frame(height: CGFloat(size.height))
    }

    /// Up to three agent marks. With N sessions running, one item's name and
    /// elapsed time is a lie about the other N-1 — the marks say "these are the
    /// agents at work" without claiming to be all of them.
    private var compactIdentityCluster: some View {
        let leading = model.leadingItems
        return HStack(spacing: leading.isEmpty ? 7 : -4) {
            if leading.isEmpty {
                ProviderMark(
                    item: nil,
                    status: status,
                    diameter: 18,
                    active: false,
                    reducedMotion: reduceMotion
                )
                Text(status?.compactLabel ?? "ADE")
                    .font(.system(size: ADE.fsXs, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else {
                ForEach(leading) { leadingItem in
                    ProviderMark(
                        item: leadingItem,
                        status: nil,
                        diameter: 16,
                        active: leadingItem.isAttention,
                        reducedMotion: reduceMotion
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 16 * 0.3, style: .continuous)
                            .stroke(hasPhysicalNotch ? Color.black : ADE.bg, lineWidth: 1.4)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    /// The account's shape, not one row's: `● 5` live and `⚠ 2 need you`. Short,
    /// fixed, and always fully legible.
    private var compactStatusCluster: some View {
        let counts = model.counts
        let liveCount = counts.working + counts.needsYou
        return HStack(spacing: 6) {
            if status?.isProblem == true, item != nil {
                // Items are still showing, but they may be stale.
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(notchToneColor(status?.tone ?? .amber))
            }
            if liveCount == 0 {
                Text(compactStatusLabel)
                    .font(.system(size: ADE.fs2xs, weight: .semibold))
                    .foregroundStyle(toneColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else {
                CountChip(
                    symbol: "circle.fill",
                    symbolSize: 5,
                    text: "\(liveCount)",
                    tone: notchToneColor(.blue),
                    pulses: !reduceMotion && counts.working > 0
                )
                if counts.needsYou > 0 {
                    CountChip(
                        symbol: "exclamationmark.triangle.fill",
                        symbolSize: 8,
                        text: "\(counts.needsYou) need\(counts.needsYou == 1 ? "s" : "") you",
                        tone: notchToneColor(.amber),
                        pulses: false
                    )
                }
            }
        }
        .layoutPriority(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(countsAccessibilityLabel)
    }

    // MARK: - Toast
    //
    // This is the old peek layout. Hover no longer opens it — a hover that grew
    // into a card competed with the toast it looked identical to — so the 316×76
    // geometry now belongs to events, and to the short card a click opens when
    // the tall panel is off.

    @ViewBuilder
    private var toastContent: some View {
        if let toast = model.toastPresentation {
            let tone = notchToneColor(toast.resolvedTone)
            HStack(spacing: 11) {
                ToastGlyph(treatment: toast.treatment, tone: tone, reducedMotion: reduceMotion)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(toast.title)
                            .font(.system(size: ADE.fsMd, weight: .semibold))
                            .foregroundStyle(ADE.fg)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(toastStatusLabel(for: toast))
                            .font(.system(size: ADE.fs2xs, weight: .bold))
                            .foregroundStyle(tone)
                            .lineLimit(1)
                    }
                    if let progress = itemPresentation?.planProgress,
                       progress.total > 0,
                       model.activeToast == nil {
                        PlanProgressBar(progress: progress, tone: tone)
                    } else if let subtitle = toast.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: ADE.fsXs, weight: .medium))
                            .foregroundStyle(ADE.secondaryFg)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 15)
            .padding(.top, 9)
        }
    }

    /// The phase the toast is about, or the treatment's own word when it is not
    /// tied to a row that is still on screen.
    private func toastStatusLabel(for toast: AttentionToast) -> String {
        if let itemId = toast.itemId,
           let match = model.items.first(where: { $0.id == itemId }) {
            return match.statusLabel
        }
        switch toast.treatment {
        case .celebration: return "Merged"
        case .success: return "Done"
        case .alert: return "Needs you"
        case .info: return status?.compactLabel ?? "Update"
        }
    }

    // MARK: - Expanded

    /// A scrolling list of every row the frame carried, filed under the same
    /// three headings as the desktop popover. The pager it replaced showed one
    /// card at a time, which was unusable the moment the feed went account-wide.
    private var expandedContent: some View {
        VStack(spacing: 0) {
            expandedHeader
            Rectangle().fill(ADE.hairline).frame(height: 0.8)
            // Only a banner when items are still on screen and may be stale;
            // with no items the body below already carries the same copy.
            if let status, status.isProblem, !model.items.isEmpty {
                StatusBanner(status: status)
                Rectangle().fill(ADE.hairline).frame(height: 0.8)
            }
            if model.items.isEmpty {
                if let status {
                    StatusBody(status: status)
                } else {
                    AllClearBody()
                }
            } else {
                expandedList
            }
            Rectangle().fill(ADE.hairline).frame(height: 0.8)
            expandedFooter
        }
    }

    private var expandedHeader: some View {
        HStack(spacing: 10) {
            AttentionGlyph(tone: surfaceTone)
            VStack(alignment: .leading, spacing: 2) {
                Text("Activity")
                    .font(.system(size: ADE.fsMd, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                Text(accountScopeLabel)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
            }
            Spacer(minLength: 8)
            Button {
                model.openSettings()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(NotchIconButtonStyle())
            .accessibilityLabel("Activity settings")
            .accessibilityHint("Opens Activity settings in ADE")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
    }

    private var expandedList: some View {
        let sections = model.sections
        return ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                expandedSection("Needs you", tone: .amber, items: sections.needsYou)
                expandedSection("Working", tone: .blue, items: sections.working)
                expandedSection("Done", tone: .emerald, items: sections.done)
            }
            .padding(.bottom, 6)
        }
        .scrollIndicators(.automatic)
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private func expandedSection(
        _ label: String,
        tone: NotchStatusTone,
        items: [AttentionItem]
    ) -> some View {
        if !items.isEmpty {
            Section {
                ForEach(items) { sectionItem in
                    NotchActivityRow(
                        item: sectionItem,
                        hideDetails: model.settings.hideDetails,
                        selected: sectionItem.id == model.selectedItem?.id,
                        reducedMotion: reduceMotion,
                        onOpen: { model.open(sectionItem) },
                        onDismiss: { model.dismiss(sectionItem) },
                        onFocus: { model.focus(sectionItem) }
                    )
                }
            } header: {
                SectionHeader(label: label, count: items.count, tone: tone)
            }
        }
    }

    private var expandedFooter: some View {
        HStack(spacing: 8) {
            if model.overflowCount > 0 {
                Text("+\(model.overflowCount) more")
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .monospacedDigit()
            }
            Spacer(minLength: 4)
            secondaryActionButtons
            Button {
                model.openActivity()
            } label: {
                Label("Open all in ADE", systemImage: "arrow.up.forward")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(NotchButtonStyle(prominent: true))
            .accessibilityHint("Opens Activity in ADE")
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 11)
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

    // MARK: - Attention / celebration

    private var attentionContent: some View {
        let toast = model.toastPresentation
        let tone = toast.map { notchToneColor($0.resolvedTone) } ?? toneColor
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                ProviderMark(item: item, status: status, diameter: 26, active: true, reducedMotion: reduceMotion)
                VStack(alignment: .leading, spacing: 2) {
                    Text(toast.map(toastStatusLabel(for:)) ?? item?.statusLabel ?? "Needs you")
                        .font(.system(size: ADE.fs2xs, weight: .bold))
                        .foregroundStyle(tone)
                    Text(toast?.title ?? itemPresentation?.title ?? "Needs you")
                        .font(.system(size: ADE.fsSm + 1, weight: .semibold))
                        .foregroundStyle(ADE.fg)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            Text(toast?.subtitle ?? model.visiblePreview)
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
                Text(model.activeToast.map(toastStatusLabel(for:)) ?? "Merged")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                Text(model.toastPresentation?.title ?? itemPresentation?.celebrationTitle ?? "Pull request merged")
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

    /// The pinned strip is the only mode that keeps a bar on screen at rest, so
    /// it is the only one with anywhere to run a ticker.
    private var showsTicker: Bool {
        model.settings.tickerEnabled
            && model.settings.revealMode == .minimal
            && !reduceMotion
            && !model.tickerItems.isEmpty
    }

    // MARK: - Copy

    /// The canonical phase vocabulary from the renderer; no shortened synonyms.
    /// Only used when the account has nothing live to count.
    private var compactStatusLabel: String {
        if model.counts.done > 0 { return "\(model.counts.done) done" }
        return status?.compactLabel ?? "All clear"
    }

    private var countsAccessibilityLabel: String {
        let counts = model.counts
        var parts: [String] = []
        if counts.needsYou > 0 {
            parts.append("\(counts.needsYou) need\(counts.needsYou == 1 ? "s" : "") you")
        }
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.done > 0 { parts.append("\(counts.done) done") }
        return parts.isEmpty ? "All agents idle" : parts.joined(separator: ", ")
    }

    private var accountScopeLabel: String {
        if let status, model.items.isEmpty {
            return status.isProblem ? "Activity unavailable" : "Account-wide activity"
        }
        if model.settings.hideDetails {
            return "Account-wide activity"
        }
        let counts = model.counts
        return [
            attentionPluralized(counts.total, "session"),
            "\(counts.machinesOnline)/\(counts.machinesTotal) machines online",
        ].joined(separator: " · ")
    }

    private var accessibilitySummary: String {
        if state == .expanded { return "Activity. \(countsAccessibilityLabel)" }
        if let presentation = itemPresentation { return presentation.accessibilitySummary }
        if let status { return "\(status.title). \(status.message)" }
        return "ADE Activity"
    }

    private var accessibilityHint: String {
        if model.interaction.isExplicitlyInteractive {
            return "Press Escape to close"
        }
        return model.settings.expandedPanelEnabled
            ? "Click to open Activity"
            : "Click to preview Activity"
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

/// The Swift mirror of the renderer's compact `ActivityCard`: provider mark,
/// status dot + label + elapsed, title, lane, machine. Same anatomy and the
/// same one-hue-one-meaning table, so a row reads identically in the notch and
/// in the desktop popover.
private struct NotchActivityRow: View {
    let item: AttentionItem
    let hideDetails: Bool
    let selected: Bool
    let reducedMotion: Bool
    let onOpen: () -> Void
    let onDismiss: () -> Void
    let onFocus: () -> Void

    @State private var hovering = false

    var body: some View {
        let presentation = item.presentation(hideDetails: hideDetails)
        let tone = notchStatusColor(for: item.phase)
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 9) {
                ProviderMark(
                    item: item,
                    status: nil,
                    diameter: 20,
                    active: item.isAttention && !reducedMotion,
                    reducedMotion: reducedMotion
                )
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(presentation.title)
                            .font(.system(size: ADE.fsSm, weight: .medium))
                            .foregroundStyle(ADE.fg)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Circle()
                            .fill(tone)
                            .frame(width: 4.5, height: 4.5)
                        Text(item.statusLabel)
                            .font(.system(size: ADE.fs2xs, weight: .semibold))
                            .foregroundStyle(tone)
                            .lineLimit(1)
                        // `statusSince` is immutable for the life of a phase;
                        // `occurredAt` is the honest approximation while a
                        // publisher predates it.
                        ElapsedTimeLabel(isoDate: item.elapsedAnchor)
                            .fixedSize()
                    }
                    HStack(spacing: 6) {
                        Text(laneLabel)
                            .font(.system(size: ADE.fsXs, weight: .medium))
                            .foregroundStyle(ADE.mutedFg)
                            .lineLimit(1)
                        if !presentation.preview.isEmpty {
                            Text("·").foregroundStyle(ADE.mutedFg.opacity(0.5))
                            Text(presentation.preview)
                                .font(.system(size: ADE.fsXs, weight: .regular))
                                .italic()
                                .foregroundStyle(ADE.secondaryFg.opacity(0.85))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        MachineChip(machine: item.machine, hideDetails: hideDetails)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rowBackground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // An offline machine's rows are last-known state, not observed state.
        .opacity(item.machine.online ? 1 : 0.55)
        .onHover { inside in
            hovering = inside
            if inside { onFocus() }
        }
        .overlay(alignment: .trailing) {
            if hovering {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                }
                .buttonStyle(NotchIconButtonStyle())
                .padding(.trailing, 6)
                .accessibilityLabel("Dismiss \(presentation.title)")
            }
        }
        .contextMenu {
            Button("Open in ADE", action: onOpen)
            Button("Dismiss", action: onDismiss)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilitySummary)
        .accessibilityAddTraits(.isButton)
    }

    private var laneLabel: String {
        if hideDetails { return "Private" }
        let lane = item.laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return lane.isEmpty ? item.project.name : lane
    }

    @ViewBuilder
    private var rowBackground: some View {
        if selected || hovering {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(.white.opacity(hovering ? 0.06 : 0.035))
                .padding(.horizontal, 8)
        }
    }
}

/// Neutral by design: amber means "your move" everywhere in Activity, so a
/// machine chip may never borrow it for identity.
private struct MachineChip: View {
    let machine: AttentionMachine
    let hideDetails: Bool

    var body: some View {
        if hideDetails {
            EmptyView()
        } else {
            HStack(spacing: 3) {
                Image(systemName: portable ? "laptopcomputer" : "desktopcomputer")
                    .font(.system(size: 8, weight: .medium))
                Text(machine.name)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(ADE.mutedFg.opacity(machine.online ? 0.75 : 0.4))
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(.white.opacity(0.04), in: Capsule())
        }
    }

    /// A read of the name, not a hardware fact — decoration either way.
    private var portable: Bool {
        machine.name.range(
            of: "macbook|laptop|air|book",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }
}

private struct SectionHeader: View {
    let label: String
    let count: Int
    let tone: NotchStatusTone

    var body: some View {
        HStack(spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 8.5, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(notchToneColor(tone))
            Text("\(count)")
                .font(.system(size: 8.5, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(ADE.mutedFg)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 9)
        .padding(.bottom, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADE.bg.opacity(0.94))
    }
}

/// The pinned strip's ticker: what each live agent is doing, one at a time.
/// Gated on the ticker setting and on reduced motion by its caller — a
/// cross-fading strip is exactly the kind of ambient movement that setting is
/// about.
private struct NotchTickerView: View {
    let items: [AttentionItem]
    let hideDetails: Bool

    private static let intervalSeconds: Double = 4

    var body: some View {
        TimelineView(.periodic(from: .now, by: Self.intervalSeconds)) { timeline in
            if let current = item(at: timeline.date) {
                Text(current.presentation(hideDetails: hideDetails).preview)
                    .font(.system(size: ADE.fs2xs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .id(current.id)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.35), value: current.id)
            }
        }
        .accessibilityHidden(true)
    }

    private func item(at date: Date) -> AttentionItem? {
        guard !items.isEmpty else { return nil }
        let step = Int(date.timeIntervalSinceReferenceDate / Self.intervalSeconds)
        return items[((step % items.count) + items.count) % items.count]
    }
}

/// `● 5` / `⚠ 2 need you` — the account's shape in the space of a phase label.
private struct CountChip: View {
    let symbol: String
    let symbolSize: CGFloat
    let text: String
    let tone: Color
    let pulses: Bool

    var body: some View {
        HStack(spacing: 3.5) {
            TimelineView(.animation(minimumInterval: 1 / 20, paused: !pulses)) { timeline in
                let pulse = pulses
                    ? (sin(timeline.date.timeIntervalSinceReferenceDate * 3.2) + 1) / 2
                    : 0
                Image(systemName: symbol)
                    .font(.system(size: symbolSize, weight: .bold))
                    .foregroundStyle(tone)
                    .shadow(color: tone.opacity(0.6), radius: 1 + pulse * 2)
            }
            Text(text)
                .font(.system(size: ADE.fs2xs, weight: .semibold))
                .foregroundStyle(tone)
                .monospacedDigit()
                .lineLimit(1)
        }
    }
}

private struct ToastGlyph: View {
    let treatment: NotchToastTreatment
    let tone: Color
    let reducedMotion: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(tone.opacity(0.16))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(tone.opacity(0.32), lineWidth: 0.8)
                }
            Image(systemName: symbolName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tone)
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }

    private var symbolName: String {
        switch treatment {
        case .celebration: return "checkmark.seal.fill"
        case .success: return "checkmark.circle.fill"
        case .alert: return "exclamationmark.triangle.fill"
        case .info: return "bell.fill"
        }
    }
}

/// Nothing wrong, nothing running — said plainly rather than left blank, so an
/// empty panel never reads as a broken one.
private struct AllClearBody: View {
    var body: some View {
        VStack(spacing: 8) {
            Spacer(minLength: 0)
            Image(systemName: "moon.zzz")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(ADE.mutedFg.opacity(0.7))
            Text("All agents idle.")
                .font(.system(size: ADE.fsSm + 1, weight: .semibold))
                .foregroundStyle(ADE.fg)
            Text("Nothing is running anywhere on your account.")
                .font(.system(size: ADE.fsXs, weight: .regular))
                .foregroundStyle(ADE.secondaryFg)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 26)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
