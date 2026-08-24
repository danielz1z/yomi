import Foundation

// MARK: - Codex app-server backend

enum AgentBackendEvent {
    case status(String)
    case delta(String)
    case completed
    case approval(AgentApprovalRequest)
    case elicitation(AgentElicitationRequest)
    case failure(String)
}

struct AgentApprovalRequest: Identifiable, Sendable {
    let requestID: Int
    let kind: String
    let command: String?
    let cwd: String?
    let reason: String?
    let canAcceptForSession: Bool
    let persistentRuleKey: String?
    var id: Int { requestID }
}

struct AgentElicitationField: Identifiable, Sendable {
    let name: String
    let title: String
    let description: String?
    let type: String
    let isRequired: Bool
    let defaultValue: String?
    let options: [String]
    var id: String { name }
}

struct AgentElicitationRequest: Identifiable, Sendable {
    let requestID: Int
    let serverName: String
    let message: String
    let mode: String
    let url: String?
    let fields: [AgentElicitationField]
    var id: Int { requestID }
}

protocol AgentBackend: AnyObject {
    var toolID: String { get }
    var displayName: String { get }
    func start(prompt: String, cwd: String, nodePath: String?, runMjs: String?, onEvent: @escaping @Sendable (AgentBackendEvent) -> Void)
    func cancel()
    func stop()
    func respondToApproval(decision: String)
    func respondToElicitation(requestID: Int, action: String, content: [String: Any])
}

struct CodingToolDefinition: Sendable {
    let id: String
    let displayName: String
    let binaryName: String
    let arguments: @Sendable (String) -> [String]
}

enum CodingToolBackendFactory {
    static let cliTools: [AiProviderType: CodingToolDefinition] = [
        .claudeCli: CodingToolDefinition(id: "claude", displayName: "Claude Code", binaryName: "claude") { ["-p", $0] },
        .antigravityCli: CodingToolDefinition(id: "antigravity", displayName: "Antigravity", binaryName: "agy") { ["-p", $0] },
        .opencodeCli: CodingToolDefinition(id: "opencode", displayName: "OpenCode", binaryName: "opencode") { ["run", $0] },
        .ollamaLocal: CodingToolDefinition(id: "ollama", displayName: "Ollama", binaryName: "ollama") { ["run", "llama3.2", $0] },
    ]

    static func make(for provider: AiProviderType) -> AgentBackend? {
        if provider == .codexCli { return CodexAppServerBackend() }
        if let definition = cliTools[provider] { return CliCodingToolBackend(definition: definition) }
        if provider == .autoDetect {
            if CodexAppServerBackend.findCodex() != nil { return CodexAppServerBackend() }
            for candidate in [AiProviderType.claudeCli, .antigravityCli, .opencodeCli, .ollamaLocal] {
                guard let definition = cliTools[candidate] else { continue }
                if CliCodingToolBackend.findExecutable(named: definition.binaryName) != nil {
                    return CliCodingToolBackend(definition: definition)
                }
            }
        }
        return nil
    }
}

final class CliCodingToolBackend: AgentBackend, @unchecked Sendable {
    let toolID: String
    let displayName: String
    private let definition: CodingToolDefinition
    private var process: Process?

    init(definition: CodingToolDefinition) {
        self.definition = definition
        toolID = definition.id
        displayName = definition.displayName
    }

    static func findExecutable(named name: String) -> String? {
        let home = NSHomeDirectory()
        return [
            "\(home)/.local/bin/\(name)",
            "\(home)/.opencode/bin/\(name)",
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
        ].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start(prompt: String, cwd: String, nodePath: String?, runMjs: String?, onEvent: @escaping @Sendable (AgentBackendEvent) -> Void) {
        stop()
        guard let executable = Self.findExecutable(named: definition.binaryName) else {
            onEvent(.failure("找不到 \(displayName) CLI；請先安裝並登入。"))
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = definition.arguments(prompt)
        process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        var environment = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin:\(home)/.opencode/bin:" + (environment["PATH"] ?? "")
        process.environment = environment
        self.process = process
        do {
            try process.run()
            onEvent(.status("\(displayName) 正在處理"))
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard let self, self.process === process else { return }
                self.process = nil
                let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if process.terminationStatus == 0, !output.isEmpty {
                    onEvent(.delta(output))
                    onEvent(.completed)
                } else {
                    onEvent(.failure(output.isEmpty ? "\(self.displayName) 未回傳內容。" : output))
                }
            }
        } catch {
            self.process = nil
            onEvent(.failure("\(displayName) 啟動失敗：\(error.localizedDescription)"))
        }
    }

    func cancel() { stop() }
    func stop() {
        process?.terminate()
        process = nil
    }
    func respondToApproval(decision: String) {}
    func respondToElicitation(requestID: Int, action: String, content: [String: Any]) {}
}

/// A real long-lived Codex app-server client. It speaks JSONL JSON-RPC over
/// stdio, keeps thread/turn lifecycle state, and surfaces streamed events;
/// it never falls back to `codex exec` or pretends a tool call happened.
final class CodexAppServerBackend: AgentBackend, @unchecked Sendable {
    typealias Event = AgentBackendEvent
    let toolID = "codex"
    let displayName = "Codex"

    private var process: Process?
    private var outputPipe: Pipe?
    private var requestID = 0
    private var threadID: String?
    private var threadStartRequestID: Int?
    private var turnID: String?
    private var pendingApprovalID: Int?
    private var pendingApprovalRequest: AgentApprovalRequest?
    private var inactivityWorkItem: DispatchWorkItem?
    private var eventSink: (@Sendable (Event) -> Void)?
    private var lineBuffer = ""
    private let lock = NSLock()
    private let eventLogger = AgentEventLogger()

    private func nextID() -> Int {
        lock.lock()
        defer { lock.unlock() }
        requestID += 1
        return requestID
    }

    func start(prompt: String, cwd: String, nodePath: String?, runMjs: String?, onEvent: @escaping @Sendable (Event) -> Void) {
        let preparedPrompt = """
                請直接完成以下任務，並以平易近人的繁體中文回覆使用者。不要朗讀或解釋 skill、MCP、索引、app-server、repo 載入等內部機制；只說目前成果、需要的選擇或真正的阻礙。

                使用者交代：\(prompt)
            """
        eventSink = onEvent
        if process?.isRunning == true, let threadID {
            eventLogger.lifecycle("turn_reuse", pid: process?.processIdentifier)
            armInactivityWatchdog(onEvent: onEvent)
            send(method: "turn/start", params: ["threadId": threadID, "input": [["type": "text", "text": preparedPrompt]]])
            onEvent(.status("Yomi 正在接續這段對話"))
            return
        }
        stop()
        guard let codex = Self.findCodex() else {
            onEvent(.failure("找不到 codex CLI；請安裝並登入 Codex 0.149.0。"))
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: codex)
        var args = ["app-server", "--stdio", "-c", "approval_policy=\"on-request\""]
        // Inject Yomi as a first-class Codex MCP server for this session. The
        // command is explicit and repo-local; no global config is rewritten.
        if let nodePath, let runMjs {
            args += [
                "-c", "mcp_servers.yomi.command=\"\(nodePath)\"", "-c", "mcp_servers.yomi.args=[\"\(runMjs)\", \"serve\"]", "-c",
                "mcp_servers.yomi.cwd=\"\(cwd)\"",
            ]
        }
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin:" + (env["PATH"] ?? "")
        proc.environment = env
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        proc.standardInput = Pipe()
        process = proc
        outputPipe = pipe
        do {
            try proc.run()
            self.pendingPrompt = preparedPrompt
            eventLogger.lifecycle("app_server_started", pid: proc.processIdentifier)
            readOutput(onEvent: onEvent)
            armInactivityWatchdog(onEvent: onEvent)
            send(
                method: "initialize",
                params: [
                    "clientInfo": ["name": "yomi-desktop", "version": "0.4.2"],
                    "capabilities": [:],
                ])
            sendNotification(method: "initialized", params: [:])
            // The protocol accepts the request before the response to
            // initialize; responses are matched below by their request id.
            threadStartRequestID = send(
                method: "thread/start", params: ["cwd": cwd, "approvalPolicy": "on-request", "sandbox": "workspace-write"])
        } catch {
            onEvent(.failure("Codex app-server 啟動失敗：\(error.localizedDescription)"))
        }
    }

    private var pendingPrompt: String?

    private func readOutput(onEvent: @escaping @Sendable (Event) -> Void) {
        guard let pipe = outputPipe else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            while let process = self.process, process.isRunning {
                let data = pipe.fileHandleForReading.availableData
                if data.isEmpty { break }
                self.lineBuffer += String(data: data, encoding: .utf8) ?? ""
                while let newline = self.lineBuffer.firstIndex(of: "\n") {
                    let line = String(self.lineBuffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
                    self.lineBuffer = String(self.lineBuffer[self.lineBuffer.index(after: newline)...])
                    guard let json = line.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
                    else { continue }
                    self.eventLogger.protocolEvent(object)
                    self.handle(object, onEvent: onEvent)
                }
            }
            if let process = self.process, !process.isRunning { onEvent(.completed) }
        }
    }

    private func handle(_ object: [String: Any], onEvent: @escaping @Sendable (Event) -> Void) {
        armInactivityWatchdog(onEvent: onEvent)
        if let responseID = object["id"] as? Int, responseID == threadStartRequestID,
            let result = object["result"] as? [String: Any], let thread = result["thread"] as? [String: Any],
            let id = thread["id"] as? String
        {
            threadID = id
            threadStartRequestID = nil
            if let pendingPrompt {
                send(method: "turn/start", params: ["threadId": id, "input": [["type": "text", "text": pendingPrompt]]])
                self.pendingPrompt = nil
            }
            onEvent(.status("Yomi 已連線，正在理解你的交代"))
            return
        }
        if let method = object["method"] as? String {
            let params = object["params"] as? [String: Any] ?? [:]
            if method.contains("agentMessage/delta"), let delta = params["delta"] as? String {
                onEvent(.delta(delta))
            } else if method.contains("mcpServer/startupStatus/updated"), let name = params["name"] as? String,
                let status = params["status"] as? String
            {
                onEvent(.status("MCP \(name)：\(status)"))
            } else if method.contains("item/started"), let item = params["item"] as? [String: Any], let type = item["type"] as? String {
                if type == "commandExecution" {
                    onEvent(.status("Codex 執行工具：\(item["command"] as? String ?? type)"))
                } else if type == "fileChange" {
                    onEvent(.status("Codex 準備變更檔案（需核准）"))
                }
            } else if method.contains("item/completed"), let item = params["item"] as? [String: Any], let type = item["type"] as? String,
                type == "commandExecution"
            {
                onEvent(.status("Codex 工具執行完成"))
            } else if method.contains("approval") || method.contains("requestApproval"), let requestID = object["id"] as? Int {
                pendingApprovalID = requestID
                let request = Self.parseApproval(requestID: requestID, method: method, params: params)
                pendingApprovalRequest = request
                if let rule = request.persistentRuleKey, AgentApprovalPolicyStore.contains(rule) {
                    respondToApproval(decision: "accept")
                    onEvent(.status("已依你保存的唯讀授權繼續處理"))
                } else {
                    onEvent(.approval(request))
                }
            } else if method == "mcpServer/elicitation/request", let requestID = object["id"] as? Int {
                inactivityWorkItem?.cancel()
                inactivityWorkItem = nil
                let request = Self.parseElicitation(requestID: requestID, params: params)
                if Self.isTrustedYomiRequest(request, rawServerName: params["serverName"] as? String) {
                    respondToElicitation(requestID: requestID, action: "accept", content: [:])
                    onEvent(.status("Yomi 正在讀取你要求的資料"))
                } else {
                    onEvent(.elicitation(request))
                }
            } else if method.contains("turn/started") {
                turnID = (params["turn"] as? [String: Any])?["id"] as? String
                onEvent(.status("Yomi 開始處理"))
            }
            // Items (including the user message) complete before the turn;
            // only turn/completed ends the thinking state.
            else if method.contains("turn/completed") {
                inactivityWorkItem?.cancel()
                inactivityWorkItem = nil
                turnID = nil
                onEvent(.completed)
            }
            return
        }
        if object["error"] != nil {
            inactivityWorkItem?.cancel()
            inactivityWorkItem = nil
            onEvent(.failure("Yomi 處理時遇到問題：\(object["error"]!)"))
        }
    }

    private func armInactivityWatchdog(onEvent: @escaping @Sendable (Event) -> Void) {
        inactivityWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.process?.isRunning == true else { return }
            onEvent(.failure("Yomi 等候外部回應超過兩分鐘，已停止這次處理。請再試一次；你的對話與草稿都還在。"))
            self.eventLogger.lifecycle("inactivity_timeout", pid: self.process?.processIdentifier)
            self.stop()
        }
        inactivityWorkItem = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 120, execute: item)
    }

    @discardableResult
    private func send(method: String, params: [String: Any]) -> Int {
        let id = nextID()
        sendRaw(["method": method, "params": params, "id": id])
        return id
    }
    private func sendNotification(method: String, params: [String: Any]) { sendRaw(["method": method, "params": params]) }
    private func sendRaw(_ object: [String: Any]) {
        guard let input = process?.standardInput as? Pipe,
            let data = try? JSONSerialization.data(withJSONObject: object),
            let line = String(data: data, encoding: .utf8)?.appending("\n").data(using: .utf8)
        else { return }
        input.fileHandleForWriting.write(line)
    }

    func respondToApproval(decision: String) {
        guard let requestID = pendingApprovalID else { return }
        // Approval responses are deliberately isolated here; no UI action can
        // silently approve a mutation without an explicit click.
        let wireDecision: String
        if decision == "acceptPermanently", let rule = pendingApprovalRequest?.persistentRuleKey {
            AgentApprovalPolicyStore.insert(rule)
            wireDecision = "accept"
        } else {
            wireDecision = decision
        }
        sendRaw(["id": requestID, "result": ["decision": wireDecision]])
        pendingApprovalID = nil
        pendingApprovalRequest = nil
    }

    func respondToElicitation(requestID: Int, action: String, content: [String: Any]) {
        var result: [String: Any] = ["action": action]
        if action == "accept" { result["content"] = content }
        sendRaw(["id": requestID, "result": result])
        eventLogger.lifecycle("elicitation_\(action)", pid: process?.processIdentifier)
        if let eventSink { armInactivityWatchdog(onEvent: eventSink) }
    }

    func cancel() {
        if let turnID { send(method: "turn/interrupt", params: ["turnId": turnID]) }
        stop()
    }
    func stop() {
        inactivityWorkItem?.cancel()
        inactivityWorkItem = nil
        if let process {
            eventLogger.lifecycle("app_server_stopping", pid: process.processIdentifier)
            Self.terminateChildren(of: process.processIdentifier)
            process.terminate()
        }
        process = nil
        outputPipe = nil
        threadID = nil
        threadStartRequestID = nil
        turnID = nil
        pendingApprovalID = nil
        pendingApprovalRequest = nil
        eventSink = nil
    }

    private static func parseElicitation(requestID: Int, params: [String: Any]) -> AgentElicitationRequest {
        let schema = params["requestedSchema"] as? [String: Any] ?? [:]
        let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        let required = Set(schema["required"] as? [String] ?? [])
        let fields = properties.map { name, definition in
            let options =
                (definition["enum"] as? [String])
                ?? (definition["oneOf"] as? [[String: Any]])?.compactMap { $0["const"] as? String }
                ?? []
            let defaultValue: String?
            if let value = definition["default"] as? String {
                defaultValue = value
            } else if let value = definition["default"] as? Bool {
                defaultValue = value ? "true" : "false"
            } else if let value = definition["default"] as? NSNumber {
                defaultValue = value.stringValue
            } else {
                defaultValue = nil
            }
            return AgentElicitationField(
                name: name,
                title: definition["title"] as? String ?? name,
                description: definition["description"] as? String,
                type: definition["type"] as? String ?? "string",
                isRequired: required.contains(name),
                defaultValue: defaultValue,
                options: options
            )
        }.sorted { lhs, rhs in
            if lhs.isRequired != rhs.isRequired { return lhs.isRequired }
            return lhs.name < rhs.name
        }
        return AgentElicitationRequest(
            requestID: requestID,
            serverName: params["serverName"] as? String ?? "Yomi",
            message: params["message"] as? String ?? "Yomi 需要你的確認。",
            mode: params["mode"] as? String ?? "form",
            url: params["url"] as? String,
            fields: fields
        )
    }

    private static func parseApproval(requestID: Int, method: String, params: [String: Any]) -> AgentApprovalRequest {
        let decisions = params["availableDecisions"] as? [Any] ?? []
        let canAcceptForSession = decisions.contains { ($0 as? String) == "acceptForSession" }
        let kind: String
        if method.contains("commandExecution") {
            kind = "執行命令"
        } else if method.contains("fileChange") {
            kind = "修改檔案"
        } else if method.contains("permissions") {
            kind = "增加權限"
        } else {
            kind = "執行外部操作"
        }
        return AgentApprovalRequest(
            requestID: requestID,
            kind: kind,
            command: params["command"] as? String,
            cwd: params["cwd"] as? String,
            reason: params["reason"] as? String,
            canAcceptForSession: canAcceptForSession,
            persistentRuleKey: persistentReadOnlyRule(for: params["command"] as? String)
        )
    }

    private static func persistentReadOnlyRule(for rawCommand: String?) -> String? {
        guard var command = rawCommand, !command.isEmpty else { return nil }
        if let firstQuote = command.firstIndex(of: "'"), let lastQuote = command.lastIndex(of: "'"), firstQuote < lastQuote {
            command = String(command[command.index(after: firstQuote)..<lastQuote])
        }
        let forbidden = [";", "&&", "||", "|", ">", "<", "$(", "`", "\n"]
        guard !forbidden.contains(where: command.contains) else { return nil }
        var tokens = command.split(whereSeparator: \.isWhitespace).map(String.init)
        if tokens.first == "rtk" { tokens.removeFirst() }
        let permittedPrefixes = [
            ["glab", "repo", "list"],
            ["glab", "repo", "view"],
            ["glab", "issue", "list"],
            ["glab", "issue", "view"],
            ["glab", "search", "issues"],
        ]
        return permittedPrefixes.first(where: { tokens.starts(with: $0) })?.joined(separator: " ")
    }

    private static func isTrustedYomiRequest(
        _ request: AgentElicitationRequest,
        rawServerName: String?
    ) -> Bool {
        guard let rawServerName else { return false }
        return rawServerName.caseInsensitiveCompare("yomi") == .orderedSame
            && request.serverName.caseInsensitiveCompare("yomi") == .orderedSame
    }

    private static func terminateChildren(of pid: Int32) {
        guard pid > 1 else { return }
        let killer = Process()
        killer.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        killer.arguments = ["-TERM", "-P", String(pid)]
        try? killer.run()
        killer.waitUntilExit()
    }
    static func findCodex() -> String? {
        let home = NSHomeDirectory()
        return ["\(home)/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"].first {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }
}

enum AgentApprovalPolicyStore {
    private static let key = "yomi_permanent_readonly_approvals_v1"

    static func contains(_ rule: String) -> Bool {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? []).contains(rule)
    }

    static func insert(_ rule: String) {
        var rules = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
        rules.insert(rule)
        UserDefaults.standard.set(Array(rules).sorted(), forKey: key)
    }

    static var count: Int {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? []).count
    }

    static func removeAll() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// Bounded, metadata-only diagnostics. Prompts, deltas, LINE text, command
/// arguments and raw JSON-RPC payloads are deliberately never persisted.
private final class AgentEventLogger {
    private let queue = DispatchQueue(label: "dev.rikai.yomi.agent-event-log")
    private let maxBytes: UInt64 = 1_000_000

    private var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Yomi", isDirectory: true)
            .appendingPathComponent("agent-events.jsonl")
    }

    func lifecycle(_ name: String, pid: Int32?) {
        append(["kind": "lifecycle", "event": name, "pid": pid ?? 0])
    }

    func protocolEvent(_ object: [String: Any]) {
        var entry: [String: Any] = ["kind": "protocol"]
        if let method = object["method"] as? String { entry["method"] = method }
        if let id = object["id"] { entry["responseId"] = String(describing: id) }
        entry["hasError"] = object["error"] != nil
        if let params = object["params"] as? [String: Any],
            let item = params["item"] as? [String: Any],
            let type = item["type"] as? String
        {
            entry["itemType"] = type
        }
        append(entry)
    }

    private func append(_ fields: [String: Any]) {
        var record = fields
        record["timestamp"] = ISO8601DateFormatter().string(from: Date())
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        let lineData = data + Data([0x0A])
        queue.async { [url, maxBytes, lineData] in
            let manager = FileManager.default
            try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let size = (try? manager.attributesOfItem(atPath: url.path)[.size]) as? NSNumber,
                size.uint64Value >= maxBytes
            {
                let previous = url.appendingPathExtension("1")
                try? manager.removeItem(at: previous)
                try? manager.moveItem(at: url, to: previous)
            }
            if !manager.fileExists(atPath: url.path) { manager.createFile(atPath: url.path, contents: nil) }
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: lineData)
        }
    }
}
