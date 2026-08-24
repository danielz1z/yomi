import AVFoundation
import Cocoa
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Image Caching & Remote Avatar Loader

final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let memoryCache = NSCache<NSURL, NSImage>()
    private let cacheDir: URL

    init() {
        memoryCache.countLimit = 300
        let paths = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
        cacheDir = paths[0].appendingPathComponent("yomi/avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    func image(for url: URL) -> NSImage? {
        if let mem = memoryCache.object(forKey: url as NSURL) {
            return mem
        }
        let safeKey =
            url.absoluteString.data(using: .utf8)?.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-") ?? "\(url.hashValue)"
        let fileUrl = cacheDir.appendingPathComponent(safeKey)
        if let data = try? Data(contentsOf: fileUrl), let img = NSImage(data: data) {
            memoryCache.setObject(img, forKey: url as NSURL)
            return img
        }
        return nil
    }

    func memoryImage(for url: URL) -> NSImage? {
        memoryCache.object(forKey: url as NSURL)
    }

    func save(image: NSImage, data: Data, for url: URL) {
        memoryCache.setObject(image, forKey: url as NSURL)
        let safeKey =
            url.absoluteString.data(using: .utf8)?.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-") ?? "\(url.hashValue)"
        let fileUrl = cacheDir.appendingPathComponent(safeKey)
        try? data.write(to: fileUrl, options: .atomic)
    }
}

final class ImageLoader: ObservableObject, @unchecked Sendable {
    @Published var image: NSImage?
    private var currentUrl: URL?

    func load(urlStr: String) {
        guard !urlStr.isEmpty else {
            self.image = nil
            return
        }
        let normalized = urlStr.replacingOccurrences(of: "line-scdn.net//", with: "line-scdn.net/")
        guard let url = URL(string: normalized) else {
            self.image = nil
            return
        }
        if currentUrl == url && self.image != nil {
            return
        }
        self.currentUrl = url
        if let cached = ImageCache.shared.memoryImage(for: url) {
            self.image = cached
            return
        }
        DispatchQueue.global(qos: .utility).async {
            if let cached = ImageCache.shared.image(for: url) {
                DispatchQueue.main.async {
                    if self.currentUrl == url { self.image = cached }
                }
                return
            }
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data = data, let img = NSImage(data: data) else { return }
                ImageCache.shared.save(image: img, data: data, for: url)
                DispatchQueue.main.async {
                    if self.currentUrl == url { self.image = img }
                }
            }.resume()
        }
    }
}

struct CachedAvatarView: View {
    let pictureUrl: String?
    let title: String
    var mid: String = ""
    var size: CGFloat = 38
    var isMuted: Bool = false

    @StateObject private var loader = ImageLoader()

    var monogramText: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return String(trimmed.prefix(1))
        }
        if !mid.isEmpty {
            return String(mid.prefix(2).uppercased())
        }
        return "Y"
    }

    var body: some View {
        ZStack {
            if let image = loader.image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                fallbackMonogram
            }
        }
        .frame(width: size, height: size)
        .overlay(
            Circle()
                .stroke(Color.white.opacity(0.18), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 3, x: 0, y: 1.5)
        .onAppear {
            if let url = pictureUrl, !url.isEmpty {
                loader.load(urlStr: url)
            }
        }
        .onChange(of: pictureUrl) { _, newUrl in
            if let url = newUrl, !url.isEmpty {
                loader.load(urlStr: url)
            } else {
                loader.image = nil
            }
        }
    }

    var fallbackMonogram: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        gradient: Gradient(
                            colors: isMuted
                                ? [
                                    Color.white.opacity(0.12),
                                    Color.white.opacity(0.08),
                                ]
                                : [
                                    EnterpriseTheme.accent.opacity(0.9),
                                    EnterpriseTheme.accent,
                                ]),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(monogramText)
                .font(.system(size: max(10, size * 0.38), weight: .bold))
                .foregroundColor(.white)
        }
    }
}

// MARK: - LINE Chat Models

struct LineChatItem: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var lastMessage: String
    var timeString: String
    var timestamp: Double?
    var unreadCount: Int
    var isMuted: Bool
    var isGroup: Bool
    var hasMention: Bool
    var pictureUrl: String?
    var isOfficial: Bool?
    var attentionScore: Int
    var attentionTier: AttentionTier
    var attentionReason: String
    var timestampValue: Double { timestamp ?? 0 }

    /// Single source of truth for the attention inbox. Unread alone is not
    /// sufficient: official promotions are down-ranked while requests,
    /// deadlines and explicit user priority are explainable signals.
    var needsAttention: Bool {
        attentionEvaluation.tier != .filtered && (unreadCount > 0 || hasMention || YomiAttentionPolicyStore.isPriority(id))
    }
}

struct AttentionRefinement: Codable {
    let id: String
    let attentionScore: Int
    let attentionTier: AttentionTier
    let attentionReason: String
}

struct LineChatMessage: Identifiable, Codable, Hashable {
    let id: String
    var fromMid: String
    var fromName: String
    var fromPictureUrl: String?
    var isSelf: Bool
    var text: String
    var timeString: String
    var timestamp: Double?
    var contentType: Int?
    var mediaType: String?
    var mediaUrl: String?
    var actionUrl: String?
    var fileName: String?
    var isDecryptFailure: Bool?
    var isUnsent: Bool?
    var mentionRanges: [MessageTextRange]?
    // LINE's message payload has no recipient-read timestamp. Do not derive
    // a read badge from isSelf or deliveredTime; that would claim a state the
    // protocol did not report.
}

struct MessageTextRange: Codable, Hashable {
    let location: Int
    let length: Int
}

struct LineMentionTarget: Codable, Hashable {
    let mid: String
    let name: String
}

struct StickerPackageItem: Identifiable, Codable, Hashable {
    let packageId: String
    let title: String
    let version: String
    var id: String { packageId }
}

struct StickerPreviewItem: Identifiable, Codable, Hashable {
    let stickerId: String
    let packageId: String
    let data: String
    let mimeType: String
    var id: String { "\(packageId):\(stickerId)" }
}

struct MediaPreviewPayload: Codable {
    let data: String
    let mimeType: String?
    let fileName: String?
}

/// Defense-in-depth for stale runtimes or an unexpected raw bridge payload.
/// The TypeScript boundary is authoritative, but the desktop must never paint
/// E2EE transport fields even if an older dist/bridge is still running.
func sanitizeDesktopMessagePreview(_ value: String) -> String {
    let lower = value.lowercased()
    let sensitive = ["keymaterial", "ciphertext", "nonce", "chunks", "keys"]
    if sensitive.contains(where: { lower.contains("\"\($0)\"") || lower.contains("\($0):") }) {
        return "[加密訊息]"
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("{") else { return value }
    guard let data = trimmed.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return value
    }
    for key in ["text", "message", "body", "content", "caption"] {
        if let nested = object[key] as? String {
            let safe = sanitizeDesktopMessagePreview(nested)
            if safe != nested || !safe.isEmpty { return safe }
        }
    }
    return "[加密訊息]"
}

// MARK: - Attention-First Chat List Row

private struct SearchHighlightedText: View {
    let value: String
    let query: String
    let fontSize: CGFloat
    let weight: Font.Weight
    let color: Color
    var matchColor: Color = EnterpriseTheme.accent

    private var highlighted: Text {
        var output = Text("")
        var cursor = value.startIndex
        for range in searchMatchRanges(in: value, query: query) {
            if cursor < range.lowerBound {
                output = Text("\(output)\(Text(String(value[cursor..<range.lowerBound])).foregroundColor(color))")
            }
            let match = Text(String(value[range]))
                .font(.system(size: fontSize, weight: .bold))
                .foregroundColor(matchColor)
            output = Text("\(output)\(match)")
            cursor = range.upperBound
        }
        if cursor < value.endIndex {
            output = Text("\(output)\(Text(String(value[cursor...])).foregroundColor(color))")
        }
        return output
    }

    var body: some View {
        highlighted
            .font(.system(size: fontSize, weight: weight))
            .lineLimit(1)
    }
}

struct ChatRowView: View {
    @ObservedObject var state: AppState
    let item: LineChatItem
    var isSelected: Bool = false
    var searchQuery: String = ""
    let onSelect: () -> Void
    @State private var isHovered: Bool = false

    // Selected rows use a deep ink/accent surface in both appearances. Keep
    // every trailing value derived from the row state so an unread accent
    // never wins over the selected-state contrast colour.
    private var timeColor: Color {
        if isSelected { return EnterpriseTheme.selectedSecondaryText }
        return item.unreadCount > 0 && !item.isMuted
            ? EnterpriseTheme.accent
            : EnterpriseTheme.secondaryText
    }

    private var selectedBadgeBackground: Color {
        isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
    }

    private var selectedBadgeText: Color {
        isSelected ? EnterpriseTheme.selected : Color.white
    }

    var body: some View {
        Button(action: {
            onSelect()
        }) {
            HStack(spacing: 10) {
                // 1. Avatar (Cached)
                CachedAvatarView(
                    pictureUrl: item.pictureUrl,
                    title: item.title,
                    size: 38,
                    isMuted: item.isMuted
                )

                // 2. Middle column: Title and message preview
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        SearchHighlightedText(
                            value: item.title,
                            query: searchQuery,
                            fontSize: 14.5,
                            weight: isSelected ? .bold : .semibold,
                            color: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.text,
                            matchColor: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                        )

                        if item.isGroup {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 12))
                                .foregroundColor(isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText)
                        }
                    }

                    SearchHighlightedText(
                        value: searchDisplayText(item.lastMessage, query: searchQuery).value,
                        query: searchQuery,
                        fontSize: 13,
                        weight: .regular,
                        color: isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText,
                        matchColor: isSelected ? EnterpriseTheme.selectedText : EnterpriseTheme.accent
                    )
                }

                Spacer(minLength: 8)

                // 3. Right column: Timestamp (Top) & Badges/Mute (Bottom)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(item.timeString)
                        .font(.system(size: 12, weight: item.unreadCount > 0 && !item.isMuted ? .semibold : .regular))
                        .foregroundColor(timeColor)

                    HStack(spacing: 4) {
                        // Reserve both trailing slots even when absent. This
                        // keeps mute icons and unread badges on one reference
                        // line across every row state.
                        Group {
                            if item.isMuted {
                                Image(systemName: "bell.slash.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(isSelected ? EnterpriseTheme.selectedSecondaryText : EnterpriseTheme.secondaryText)
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: 18, height: 18, alignment: .center)

                        Group {
                            if item.unreadCount > 0 {
                                Text("\(item.unreadCount)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(selectedBadgeText)
                                    .padding(.horizontal, 5.5)
                                    .padding(.vertical, 1)
                                    .background(
                                        item.isMuted
                                            ? (isSelected
                                                ? EnterpriseTheme.selectedSecondaryText.opacity(0.42) : Color.secondary.opacity(0.35))
                                            : selectedBadgeBackground
                                    )
                                    .clipShape(Capsule())
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: 28, height: 18, alignment: .center)
                    }
                    .frame(height: 18, alignment: .trailing)
                }
                // Keep the trailing reference line stable when macOS adds or
                // removes the overlay scrollbar. The row owns a fixed gutter;
                // timestamps and badges never reflow with indicator changes.
                .frame(width: 58, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .background(
                isSelected
                    ? EnterpriseTheme.selected
                    : (isHovered ? EnterpriseTheme.raisedSurface : Color.clear)
            )
            .cornerRadius(8)
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { hovering in
            isHovered = hovering
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(item.title). \(item.lastMessage)"))
        .accessibilityValue(Text(isSelected ? "已選取" : ""))
        .contextMenu {
            Button(action: { state.setYomiMuted(chatId: item.id, enabled: !item.effectiveMuted) }) {
                Label(item.effectiveMuted ? "恢復 Yomi 關注" : "Yomi 暫不關注", systemImage: item.effectiveMuted ? "bell" : "bell.slash")
            }
            Button(action: { state.setYomiPriority(chatId: item.id, enabled: !YomiAttentionPolicyStore.isPriority(item.id)) }) {
                Label(YomiAttentionPolicyStore.isPriority(item.id) ? "取消優先" : "永遠列為優先", systemImage: "bolt.fill")
            }
            Divider()
            Button(action: { state.reportUnsupportedLineMute(chatId: item.id) }) {
                Label(item.isMuted ? "LINE 已靜音（由 LINE 管理）" : "LINE 靜音…", systemImage: "bell.slash.fill")
            }
            .disabled(item.isMuted)
        }
    }
}

// MARK: - Message Media & Bubble Rows
