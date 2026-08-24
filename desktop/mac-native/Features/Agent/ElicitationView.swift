import SwiftUI

struct AgentElicitationView: View {
    let request: AgentElicitationRequest
    let onRespond: (String, [String: Any]) -> Void

    @State private var textValues: [String: String]
    @State private var boolValues: [String: Bool]

    init(request: AgentElicitationRequest, onRespond: @escaping (String, [String: Any]) -> Void) {
        self.request = request
        self.onRespond = onRespond
        _textValues = State(initialValue: Dictionary(uniqueKeysWithValues: request.fields.map { ($0.name, $0.defaultValue ?? "") }))
        _boolValues = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: request.fields.filter { $0.type == "boolean" }.map { ($0.name, $0.defaultValue == "true") }
            )
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble.fill").foregroundColor(EnterpriseTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(request.serverName) 需要你的回覆").font(.system(size: 13, weight: .semibold))
                    Text(request.message).font(.system(size: 12)).foregroundColor(.secondary)
                }
            }

            if request.mode == "url", let value = request.url, let url = URL(string: value) {
                Link("在瀏覽器開啟", destination: url).font(.system(size: 12, weight: .semibold))
            }
            ForEach(request.fields) { field in fieldView(field) }

            HStack {
                Button("拒絕") { onRespond("decline", [:]) }.buttonStyle(.bordered)
                Spacer()
                Button("繼續") { onRespond("accept", responseContent) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!requiredFieldsAreComplete)
            }
        }
        .padding(12)
        .background(EnterpriseTheme.accent.opacity(0.08))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(EnterpriseTheme.accent.opacity(0.28)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func fieldView(_ field: AgentElicitationField) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(field.title + (field.isRequired ? " *" : "")).font(.system(size: 12, weight: .medium))
            if field.type == "boolean" {
                Toggle(field.description ?? "確認", isOn: boolBinding(field.name)).toggleStyle(.switch)
            } else if !field.options.isEmpty {
                Picker("", selection: textBinding(field.name)) {
                    ForEach(field.options, id: \.self) { Text($0).tag($0) }
                }.labelsHidden()
            } else {
                TextField(field.description ?? field.title, text: textBinding(field.name)).textFieldStyle(.roundedBorder)
            }
            if let description = field.description, field.type != "boolean" {
                Text(description).font(.system(size: 10.5)).foregroundColor(.secondary)
            }
        }
    }

    private func textBinding(_ name: String) -> Binding<String> {
        Binding(get: { textValues[name] ?? "" }, set: { textValues[name] = $0 })
    }

    private func boolBinding(_ name: String) -> Binding<Bool> {
        Binding(get: { boolValues[name] ?? false }, set: { boolValues[name] = $0 })
    }

    private var requiredFieldsAreComplete: Bool {
        request.fields.filter(\.isRequired).allSatisfy { field in
            field.type == "boolean" || !(textValues[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private var responseContent: [String: Any] {
        var content: [String: Any] = [:]
        for field in request.fields {
            if field.type == "boolean" {
                content[field.name] = boolValues[field.name] ?? false
            } else if field.type == "integer" {
                content[field.name] = Int(textValues[field.name] ?? "")
            } else if field.type == "number" {
                content[field.name] = Double(textValues[field.name] ?? "")
            } else if field.type == "array" {
                content[field.name] = (textValues[field.name] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            } else {
                content[field.name] = textValues[field.name] ?? ""
            }
        }
        return content
    }
}

struct AgentApprovalView: View {
    let request: AgentApprovalRequest
    let onDecision: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.shield.fill").foregroundColor(.orange)
                Text("Codex 要求：\(request.kind)").font(.system(size: 13, weight: .semibold))
            }
            if let command = request.command, !command.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("將執行").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary)
                    Text(command)
                        .font(.system(size: 11.5, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(4)
                }
                .padding(8)
                .background(EnterpriseTheme.controlFill)
                .clipShape(RoundedRectangle(cornerRadius: 7))
            }
            if let cwd = request.cwd, !cwd.isEmpty {
                Label(cwd, systemImage: "folder").font(.system(size: 10.5)).foregroundColor(.secondary).textSelection(.enabled)
            }
            if let reason = request.reason, !reason.isEmpty {
                Text(reason).font(.system(size: 11.5)).foregroundColor(.secondary)
            }
            HStack {
                Button("拒絕") { onDecision("decline") }.buttonStyle(.bordered)
                Spacer()
                Button("只允許這次") { onDecision("accept") }.buttonStyle(.bordered)
                if request.canAcceptForSession {
                    Button("本次對話皆允許") { onDecision("acceptForSession") }.buttonStyle(.borderedProminent)
                }
                if request.persistentRuleKey != nil {
                    Button("永遠允許同類唯讀命令") { onDecision("acceptPermanently") }.buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.orange.opacity(0.28)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
