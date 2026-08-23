import Cocoa
import SwiftUI

enum YomiKomainuMode {
    case line
    case yomi

    fileprivate var resourceName: String {
        switch self {
        case .line: return "YomiKomainuLine"
        case .yomi: return "YomiKomainuAgent"
        }
    }
}

private enum YomiKomainuResources {
    static let line = load("YomiKomainuLine")
    static let yomi = load("YomiKomainuAgent")

    private static func load(_ name: String) -> NSImage? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "svg"),
            let image = NSImage(contentsOf: url)
        else { return nil }
        image.isTemplate = false
        return image
    }

    static func image(for mode: YomiKomainuMode) -> NSImage? {
        mode == .line ? line : yomi
    }
}

/// Approved full-pose komainu seal artwork. Both SVGs share one bounding box;
/// the mode switch swaps them in place without layout movement.
struct YomiGuardiansMark: View {
    var mode: YomiKomainuMode = .yomi
    var size: CGFloat = 16
    var color: Color = EnterpriseTheme.accent

    var body: some View {
        Group {
            if let artwork = YomiKomainuResources.image(for: mode) {
                Image(nsImage: artwork)
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .aspectRatio(contentMode: .fit)
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        HStack(spacing: -size * 0.12) {
            Circle().stroke(color, lineWidth: max(1.2, size * 0.10))
            Circle().fill(color.opacity(0.18)).overlay(Circle().stroke(color, lineWidth: max(1.2, size * 0.10)))
        }
    }
}

/// A quiet seal impression for low-information surfaces. It never carries
/// meaning or receives input; foreground content remains the attention owner.
struct YomiGuardiansWatermark: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .bottom, spacing: -24) {
            YomiGuardiansMark(mode: .line, size: 150)
                .rotationEffect(.degrees(-4))
            YomiGuardiansMark(mode: .yomi, size: 164)
                .rotationEffect(.degrees(3))
        }
        .opacity(colorScheme == .dark ? 0.045 : 0.035)
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
