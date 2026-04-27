import SwiftUI

struct LanePaletteColor: Identifiable, Hashable {
  let hex: String
  let name: String

  var id: String { hex.lowercased() }

  var color: Color {
    LaneColorPalette.color(forHex: hex) ?? Color.gray
  }
}

enum LaneColorPalette {
  static let entries: [LanePaletteColor] = [
    LanePaletteColor(hex: "#a78bfa", name: "Violet"),
    LanePaletteColor(hex: "#60a5fa", name: "Blue"),
    LanePaletteColor(hex: "#34d399", name: "Emerald"),
    LanePaletteColor(hex: "#fbbf24", name: "Amber"),
    LanePaletteColor(hex: "#f472b6", name: "Pink"),
    LanePaletteColor(hex: "#fb923c", name: "Orange"),
    LanePaletteColor(hex: "#2dd4bf", name: "Teal"),
    LanePaletteColor(hex: "#c084fc", name: "Purple"),
    LanePaletteColor(hex: "#f87171", name: "Red"),
    LanePaletteColor(hex: "#a3e635", name: "Lime"),
    LanePaletteColor(hex: "#22d3ee", name: "Cyan"),
    LanePaletteColor(hex: "#e879f9", name: "Fuchsia"),
  ]

  static let fallbacks: [String] = Array(entries.prefix(8)).map(\.hex)

  static func color(forHex raw: String?) -> Color? {
    guard let raw, !raw.isEmpty else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleaned = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
    guard cleaned.count == 6 || cleaned.count == 8 else { return nil }
    var value: UInt64 = 0
    guard Scanner(string: cleaned).scanHexInt64(&value) else { return nil }
    let r, g, b, a: Double
    if cleaned.count == 8 {
      r = Double((value >> 24) & 0xFF) / 255.0
      g = Double((value >> 16) & 0xFF) / 255.0
      b = Double((value >> 8) & 0xFF) / 255.0
      a = Double(value & 0xFF) / 255.0
    } else {
      r = Double((value >> 16) & 0xFF) / 255.0
      g = Double((value >> 8) & 0xFF) / 255.0
      b = Double(value & 0xFF) / 255.0
      a = 1.0
    }
    return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
  }

  static func name(forHex hex: String?) -> String? {
    guard let hex else { return nil }
    let lower = hex.lowercased()
    return entries.first(where: { $0.hex.lowercased() == lower })?.name
  }

  static func colorsInUse(amongLanes lanes: [LaneSummary], excluding excludedLaneId: String? = nil) -> Set<String> {
    var result = Set<String>()
    for lane in lanes {
      if lane.archivedAt != nil { continue }
      if let excludedLaneId, lane.id == excludedLaneId { continue }
      if let raw = lane.color, !raw.isEmpty {
        result.insert(raw.lowercased())
      }
    }
    return result
  }

  static func nextAvailableColor(amongLanes lanes: [LaneSummary]) -> String? {
    let used = colorsInUse(amongLanes: lanes)
    return entries.first(where: { !used.contains($0.hex.lowercased()) })?.hex
  }

  static func accent(forLane lane: LaneSummary?, fallbackIndex: Int = 0) -> Color? {
    if let raw = lane?.color, let parsed = color(forHex: raw) { return parsed }
    let hex = fallbacks[fallbackIndex % fallbacks.count]
    return color(forHex: hex)
  }
}
