import AVFoundation
import Cocoa
import Combine
import Dispatch
import SwiftUI
import UniformTypeIdentifiers

private final class BoolCallbackBox: @unchecked Sendable {
    let call: (Bool) -> Void
    init(_ call: @escaping (Bool) -> Void) { self.call = call }
}

final class IntegrationCallbackBox: @unchecked Sendable {
    let call: (Bool, String) -> Void
    init(_ call: @escaping (Bool, String) -> Void) { self.call = call }
}

// MARK: - State Observable Object

enum SyncMode: String, CaseIterable, Identifiable {
    case realtime = "Realtime Push (長輪詢即時)"
    case interval1m = "Periodic 1 min (定時 1 分鐘)"
    case interval5m = "Periodic 5 min (定時 5 分鐘)"

    var id: String { self.rawValue }
    var shortLabel: String {
        switch self {
        case .realtime: return "Realtime"
        case .interval1m: return "Every 1m"
        case .interval5m: return "Every 5m"
        }
    }

    @MainActor
    func localizedLabel(using i18n: I18n) -> String {
        switch self {
        case .realtime: return i18n.t("settings_realtime")
        case .interval1m: return i18n.t("settings_every_1m")
        case .interval5m: return i18n.t("settings_every_5m")
        }
    }
}

// MARK: - Deterministic attention policy

enum AttentionTier: String, Codable, CaseIterable {
    case now, today, know, filtered

    var label: String {
        switch self {
        case .now: return "現在處理"
        case .today: return "今天處理"
        case .know: return "值得知道"
        case .filtered: return "已過濾"
        }
    }
}

struct AttentionEvaluation: Equatable {
    let score: Int
    let tier: AttentionTier
    let reason: String
}

enum YomiAttentionPolicyStore {
    private static let priorityKey = "yomi_attention_priority"
    private static let mutedKey = "yomi_attention_muted"

    private static func ids(for key: String) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    private static func save(_ ids: Set<String>, key: String) {
        UserDefaults.standard.set(Array(ids).sorted(), forKey: key)
    }

    static func isPriority(_ id: String) -> Bool { ids(for: priorityKey).contains(id) }
    static func isMuted(_ id: String) -> Bool { ids(for: mutedKey).contains(id) }
    static func setPriority(_ id: String, enabled: Bool) {
        var values = ids(for: priorityKey)
        if enabled { values.insert(id) } else { values.remove(id) }
        save(values, key: priorityKey)
    }
    static func setMuted(_ id: String, enabled: Bool) {
        var values = ids(for: mutedKey)
        if enabled { values.insert(id) } else { values.remove(id) }
        save(values, key: mutedKey)
    }
}

extension LineChatItem {
    var effectiveMuted: Bool { isMuted || YomiAttentionPolicyStore.isMuted(id) }

    var attentionEvaluation: AttentionEvaluation {
        if effectiveMuted { return AttentionEvaluation(score: -100, tier: .filtered, reason: "已靜音") }
        if YomiAttentionPolicyStore.isPriority(id) { return AttentionEvaluation(score: 70, tier: .now, reason: "使用者標記優先") }
        return AttentionEvaluation(score: attentionScore, tier: attentionTier, reason: attentionReason)
    }
}

// Appearance is a user-facing preference, not a diagnostic setting. Keep it
// persisted so the main window and the settings page always agree.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "跟隨系統"
        case .light: return "淺色"
        case .dark: return "深色"
        }
    }

    @MainActor
    func label(using i18n: I18n) -> String {
        switch self {
        case .system: return i18n.t("settings_system")
        case .light: return i18n.t("settings_light")
        case .dark: return i18n.t("settings_dark")
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct IdeIntegrationItem: Identifiable {
    let id: String
    let name: String
    let badge: String
    let icon: String
    let details: String
    var isIntegrated: Bool
}

struct ChatMessageItem: Identifiable, Equatable {
    let id = UUID()
    let isUser: Bool
    var text: String
    var toolCall: String?
    let timestamp: Date = Date()
}

final class AppState: ObservableObject, @unchecked Sendable {
    @Published var i18n = I18n.shared
    @Published var isConnected: Bool = false
    @Published var mid: String = ""
    @Published var displayName: String = ""
    @Published var pictureUrl: String = ""
    @Published var statusMessage: String = ""
    @Published var isSyncing: Bool = false
    @Published var notificationsEnabled: Bool = true
    @Published var hasUnreadAttention: Bool = false
    @Published var unreadCount: Int = 0
    @Published var syncMode: SyncMode = .realtime
    /// Empty until the first sync has actually completed.  The UI must never
    /// imply freshness before the bridge returns a valid conversations payload.
    @Published var lastSyncTimeString: String = ""
    @Published var syncError: String? = nil

    @Published var isIntegrating: Bool = false

    // AI Chat & Provider State
    @Published var aiConfig: AiConfig = AiConfigManager.loadConfig()
    @Published var chatMessages: [ChatMessageItem] = []
    @Published var isAiThinking: Bool = false
    @Published var codexStatus: String = "尚未啟動"
    @Published var codexApprovalRequest: AgentApprovalRequest?
    @Published var codexElicitationRequest: AgentElicitationRequest?
    @Published var isShowingAiSettings: Bool = false
    @Published var agentHealthMap: [AiProviderType: AgentHealthStatus] = [:]

    // AI App Detection
    @Published var isClaudeAppInstalled: Bool = false
    @Published var isCodexAppInstalled: Bool = false
    @Published var isSpotlightPinned: Bool = false

    // Real Decrypted LINE Chat State
    @Published var chats: [LineChatItem] = []
    @Published var selectedChatId: String? = nil
    @Published var currentChatMessages: [LineChatMessage] = []
    @Published var stickerPackages: [StickerPackageItem] = []
    @Published var stickerPreviews: [StickerPreviewItem] = []
    @Published var isLoadingStickers: Bool = false
    @Published var stickerLoadError: String? = nil
    @Published var mediaPreviewImages: [String: NSImage] = [:]
    @Published var mediaPreviewAudioData: [String: Data] = [:]
    @Published var mediaPreviewAudioMIMEs: [String: String] = [:]
    @Published var mediaPreviewFailures: Set<String> = []
    private var mediaOriginalLoaded = Set<String>()
    @Published var isLoadingChats: Bool = false
    /// True only after the first chats payload has been successfully decoded.
    /// This prevents the pre-load state from being presented as an empty inbox.
    @Published var hasLoadedChatsOnce: Bool = false
    @Published var chatLoadError: String? = nil
    @Published var isLoadingMessages: Bool = false
    @Published var messageLoadError: String? = nil
    @Published var showAttentionOnly: Bool = true
    // Composer is always a direct LINE reply. AI is an optional assist layer.
    @Published var appearance: AppAppearance {
        didSet {
            UserDefaults.standard.set(appearance.rawValue, forKey: "yomi_appearance")
        }
    }
    @Published var isSendingReply: Bool = false
    @Published var replyFeedback: String? = nil
    @Published var replyFeedbackIsError: Bool = false

    var onUnreadStatusChanged: ((Bool) -> Void)?

    private var pollTimer: Timer?
    private var chatPollTimer: Timer?
    private var mediaPreviewLoading = Set<String>()
    private var semanticRefreshRunning = false
    private var chatRefreshInFlight = false
    private var i18nObservation: AnyCancellable?
    var agentBackend: AgentBackend?
    private var messageLoadGeneration: UInt64 = 0
    private var messageCache: [String: [LineChatMessage]] = [:]

    /// Environment for short-lived read-only bridges.  This keeps background
    /// sync on the file-backed session snapshot and prevents any Keychain
    /// mutation or permission prompt during polling.
    static func readOnlyBridgeEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["YOMI_READ_ONLY_SESSION"] = "1"
        return environment
    }

    init() {
        let savedAppearance = UserDefaults.standard.string(forKey: "yomi_appearance") ?? AppAppearance.system.rawValue
        self.appearance = AppAppearance(rawValue: savedAppearance) ?? .system
        // I18n is shared across the app. Forward its published language
        // changes through AppState so every view observing state redraws
        // immediately instead of only updating the segmented picker.
        self.i18nObservation = I18n.shared.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
        loadCachedChatSnapshot()
        checkInstalledAiApps()
        refreshState()
        if CredentialManager.loadCredentials()?.lineAuthToken?.isEmpty == false {
            loadRecentChats(silent: true)
        }
        // Check local authorization state every two seconds without prompts or unnecessary refreshes.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refreshState()
        }
        // Sync silently every 30 seconds to avoid frequent process spawning and no-op SwiftUI diffs.
        chatPollTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            guard let self = self, self.isConnected else { return }
            self.loadRecentChats(silent: true)
        }
    }

    func checkInstalledAiApps() {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        let claudeApp = FileManager.default.fileExists(atPath: "/Applications/Claude.app")
        let claudeDir = FileManager.default.fileExists(atPath: "\(home)/Library/Application Support/Claude")
        self.isClaudeAppInstalled = claudeApp || claudeDir

        let codexDir = FileManager.default.fileExists(atPath: "\(home)/.codex")
        let chatgptApp = FileManager.default.fileExists(atPath: "/Applications/ChatGPT.app")
        self.isCodexAppInstalled = codexDir || chatgptApp
    }

    func updateAiConfig(_ config: AiConfig) {
        self.aiConfig = config
        AiConfigManager.saveConfig(config)
    }

    func refreshState() {
        if let creds = CredentialManager.loadCredentials(),
            let token = creds.lineAuthToken, !token.isEmpty
        {
            let loadedMid = creds.lineMid ?? "Active"
            let loadedName = creds.displayName ?? "LINE User"
            let rawPic = creds.pictureUrl ?? (creds.picturePath != nil ? "https://obs.line-scdn.net/\(creds.picturePath!)" : "")
            let loadedPic = rawPic.replacingOccurrences(of: "line-scdn.net//", with: "line-scdn.net/")
            let loadedStatus = creds.statusMessage ?? ""

            DispatchQueue.main.async {
                if !self.isConnected { self.isConnected = true }
                if self.mid != loadedMid { self.mid = loadedMid }
                if self.displayName != loadedName { self.displayName = loadedName }
                if self.pictureUrl != loadedPic { self.pictureUrl = loadedPic }
                if self.statusMessage != loadedStatus { self.statusMessage = loadedStatus }
            }
        } else {
            DispatchQueue.main.async {
                if self.isConnected { self.isConnected = false }
                if !self.mid.isEmpty { self.mid = "" }
                if !self.displayName.isEmpty { self.displayName = "" }
                if !self.pictureUrl.isEmpty { self.pictureUrl = "" }
                if !self.statusMessage.isEmpty { self.statusMessage = "" }
                if self.hasUnreadAttention { self.hasUnreadAttention = false }
                if self.unreadCount != 0 { self.unreadCount = 0 }
                self.onUnreadStatusChanged?(false)
            }
        }
    }

    func loadRecentChats(silent: Bool = false) {
        guard !chatRefreshInFlight else { return }
        chatRefreshInFlight = true
        // A silent poll must still expose loading feedback when it is the first
        // load. Once a payload has been shown, keep the current list stable while
        // background polling refreshes it.
        let shouldShowLoading = !hasLoadedChatsOnce
        if shouldShowLoading || !silent {
            self.isLoadingChats = true
            self.chatLoadError = nil
        }
        if !silent { self.isSyncing = true }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            self.isLoadingChats = false
            self.isSyncing = false
            self.chatRefreshInFlight = false
            self.chatLoadError = "Node.js or Yomi runtime is unavailable."
            self.syncError = self.chatLoadError
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "chats", "all"] + (silent && self.hasLoadedChatsOnce ? ["--first-page"] : [])

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()

            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()

                if process.terminationStatus == 0,
                    let jsonStr = String(data: data, encoding: .utf8),
                    let jsonStart = jsonStr.firstIndex(of: "[")
                {
                    let cleanJson = String(jsonStr[jsonStart...])
                    if let jsonData = cleanJson.data(using: .utf8),
                        let decoded = try? JSONDecoder().decode([LineChatItem].self, from: jsonData)
                    {
                        DispatchQueue.main.async {
                            let previousChats = self.chats
                            let selectedID = self.selectedChatId
                            let previousSelectedTimestamp = selectedID.flatMap { id in
                                previousChats.first(where: { $0.id == id })?.timestampValue
                            }
                            let incoming = decoded.map { item in
                                var safe = item
                                safe.lastMessage = sanitizeDesktopMessagePreview(item.lastMessage)
                                return safe
                            }
                            if silent && self.hasLoadedChatsOnce {
                                var merged = Dictionary(uniqueKeysWithValues: self.chats.map { ($0.id, $0) })
                                for item in incoming { merged[item.id] = item }
                                let nextChats = Array(merged.values).sorted(by: { (lhs: LineChatItem, rhs: LineChatItem) -> Bool in
                                    lhs.timestampValue > rhs.timestampValue
                                })
                                if nextChats != self.chats { self.chats = nextChats }
                            } else {
                                if incoming != self.chats { self.chats = incoming }
                                // Only an authoritative full snapshot may
                                // prove that the current conversation was
                                // removed. Filter/search state is never a
                                // reason to discard the open detail pane.
                                if let selected = self.selectedChatId,
                                    !decoded.contains(where: { $0.id == selected })
                                {
                                    self.selectedChatId = nil
                                    self.currentChatMessages = []
                                }
                            }
                            self.hasLoadedChatsOnce = true
                            if self.chats != previousChats { DesktopChatSnapshotStore.save(self.chats) }
                            self.chatLoadError = nil
                            self.isLoadingChats = false
                            self.chatRefreshInFlight = false

                            let totalUnread = self.chats.reduce(0) { $0 + $1.unreadCount }
                            let hasAttention = self.chats.contains { $0.needsAttention }
                            if self.unreadCount != totalUnread { self.unreadCount = totalUnread }
                            if self.hasUnreadAttention != hasAttention {
                                self.hasUnreadAttention = hasAttention
                                self.onUnreadStatusChanged?(hasAttention)
                            }
                            if !silent { self.isSyncing = false }
                            self.syncError = nil
                            let formatter = DateFormatter()
                            formatter.dateFormat = "HH:mm"
                            let syncedAt = formatter.string(from: Date())
                            if self.lastSyncTimeString != syncedAt { self.lastSyncTimeString = syncedAt }

                            if let selected = selectedID,
                                let nextTimestamp = self.chats.first(where: { $0.id == selected })?.timestampValue,
                                nextTimestamp != previousSelectedTimestamp
                            {
                                self.loadChatMessages(chatId: selected, showLoading: false, markReadOnSuccess: false)
                            }
                            if decoded.contains(where: { $0.attentionReason == "正在整理新訊息…" }) {
                                self.refreshSemanticAttention()
                            }
                        }
                        return
                    }
                }
            } catch {}

            DispatchQueue.main.async {
                self.isLoadingChats = false
                self.isSyncing = false
                self.chatRefreshInFlight = false
                self.chatLoadError = "Unable to decode the LINE conversations response."
                self.syncError = self.chatLoadError
            }
        }
    }

    private func loadCachedChatSnapshot() {
        chats = DesktopChatSnapshotStore.load().map { item in
            var safe = item
            safe.lastMessage = sanitizeDesktopMessagePreview(item.lastMessage)
            return safe
        }
        hasLoadedChatsOnce = !chats.isEmpty
        unreadCount = chats.reduce(0) { $0 + $1.unreadCount }
        hasUnreadAttention = chats.contains(where: \.needsAttention)
    }

    /// Refine only uncached unread previews after the usable inbox has already
    /// painted. Results are persisted by the bridge and merged without showing
    /// a global loading state.
    private func refreshSemanticAttention() {
        guard !semanticRefreshRunning,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }
        let pending = Array(chats.filter { $0.attentionReason == "正在整理新訊息…" }.prefix(8))
        guard !pending.isEmpty, let payload = try? JSONEncoder().encode(pending) else { return }
        semanticRefreshRunning = true
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "attention-classify"]
            let outputPipe = Pipe()
            let inputPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = FileHandle.nullDevice
            process.standardInput = inputPipe
            do {
                try process.run()
                inputPipe.fileHandleForWriting.write(payload)
                try? inputPipe.fileHandleForWriting.close()
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 20) {
                    if process.isRunning { process.terminate() }
                }
                let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus == 0,
                    let raw = String(data: data, encoding: .utf8),
                    let start = raw.firstIndex(of: "["),
                    let json = String(raw[start...]).data(using: .utf8),
                    let refined = try? JSONDecoder().decode([AttentionRefinement].self, from: json)
                {
                    DispatchQueue.main.async {
                        let byID = Dictionary(uniqueKeysWithValues: refined.map { ($0.id, $0) })
                        self.chats = self.chats.map { item in
                            guard let value = byID[item.id] else { return item }
                            var updated = item
                            updated.attentionScore = value.attentionScore
                            updated.attentionTier = value.attentionTier
                            updated.attentionReason = value.attentionReason
                            return updated
                        }
                        self.semanticRefreshRunning = false
                        if self.chats.contains(where: { $0.attentionReason == "正在整理新訊息…" }) {
                            self.refreshSemanticAttention()
                        }
                    }
                    return
                }
            } catch {}
            DispatchQueue.main.async { self.semanticRefreshRunning = false }
        }
    }

    func loadChatMessages(chatId: String, showLoading: Bool = true, markReadOnSuccess: Bool = false) {
        guard !chatId.isEmpty else { return }
        messageLoadGeneration &+= 1
        let generation = messageLoadGeneration
        let isSwitchingChat = self.selectedChatId != chatId
        self.selectedChatId = chatId
        if let cached = messageCache[chatId], !cached.isEmpty {
            self.currentChatMessages = cached
            self.isLoadingMessages = false
            self.messageLoadError = nil
        } else if isSwitchingChat {
            self.currentChatMessages = []
            self.isLoadingMessages = true
        } else if showLoading || self.currentChatMessages.isEmpty {
            self.isLoadingMessages = true
        }
        self.messageLoadError = nil

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            self.isLoadingMessages = false
            self.messageLoadError = "找不到訊息服務。請重新整理後再試一次。"
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "messages", chatId, "40"]

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()

            do {
                try process.run()
                // A stuck bridge must never hold the detail pane forever.
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8) {
                    if process.isRunning { process.terminate() }
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()

                if let jsonStr = String(data: data, encoding: .utf8),
                    let jsonStart = jsonStr.firstIndex(of: "[")
                {
                    let cleanJson = String(jsonStr[jsonStart...])
                    if let jsonData = cleanJson.data(using: .utf8),
                        let decoded = try? JSONDecoder().decode([LineChatMessage].self, from: jsonData)
                    {
                        DispatchQueue.main.async {
                            guard self.selectedChatId == chatId, self.messageLoadGeneration == generation else { return }
                            let messages = decoded.map { message in
                                var safe = message
                                safe.text = sanitizeDesktopMessagePreview(message.text)
                                return safe
                            }
                            self.messageCache[chatId] = messages
                            self.currentChatMessages = messages
                            self.isLoadingMessages = false
                            self.messageLoadError = nil
                            // Reading follows successful presentation, never a row click.
                            if markReadOnSuccess { self.markChatRead(chatId: chatId) }
                        }
                        return
                    }
                }
            } catch {}

            DispatchQueue.main.async {
                guard self.selectedChatId == chatId, self.messageLoadGeneration == generation else { return }
                self.isLoadingMessages = false
                self.messageLoadError = "這個對話暫時載入不了。請再試一次。"
            }
        }
    }

    /// Read-only owned-sticker discovery for the LINE-style picker.
    /// Preview loading never sends anything; sending is a separate explicit
    /// action from the selected sticker's confirmation button.
    func loadOwnedStickers() {
        guard !isLoadingStickers else { return }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            stickerLoadError = "找不到 Yomi runtime。"
            return
        }
        isLoadingStickers = true
        stickerLoadError = nil
        let language = i18n.currentLanguage.rawValue
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "list-stickers", language]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let text = String(data: data, encoding: .utf8),
                    let start = text.firstIndex(of: "["),
                    let json = String(text[start...]).data(using: .utf8),
                    let packages = try? JSONDecoder().decode([StickerPackageItem].self, from: json)
                else {
                    throw NSError(domain: "Yomi", code: 1)
                }
                DispatchQueue.main.async {
                    self.stickerPackages = packages
                    self.isLoadingStickers = false
                    if let first = packages.first { self.loadStickerPreviews(packageId: first.packageId) }
                }
            } catch {
                DispatchQueue.main.async {
                    self.isLoadingStickers = false
                    self.stickerLoadError = "貼圖載入失敗。"
                }
            }
        }
    }

    func loadStickerPreviews(packageId: String) {
        guard !packageId.isEmpty,
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }
        isLoadingStickers = true
        stickerLoadError = nil
        let language = i18n.currentLanguage.rawValue
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "sticker-previews", packageId, "12", language]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let text = String(data: data, encoding: .utf8),
                    let start = text.firstIndex(of: "["),
                    let json = String(text[start...]).data(using: .utf8),
                    let previews = try? JSONDecoder().decode([StickerPreviewItem].self, from: json)
                else {
                    throw NSError(domain: "Yomi", code: 2)
                }
                DispatchQueue.main.async {
                    self.stickerPreviews = previews
                    self.isLoadingStickers = false
                }
            } catch {
                DispatchQueue.main.async {
                    self.isLoadingStickers = false
                    self.stickerLoadError = "貼圖預覽載入失敗。"
                }
            }
        }
    }

    func sendLineSticker(chatId: String, sticker: StickerPreviewItem, completion: @escaping (Bool) -> Void = { _ in }) {
        guard !chatId.isEmpty, !isSendingReply,
            let package = stickerPackages.first(where: { $0.packageId == sticker.packageId }),
            let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            completion(false)
            return
        }
        isSendingReply = true
        let callback = BoolCallbackBox(completion)
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "send-sticker", chatId, sticker.stickerId, sticker.packageId, package.version]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            var success = false
            do {
                try process.run()
                _ = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                success = process.terminationStatus == 0
            } catch { success = false }
            let result = success
            DispatchQueue.main.async {
                self.isSendingReply = false
                self.replyFeedbackIsError = !result
                self.replyFeedback = result ? "已送出貼圖" : "貼圖送出失敗，請稍後重試。"
                callback.call(result)
            }
        }
    }

    func loadMediaPreview(chatId: String, messageId: String, original: Bool = false) {
        let loadingKey = original ? "\(messageId):original" : messageId
        guard !chatId.isEmpty, !messageId.isEmpty,
            original ? !mediaOriginalLoaded.contains(messageId) : mediaPreviewImages[messageId] == nil,
            mediaPreviewAudioData[messageId] == nil
        else { return }
        guard !mediaPreviewLoading.contains(loadingKey) else { return }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }
        mediaPreviewLoading.insert(loadingKey)
        mediaPreviewFailures.remove(messageId)

        DispatchQueue.global(qos: .userInitiated).async {
            defer { self.mediaPreviewLoading.remove(loadingKey) }
            let process = Process()
            process.launchPath = nodePath
            process.environment = Self.readOnlyBridgeEnvironment()
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "media-preview", chatId, messageId]
            if original { process.arguments?.append("original") }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()

            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0,
                    let jsonString = String(data: data, encoding: .utf8),
                    let jsonStart = jsonString.firstIndex(of: "{"),
                    let jsonData = String(jsonString[jsonStart...]).data(using: .utf8),
                    let payload = try? JSONDecoder().decode(MediaPreviewPayload.self, from: jsonData),
                    let decoded = Data(base64Encoded: payload.data)
                else {
                    DispatchQueue.main.async { self.mediaPreviewFailures.insert(messageId) }
                    return
                }
                DispatchQueue.main.async {
                    let mimeType = payload.mimeType?.lowercased() ?? ""
                    if mimeType.hasPrefix("audio/") {
                        self.mediaPreviewAudioData[messageId] = decoded
                        self.mediaPreviewAudioMIMEs[messageId] = mimeType
                    } else if let image = NSImage(data: decoded) {
                        self.mediaPreviewImages[messageId] = image
                        if original { self.mediaOriginalLoaded.insert(messageId) }
                    } else {
                        self.mediaPreviewFailures.insert(messageId)
                    }
                }
            } catch {
                DispatchQueue.main.async { self.mediaPreviewFailures.insert(messageId) }
            }
        }
    }

    /// Send a human-authored LINE reply through the local E2EE runtime.
    /// AI prompts use a separate path and never call this method.
    func sendLineReply(
        chatId: String,
        text: String,
        mentions: [LineMentionTarget] = [],
        completion: @escaping (Bool) -> Void = { _ in }
    ) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !chatId.isEmpty, !trimmed.isEmpty, !isSendingReply else { return }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            replyFeedbackIsError = true
            replyFeedback = "找不到 Yomi runtime，訊息尚未送出。"
            completion(false)
            return
        }

        isSendingReply = true
        let callback = BoolCallbackBox(completion)
        replyFeedback = nil
        replyFeedbackIsError = false

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            var environment = Self.readOnlyBridgeEnvironment()
            if let data = try? JSONEncoder().encode(mentions) {
                environment["YOMI_MENTIONS_JSON"] = String(decoding: data, as: UTF8.self)
            }
            process.environment = environment
            process.arguments = [paths.runMjs, "send-message", chatId, trimmed]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice

            var succeeded = false
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus == 0,
                    let response = String(data: data, encoding: .utf8),
                    response.contains("\"sent\":true")
                {
                    succeeded = true
                }
            } catch {
                succeeded = false
            }

            let result = succeeded
            DispatchQueue.main.async {
                self.isSendingReply = false
                self.replyFeedbackIsError = !result
                self.replyFeedback = result ? "已送出" : "訊息送出失敗，請稍後重試。"
                callback.call(result)
            }
        }
    }

    /// Send a user-selected image through the existing encrypted image bridge.
    /// The panel is opened by the view; this method never reads arbitrary files
    /// until the user has explicitly selected one.
    func sendLineImage(chatId: String, fileURL: URL, completion: @escaping (Bool) -> Void = { _ in }) {
        guard !chatId.isEmpty, !isSendingReply else {
            completion(false)
            return
        }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            replyFeedbackIsError = true
            replyFeedback = "找不到 Yomi runtime，圖片尚未送出。"
            completion(false)
            return
        }

        isSendingReply = true
        let callback = BoolCallbackBox(completion)
        replyFeedback = nil
        replyFeedbackIsError = false
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "send-image", chatId, fileURL.path]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            var succeeded = false
            do {
                try process.run()
                _ = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                succeeded = process.terminationStatus == 0
            } catch {
                succeeded = false
            }
            let result = succeeded
            DispatchQueue.main.async {
                self.isSendingReply = false
                self.replyFeedbackIsError = !result
                self.replyFeedback = result ? "圖片已送出" : "圖片送出失敗，請稍後重試。"
                callback.call(result)
            }
        }
    }

    /// Send a staged non-image attachment through the encrypted file bridge.
    func sendLineFile(chatId: String, fileURL: URL, completion: @escaping (Bool) -> Void = { _ in }) {
        guard !chatId.isEmpty, !isSendingReply else {
            completion(false)
            return
        }
        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else {
            replyFeedbackIsError = true
            replyFeedback = "找不到 Yomi runtime，檔案尚未送出。"
            completion(false)
            return
        }
        isSendingReply = true
        let callback = BoolCallbackBox(completion)
        replyFeedback = nil
        replyFeedbackIsError = false
        let scoped = fileURL.startAccessingSecurityScopedResource()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "send-file", chatId, fileURL.path]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            var succeeded = false
            do {
                try process.run()
                _ = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                succeeded = process.terminationStatus == 0
            } catch { succeeded = false }
            let result = succeeded
            DispatchQueue.main.async {
                self.isSendingReply = false
                self.replyFeedbackIsError = !result
                self.replyFeedback = result ? "檔案已送出" : "檔案送出失敗，請稍後重試。"
                callback.call(result)
            }
        }
    }

    func markChatRead(chatId: String) {
        guard !chatId.isEmpty else { return }

        // Optimistically update local state
        if let idx = self.chats.firstIndex(where: { $0.id == chatId }) {
            self.chats[idx].unreadCount = 0
            let totalUnread = self.chats.reduce(0) { $0 + $1.unreadCount }
            let hasAttention = self.chats.contains { $0.needsAttention }
            self.unreadCount = totalUnread
            self.hasUnreadAttention = hasAttention
            self.onUnreadStatusChanged?(hasAttention)
        }

        guard let nodePath = YomiPathResolver.findNodePath(),
            let paths = YomiPathResolver.findRunMjs()
        else { return }

        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.launchPath = nodePath
            process.currentDirectoryPath = paths.projectDir
            process.arguments = [paths.runMjs, "mark-read", chatId]
            try? process.run()
            process.waitUntilExit()
        }
    }

    func clearAttentionAlert() {
        if hasUnreadAttention {
            hasUnreadAttention = false
            unreadCount = 0
            onUnreadStatusChanged?(false)
        }
    }

    /// Yomi attention policy is intentionally separate from LINE's
    /// notificationDisabled flag. This is local, reversible, and survives
    /// syncs without pretending that the LINE protocol mutation succeeded.
    func setYomiMuted(chatId: String, enabled: Bool) {
        YomiAttentionPolicyStore.setMuted(chatId, enabled: enabled)
        objectWillChange.send()
        replyFeedbackIsError = false
        replyFeedback = enabled ? "已在 Yomi 暫不關注此對話" : "已恢復 Yomi 對此對話的關注"
    }

    func setYomiPriority(chatId: String, enabled: Bool) {
        YomiAttentionPolicyStore.setPriority(chatId, enabled: enabled)
        objectWillChange.send()
        replyFeedbackIsError = false
        replyFeedback = enabled ? "已標記為 Yomi 優先對話" : "已取消 Yomi 優先標記"
    }

    func reportUnsupportedLineMute(chatId: String) {
        // The current Talk service exposes notificationDisabled as read-only;
        // do not show a false-success state or silently mutate local policy.
        replyFeedbackIsError = true
        replyFeedback = "LINE 靜音尚未提供可用的協定寫入；請在 LINE 管理此設定。Yomi 關注策略可由右鍵選單調整。"
    }

}
