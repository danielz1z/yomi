import Foundation

private struct DesktopChatSnapshot: Codable {
    let savedAt: Date
    let chats: [LineChatItem]
}

enum DesktopChatSnapshotStore {
    private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi", isDirectory: true)
            .appendingPathComponent("chat-list-v1.json")
    }

    static func load() -> [LineChatItem] {
        guard let credentials = CredentialManager.loadCredentials(),
            credentials.lineAuthToken?.isEmpty == false,
            let url,
            let data = try? Data(contentsOf: url),
            let snapshot = try? JSONDecoder().decode(DesktopChatSnapshot.self, from: data),
            Date().timeIntervalSince(snapshot.savedAt) < maximumAge
        else { return [] }
        return snapshot.chats
    }

    static func save(_ chats: [LineChatItem]) {
        guard let url else { return }
        let snapshot = DesktopChatSnapshot(savedAt: Date(), chats: chats)
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}
