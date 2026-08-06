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
            safeAreaTop: hasPhysicalNotch ? safeAreaTop : 0,
            strip: model.stripMetrics
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

    private var item: AttentionItem? { model.takeoverItem }
    private var itemPresentation: AttentionItemPresentation? {
        item?.presentation(hideDetails: model.settings.hideDetails)
    }
    private var status: NotchStatusPresentation? { model.statusPresentation }

    /// Tone of the whole surface: the selected item's phase, or the stream's
    /// own health when there is no item to show.
    private var surfaceTone: NotchStatusTone {
        if model.isAllClear { return .emerald }
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
                .animation(revealAnimation, value: model.isDormantHoverSurface)
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
        // #14: the bulge is pointer feedback, not a mode difference — it runs
        // identically whether the strip was pinned or just revealed.
        .scaleEffect(
            x: isBulging ? 1.008 : 1,
            y: isBulging ? 1.055 : 1,
            anchor: .top
        )
        .shadow(
            color: isBulging ? toneColor.opacity(0.28) : .clear,
            radius: isBulging ? 10 : 0,
            y: 2
        )
        .animation(bulgeAnimation, value: isBulging)
        .contentShape(shape)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint(accessibilityHint)
    }

    /// Only the resting strip reacts to the pointer: a panel or a card that
    /// bulged under the cursor would read as a hover target, not as content.
    private var isBulging: Bool {
        model.pointerInside && state == .compact && !reduceMotion
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .compact:
            compactContent
        case .expanded:
            expandedContent
        case .flash:
            flashContent
        case .celebration:
            celebrationContent
        }
    }

    // MARK: - Compact strip (#13)

    private var compactContent: some View {
        Group {
            if hasPhysicalNotch, let physicalNotchWidth {
                physicalCompactContent(notchWidth: physicalNotchWidth)
            } else {
                floatingCompactContent
            }
        }
    }

    /// Split around the hardware cutout: state groups on the left ear, one real
    /// signal on the right. Nothing is ever drawn under the cutout itself, and
    /// the ears are only as wide as what they carry.
    private func physicalCompactContent(notchWidth: Double) -> some View {
        let reserved = min(size.width - 96, clampedPhysicalNotchWidth(notchWidth))
        let earWidth = max(48, (size.width - reserved) / 2)
        return HStack(spacing: 0) {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                stripLeadingWing
            }
            .padding(.leading, 9)
            .padding(.trailing, 8)
            .frame(width: earWidth)

            Color.clear
                .frame(width: reserved)
                .accessibilityHidden(true)

            HStack(spacing: 0) {
                stripTrailingWing
                Spacer(minLength: 0)
            }
            .padding(.leading, 8)
            .padding(.trailing, 9)
            .frame(width: earWidth)
        }
        .frame(width: size.width, height: bandHeight)
    }

    private var floatingCompactContent: some View {
        HStack(spacing: 10) {
            stripLeadingWing
            Spacer(minLength: 6)
            stripTrailingWing
        }
        .padding(.horizontal, 12)
        .frame(height: CGFloat(size.height))
    }

    /// Every nonzero state group, glyph and count, most urgent first — replacing
    /// the repeated provider logos, which said "some agents exist" and nothing
    /// more. Amber is "your move" and nothing else borrows it.
    @ViewBuilder
    private var stripLeadingWing: some View {
        if model.isAllClear {
            AllClearBeat()
                .transition(.opacity.combined(with: .scale(scale: 0.85)))
        } else {
            let groups = model.stripGroups
            HStack(spacing: 9) {
                if groups.isEmpty {
                    StripIdentity(status: status)
                } else {
                    ForEach(groups) { group in
                        StripGroupBadge(
                            group: group,
                            pulses: group.kind == .needsYou && !reduceMotion,
                            landing: model.isTakeoverCollapsing && group.kind == .needsYou
                        )
                    }
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.8), value: groups)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(countsAccessibilityLabel)
        }
    }

    /// One signal, in both modes: "Checks failing #466", "Merged #1030",
    /// "Claude is asking" — and a quiet machine summary when nothing happened.
    private var stripTrailingWing: some View {
        let signal = model.topSignal
        return HStack(spacing: 5) {
            Image(systemName: signal.symbolName)
                .font(.system(size: signal.isNotable ? 8 : 7.5, weight: .bold))
                .foregroundStyle(
                    signal.isNotable ? notchToneColor(signal.tone) : ADE.mutedFg.opacity(0.8)
                )
            Text(signal.text)
                .font(.system(size: ADE.fs2xs, weight: signal.isNotable ? .semibold : .medium))
                .foregroundStyle(signal.isNotable ? ADE.fg : ADE.mutedFg)
                .lineLimit(1)
                .truncationMode(.tail)
                .monospacedDigit()
        }
        .layoutPriority(1)
        .id(signal.text)
        .transition(.opacity)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.28), value: signal.text)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(signal.text)
    }

    // MARK: - Flash takeover (#24)

    /// The needs-you card: a timed takeover, not a state. Two tight lines in the
    /// anatomy of ADE's own sidebar cards — mark, headline with elapsed and
    /// close, question, actions right — then it morphs back into the amber
    /// glyph it came from.
    @ViewBuilder
    private var flashContent: some View {
        if let toast = model.toastPresentation {
            let tone = notchToneColor(toast.resolvedTone)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    ProviderMark(
                        item: item,
                        status: status,
                        diameter: 20,
                        active: true,
                        reducedMotion: reduceMotion
                    )
                    Text(toast.title)
                        .font(.system(size: ADE.fsSm + 1, weight: .semibold))
                        .foregroundStyle(ADE.fg)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let anchor = item?.elapsedAnchor {
                        ElapsedTimeLabel(isoDate: anchor).fixedSize()
                    }
                    Button {
                        model.dismissTakeover()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(NotchIconButtonStyle(diameter: 18))
                    .accessibilityLabel("Dismiss \(toast.title)")
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(toast.subtitle ?? model.visiblePreview)
                        .font(.system(size: ADE.fsXs, weight: .regular))
                        .foregroundStyle(ADE.secondaryFg)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    HStack(spacing: 6) {
                        secondaryActionButtons
                        Button {
                            model.openSelected()
                        } label: {
                            Text("Open")
                        }
                        .buttonStyle(NotchButtonStyle(prominent: true))
                        .accessibilityHint("Opens the exact item in ADE")
                    }
                    .layoutPriority(1)
                }
                .padding(.leading, 28)
            }
            .padding(.horizontal, 14)
            .padding(.top, 9)
            .padding(.bottom, 11)
            .overlay(alignment: .leading) {
                // A hairline in the event's own tone, the same accent ADE's
                // sidebar cards carry.
                Capsule()
                    .fill(tone)
                    .frame(width: 2.5)
                    .padding(.vertical, 10)
                    .padding(.leading, 4)
            }
            // Clicking the card itself is an answer to it: the takeover ends and
            // the panel opens on what it was about. The buttons above win the
            // hit test, so this never steals Approve or Open.
            .contentShape(Rectangle())
            .onTapGesture { model.toggleExpanded() }
            .modifier(TakeoverMorph(
                collapsing: model.isTakeoverCollapsing,
                anchor: morphAnchor,
                reducedMotion: reduceMotion
            ))
        }
    }

    /// Where the card collapses to: the amber glyph's seat in the left wing.
    private var morphAnchor: UnitPoint {
        guard hasPhysicalNotch, let physicalNotchWidth else { return UnitPoint(x: 0.16, y: 0) }
        let width = max(1, size.width)
        let ear = (width - clampedPhysicalNotchWidth(physicalNotchWidth)) / 2
        return UnitPoint(x: min(0.45, (ear * 0.62) / width), y: 0)
    }

    // MARK: - Expanded panel (#15, #17)

    /// The desktop Activity dropdown, reachable from the notch: same section
    /// language, same row anatomy, same tones — plus the Agents/Events split the
    /// pane uses, because a PR outcome is not an agent.
    private var expandedContent: some View {
        VStack(spacing: 0) {
            expandedHeader
            expandedTabs
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
        .padding(.bottom, 10)
    }

    private var expandedTabs: some View {
        HStack(spacing: 6) {
            ForEach(NotchPanelTab.allCases, id: \.self) { tab in
                let count = tab == .agents ? model.agentCount : model.eventCount
                Button {
                    model.selectTab(tab)
                } label: {
                    HStack(spacing: 5) {
                        Text(tab.title)
                        if count > 0 {
                            Text("\(count)")
                                .monospacedDigit()
                                .opacity(0.75)
                        }
                    }
                }
                .buttonStyle(NotchTabStyle(selected: model.selectedTab == tab))
                .accessibilityLabel("\(tab.title), \(count)")
                .accessibilityAddTraits(model.selectedTab == tab ? [.isButton, .isSelected] : .isButton)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 9)
    }

    private var expandedList: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.panelRows) { row in
                        panelRow(row).id(row.id)
                    }
                    if model.panelRows.isEmpty {
                        EmptyTabBody(tab: model.selectedTab)
                    }
                }
                .padding(.bottom, 6)
            }
            .scrollIndicators(.automatic)
            .frame(maxHeight: .infinity)
            // Single-parameter form on purpose: the helper deploys to macOS 13,
            // where the newer two-parameter overload does not exist.
            .onChange(of: model.focusedRowId) { focused in
                guard let focused else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                    proxy.scrollTo(focused, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private func panelRow(_ row: NotchPanelRow) -> some View {
        switch row {
        case .section(let id, let title, let tone, let count, let collapsed):
            SectionHeader(
                label: title,
                count: count,
                tone: tone,
                collapsed: collapsed,
                focused: model.focusedRowId == row.id,
                onToggle: { model.toggleSection(id) }
            )
        case .item(let rowItem):
            NotchActivityRow(
                item: rowItem,
                hideDetails: model.settings.hideDetails,
                selected: rowItem.id == model.selectedItem?.id,
                focused: model.focusedRowId == row.id,
                indented: false,
                reducedMotion: reduceMotion,
                onOpen: { model.open(rowItem) },
                onDismiss: { model.dismiss(rowItem) },
                onFocus: { model.focus(rowItem) }
            )
        case .cluster(let cluster, let expanded):
            ClusterHeaderRow(
                cluster: cluster,
                expanded: expanded,
                focused: model.focusedRowId == row.id,
                onToggle: {
                    if cluster.count > 1 {
                        model.toggleCluster(cluster.id)
                    } else if let lead = cluster.lead {
                        model.open(lead)
                    }
                },
                onOpen: { cluster.lead.map { model.open($0) } }
            )
        case .clusterItem(let rowItem, _):
            NotchActivityRow(
                item: rowItem,
                hideDetails: model.settings.hideDetails,
                selected: rowItem.id == model.selectedItem?.id,
                focused: model.focusedRowId == row.id,
                indented: true,
                reducedMotion: reduceMotion,
                onOpen: { model.open(rowItem) },
                onDismiss: { model.dismiss(rowItem) },
                onFocus: { model.focus(rowItem) }
            )
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
    /// prominent button covers; one extra is all these layouts have room for.
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

    // MARK: - Celebration (#18)

    private var celebrationContent: some View {
        ZStack {
            ConfettiBurst(
                reducedMotion: reduceMotion,
                notchWidth: hasPhysicalNotch ? clampedPhysicalNotchWidth(physicalNotchWidth ?? 0) : nil
            )
            .allowsHitTesting(false)
            VStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(ADE.bg, notchToneColor(.emerald))
                Text(model.activeToast.map(toastStatusLabel(for:)) ?? "Merged")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ADE.fg)
                Text(model.toastPresentation?.title ?? itemPresentation?.celebrationTitle ?? "Pull request merged")
                    .font(.system(size: ADE.fsXs, weight: .medium))
                    .foregroundStyle(ADE.mutedFg)
                    .lineLimit(1)
                    .padding(.horizontal, 16)
            }
            .padding(.top, 12)
            .modifier(TakeoverMorph(
                collapsing: model.isTakeoverCollapsing,
                anchor: .top,
                reducedMotion: reduceMotion
            ))
        }
        .contentShape(Rectangle())
        .onTapGesture { model.toggleExpanded() }
    }

    /// The phase the takeover is about, or the treatment's own word when it is
    /// not tied to a row that is still on screen.
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

    /// Revealing in hover mode is a fade, not a growth: the rect is already the
    /// compact rect, which is the whole point of the two-mode redesign.
    private var revealAnimation: Animation? {
        reduceMotion ? nil : .easeOut(duration: 0.16)
    }

    private var bulgeAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.62)
    }

    /// Content clears the hardware cutout in every state that grows past the
    /// menu bar; compact lives inside the band, in the ears.
    private var contentTopInset: CGFloat {
        guard hasPhysicalNotch else { return 0 }
        switch state {
        case .compact:
            return 0
        case .expanded, .flash, .celebration:
            return bandHeight
        }
    }

    // MARK: - Copy

    private var countsAccessibilityLabel: String {
        let groups = model.stripGroups
        guard !groups.isEmpty else {
            return status?.compactLabel ?? "All agents idle"
        }
        return groups.map(\.accessibilityLabel).joined(separator: ", ")
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
        if state == .compact { return "ADE Activity. \(countsAccessibilityLabel). \(model.topSignal.text)" }
        if let presentation = itemPresentation { return presentation.accessibilitySummary }
        if let status { return "\(status.title). \(status.message)" }
        return "ADE Activity"
    }

    private var accessibilityHint: String {
        if model.interaction.isExplicitlyInteractive {
            return "Press Escape to close, arrow keys to move, Return to open"
        }
        return model.settings.expandedPanelEnabled
            ? "Click to open Activity"
            : "Click to open Activity in ADE"
    }
}

/// Mirrors the clamp the geometry applies, so the drawn cutout gap and the
/// measured one cannot disagree.
private func clampedPhysicalNotchWidth(_ width: Double) -> Double {
    max(140, min(240, width))
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

// MARK: - Strip components

/// Glyph plus count. One hue, one meaning: the filled amber dot only ever means
/// "your move", the open blue circle only ever means "still running".
private struct StripGroupBadge: View {
    let group: NotchStripGroup
    let pulses: Bool
    /// True while a takeover card is morphing back into this glyph, which
    /// answers the card with a short landing beat instead of a silent swap.
    let landing: Bool

    var body: some View {
        let tone = notchToneColor(group.tone)
        HStack(spacing: 3.5) {
            TimelineView(.animation(minimumInterval: 1 / 20, paused: !pulses)) { timeline in
                let pulse = pulses
                    ? (sin(timeline.date.timeIntervalSinceReferenceDate * 3.2) + 1) / 2
                    : 0
                Image(systemName: group.symbolName)
                    .font(.system(size: glyphSize, weight: .bold))
                    .foregroundStyle(tone)
                    .shadow(color: tone.opacity(0.55), radius: 0.8 + pulse * 2)
            }
            Text("\(group.count)")
                .font(.system(size: ADE.fs2xs, weight: .semibold))
                .foregroundStyle(tone)
                .monospacedDigit()
        }
        .scaleEffect(landing ? 1.24 : 1, anchor: .center)
        .animation(.spring(response: 0.3, dampingFraction: 0.55), value: landing)
        .accessibilityHidden(true)
    }

    /// The triangle and the notepad read a size larger than the dots at the
    /// same point size, so they are drawn a hair smaller.
    private var glyphSize: CGFloat {
        switch group.kind {
        case .needsYou: return 6.5
        case .working: return 7
        case .done: return 8
        case .failed, .planning: return 7.5
        }
    }
}

/// What the left wing says with nothing to count: the app's own name, or the
/// stream's problem when there is one.
private struct StripIdentity: View {
    let status: NotchStatusPresentation?

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: status?.symbolName ?? "circle.dashed")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(notchToneColor(status?.tone ?? .neutral))
            Text(status?.compactLabel ?? "ADE")
                .font(.system(size: ADE.fs2xs, weight: .semibold))
                .foregroundStyle(ADE.secondaryFg)
                .lineLimit(1)
        }
        .accessibilityHidden(true)
    }
}

/// The extra beat: the last amber row clearing is worth marking once, in the
/// strip, before it settles back to whatever is still running.
private struct AllClearBeat: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(notchToneColor(.emerald))
            Text("All clear")
                .font(.system(size: ADE.fs2xs, weight: .semibold))
                .foregroundStyle(notchToneColor(.emerald))
                .lineLimit(1)
        }
        .accessibilityLabel("All clear. Nothing needs you.")
    }
}

/// The out half of a takeover: shrink toward the glyph the card belongs to
/// while fading, so the card reads as *becoming* the count rather than as a
/// window that closed.
private struct TakeoverMorph: ViewModifier {
    let collapsing: Bool
    let anchor: UnitPoint
    let reducedMotion: Bool

    func body(content: Content) -> some View {
        content
            .scaleEffect(collapsing ? 0.42 : 1, anchor: anchor)
            .opacity(collapsing ? 0 : 1)
            .blur(radius: collapsing && !reducedMotion ? 1.6 : 0)
            .animation(
                reducedMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86),
                value: collapsing
            )
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
    let focused: Bool
    /// Rows inside an expanded event cluster hang under their header.
    let indented: Bool
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
            .padding(.leading, indented ? 30 : 14)
            .padding(.trailing, 14)
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
        .accessibilityAddTraits(focused ? [.isButton, .isSelected] : .isButton)
    }

    private var laneLabel: String {
        if hideDetails { return "Private" }
        let lane = item.laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return lane.isEmpty ? item.project.name : lane
    }

    @ViewBuilder
    private var rowBackground: some View {
        if focused {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(ADE.accent.opacity(0.14))
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(ADE.accent.opacity(0.5), lineWidth: 1)
                }
                .padding(.horizontal, 8)
        } else if selected || hovering {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(.white.opacity(hovering ? 0.06 : 0.035))
                .padding(.horizontal, 8)
        }
    }
}

/// One pull request, one story. Three failing checks on the same PR arrived as
/// three rows and read as three problems; here they read as one, with the
/// individual updates a disclosure away.
private struct ClusterHeaderRow: View {
    let cluster: NotchEventCluster
    let expanded: Bool
    let focused: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void

    @State private var hovering = false

    var body: some View {
        let tone = notchToneColor(cluster.tone)
        Button(action: onToggle) {
            HStack(spacing: 9) {
                Image(systemName: cluster.count > 1 ? "chevron.right" : "arrow.triangle.branch")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(ADE.mutedFg)
                    .rotationEffect(.degrees(expanded && cluster.count > 1 ? 90 : 0))
                    .frame(width: 10)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(cluster.title)
                            .font(.system(size: ADE.fsSm, weight: .semibold))
                            .foregroundStyle(ADE.fg)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Circle().fill(tone).frame(width: 4.5, height: 4.5)
                        Text(cluster.lead?.statusLabel ?? "")
                            .font(.system(size: ADE.fs2xs, weight: .semibold))
                            .foregroundStyle(tone)
                            .lineLimit(1)
                        if let anchor = cluster.lead?.elapsedAnchor {
                            ElapsedTimeLabel(isoDate: anchor).fixedSize()
                        }
                    }
                    HStack(spacing: 6) {
                        Text(cluster.subtitle)
                            .font(.system(size: ADE.fsXs, weight: .regular))
                            .foregroundStyle(ADE.secondaryFg.opacity(0.9))
                            .lineLimit(1)
                        if cluster.count > 1 {
                            Text(attentionPluralized(cluster.count, "update"))
                                .font(.system(size: ADE.fs2xs, weight: .medium))
                                .foregroundStyle(ADE.mutedFg)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(.white.opacity(0.05), in: Capsule())
                        }
                        Spacer(minLength: 4)
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
        .onHover { hovering = $0 }
        .overlay(alignment: .trailing) {
            if hovering {
                Button(action: onOpen) {
                    Image(systemName: "arrow.up.forward")
                }
                .buttonStyle(NotchIconButtonStyle())
                .padding(.trailing, 6)
                .accessibilityLabel("Open \(cluster.title) in ADE")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(cluster.accessibilityLabel)
        .accessibilityValue(cluster.count > 1 ? (expanded ? "Expanded" : "Collapsed") : "")
        .accessibilityHint(cluster.count > 1 ? "Shows every update on this pull request" : "Opens it in ADE")
        .accessibilityAddTraits(focused ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private var rowBackground: some View {
        if focused {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(ADE.accent.opacity(0.14))
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(ADE.accent.opacity(0.5), lineWidth: 1)
                }
                .padding(.horizontal, 8)
        } else if hovering {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(.white.opacity(0.06))
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

/// Collapsible, like every section in the desktop pane. The disclosure state is
/// spoken, not just drawn, so VoiceOver reports the same thing the chevron does.
private struct SectionHeader: View {
    let label: String
    let count: Int
    let tone: NotchStatusTone
    let collapsed: Bool
    let focused: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 7, weight: .black))
                    .foregroundStyle(ADE.mutedFg)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .frame(width: 8)
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
            .background(focused ? ADE.accent.opacity(0.16) : ADE.bg.opacity(0.94))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(count)")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint("Collapses or expands this section")
        .accessibilityAddTraits(focused ? [.isHeader, .isSelected] : .isHeader)
    }
}

/// A tab with nothing in it says so, rather than leaving a blank rectangle that
/// reads as a failure to load.
private struct EmptyTabBody: View {
    let tab: NotchPanelTab

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: tab == .agents ? "moon.zzz" : "checkmark.seal")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(ADE.mutedFg.opacity(0.7))
            Text(tab == .agents ? "No agents running." : "No pull request or check updates.")
                .font(.system(size: ADE.fsXs, weight: .medium))
                .foregroundStyle(ADE.secondaryFg)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
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
            .padding(.vertical, 5)
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

private struct NotchTabStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: ADE.fsXs, weight: .semibold))
            .foregroundStyle(selected ? ADE.fg : ADE.mutedFg)
            .padding(.horizontal, 10)
            .padding(.vertical, 4.5)
            .background {
                Capsule()
                    .fill(.white.opacity(selected ? 0.10 : (configuration.isPressed ? 0.07 : 0)))
                    .overlay(
                        Capsule().stroke(
                            selected ? ADE.accent.opacity(0.45) : Color.clear,
                            lineWidth: 0.9
                        )
                    )
            }
    }
}

private struct NotchIconButtonStyle: ButtonStyle {
    var diameter: CGFloat = 24

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: diameter * 0.375, weight: .bold))
            .foregroundStyle(ADE.secondaryFg)
            .frame(width: diameter, height: diameter)
            .background {
                Circle()
                    .fill(.white.opacity(configuration.isPressed ? 0.14 : 0.06))
                    .overlay(Circle().stroke(ADE.hairline, lineWidth: 0.8))
            }
    }
}

// MARK: - Confetti (#18)

/// One particle's whole life, decided once. Randomness is drawn from a fixed
/// seed at type-initialisation rather than per frame, so the burst is
/// deterministic, allocation-free while running, and identical on every replay.
private struct ConfettiParticle {
    let originSide: Double   // -1 left edge of the cutout, +1 right edge
    let velocityX: Double
    let velocityY: Double
    let width: Double
    let height: Double
    let spin: Double
    let phase: Double
    let colorIndex: Int
    let lifetime: Double
}

/// A real burst from the two notch edges rather than the old rain of rectangles
/// down the middle: ~1s, 44 particles, a single `Canvas` layer, no timers per
/// particle and no view per particle.
private struct ConfettiBurst: View {
    let reducedMotion: Bool
    /// Width of the hardware cutout, so the emitters sit on its corners. Nil on
    /// a Mac without one, where the card's own top corners are the emitters.
    let notchWidth: Double?

    @State private var startedAt = Date()

    private static let particles: [ConfettiParticle] = {
        // Deterministic 32-bit LCG (Numerical Recipes). A seeded generator, not
        // `Double.random`, so the burst cannot land badly one time in ten.
        var seed: UInt32 = 0x5A17_C0DE
        func next() -> Double {
            seed = 1_664_525 &* seed &+ 1_013_904_223
            return Double(seed >> 8) / Double(1 << 24)
        }
        return (0..<44).map { index in
            let side: Double = index.isMultiple(of: 2) ? -1 : 1
            // Fan upward and outward from the edge, never straight down.
            let spread = next()
            let angle = (.pi / 2.6) * (0.18 + 0.82 * spread)
            let speed = 190 + next() * 220
            return ConfettiParticle(
                originSide: side,
                velocityX: side * cos(angle) * speed * (0.55 + next() * 0.6),
                velocityY: -sin(angle) * speed,
                width: 2.6 + next() * 3.4,
                height: 4.5 + next() * 5,
                spin: (next() - 0.5) * 22,
                phase: next() * .pi * 2,
                colorIndex: Int(next() * 5) % 5,
                lifetime: 0.72 + next() * 0.4
            )
        }
    }()

    private static let gravity: Double = 940
    private static let burstSeconds: Double = 1.1

    var body: some View {
        if reducedMotion {
            // The calm alternative: one soft emerald wash instead of motion.
            LinearGradient(
                colors: [
                    notchToneColor(.emerald).opacity(0.22),
                    notchToneColor(.cyan).opacity(0.08),
                    .clear,
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .accessibilityHidden(true)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 60, paused: false)) { timeline in
                Canvas(opaque: false, rendersAsynchronously: false) { context, size in
                    let elapsed = timeline.date.timeIntervalSince(startedAt)
                    guard elapsed < Self.burstSeconds else { return }
                    draw(in: &context, size: size, elapsed: elapsed)
                }
            }
            .onAppear { startedAt = Date() }
            .accessibilityHidden(true)
        }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, elapsed: Double) {
        let gap = min(notchWidth ?? size.width * 0.5, size.width)
        let leftOrigin = CGPoint(x: (size.width - gap) / 2, y: 2)
        let rightOrigin = CGPoint(x: (size.width + gap) / 2, y: 2)

        for particle in Self.particles {
            let life = min(1, elapsed / particle.lifetime)
            guard life < 1 else { continue }
            let time = elapsed
            let origin = particle.originSide < 0 ? leftOrigin : rightOrigin
            // Ballistic with a light horizontal drag, so the fan opens fast and
            // then settles instead of shooting off the card.
            let drag = 1 - min(0.75, time * 0.9)
            let x = origin.x + particle.velocityX * time * drag
            let y = origin.y + particle.velocityY * time + 0.5 * Self.gravity * time * time
            guard y < size.height + 12, x > -12, x < size.width + 12 else { continue }

            var layer = context
            layer.opacity = life < 0.7 ? 1 : (1 - (life - 0.7) / 0.3)
            layer.translateBy(x: x, y: y)
            layer.rotate(by: .radians(particle.spin * time + particle.phase))
            // Flutter: the strip turns edge-on and back, which is what makes
            // paper confetti read as paper.
            let flutter = abs(cos(time * 6 + particle.phase))
            let rect = CGRect(
                x: -particle.width / 2,
                y: -particle.height / 2,
                width: particle.width * (0.35 + 0.65 * flutter),
                height: particle.height
            )
            layer.fill(
                Path(roundedRect: rect, cornerRadius: 1),
                with: .color(Self.palette[particle.colorIndex])
            )
        }
    }

    /// ADE's accent beside the tones a merge already owns — celebratory without
    /// borrowing amber, which means "your move" everywhere else.
    private static let palette: [Color] = [
        ADE.accent,
        notchToneColor(.emerald),
        notchToneColor(.cyan),
        notchToneColor(.violet),
        adeColor(0xF5F3FF),
    ]
}
