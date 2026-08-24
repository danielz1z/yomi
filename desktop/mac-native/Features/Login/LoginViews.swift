import Cocoa
import SwiftUI

// MARK: - Login Flow View Model & Engine

enum LoginStep: Equatable {
    case inputPhone
    case requestingPin
    case enterPin(pin: String, countdown: Int)
    case waitingApproval(pin: String)
    case success(mid: String)
    case failure(error: String)
}

struct RegionOption: Identifiable, Hashable {
    let id: String
    let code: String
    let prefix: String
    let label: String
    let shortName: String
}

@MainActor
class LoginViewModel: ObservableObject {
    @Published var step: LoginStep = .inputPhone
    @Published var selectedRegion: String = "TW"
    @Published var phoneNumber: String = ""
    @Published var errorMessage: String = ""

    let regions: [RegionOption] = [
        RegionOption(id: "TW", code: "TW", prefix: "+886", label: "Taiwan (+886)", shortName: "TW +886"),
        RegionOption(id: "JP", code: "JP", prefix: "+81", label: "Japan (+81)", shortName: "JP +81"),
        RegionOption(id: "TH", code: "TH", prefix: "+66", label: "Thailand (+66)", shortName: "TH +66"),
        RegionOption(id: "ID", code: "ID", prefix: "+62", label: "Indonesia (+62)", shortName: "ID +62"),
        RegionOption(id: "US", code: "US", prefix: "+1", label: "United States (+1)", shortName: "US +1"),
    ]

    private var loginProcess: Process?
    private var countdownTimer: Timer?
    private var remainingPinSeconds = 0
    var onLoginSuccess: (() -> Void)?

    func startLogin() {
        var rawPhone = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPhone.isEmpty else {
            self.errorMessage = "Please enter your phone number"
            self.step = .failure(error: "Phone number cannot be empty.")
            return
        }

        if selectedRegion == "TW" && rawPhone.hasPrefix("09") {
            rawPhone = "+886" + rawPhone.dropFirst(1)
        } else if !rawPhone.hasPrefix("+") {
            if let regionObj = regions.first(where: { $0.code == selectedRegion }) {
                rawPhone = regionObj.prefix + rawPhone
            }
        }

        withAnimation(.easeInOut(duration: 0.25)) {
            step = .requestingPin
            errorMessage = ""
        }

        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        guard let nodePath = YomiPathResolver.findNodePath() else {
            self.step = .failure(error: "Node.js executable not found. Please ensure Node >= 22 is installed.")
            return
        }

        guard let paths = YomiPathResolver.findRunMjs() else {
            self.step = .failure(error: "Yomi run.mjs script not found.")
            return
        }

        let projectDir = paths.projectDir
        let runMjs = paths.runMjs

        let process = Process()
        process.launchPath = nodePath
        process.currentDirectoryPath = projectDir
        process.arguments = [runMjs, "login", "--phone", rawPhone, "--region", selectedRegion]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        let outHandle = pipe.fileHandleForReading
        outHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let output = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in self?.handleOutput(output) }
        }

        self.loginProcess = process
        do {
            try process.run()
        } catch {
            withAnimation {
                self.step = .failure(error: "Failed to launch login service: \(error.localizedDescription)")
            }
        }
    }

    private func handleOutput(_ text: String) {
        let lines = text.components(separatedBy: .newlines)
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }

            if trimmed.contains("PIN:") {
                let parts = trimmed.components(separatedBy: "PIN:")
                if parts.count > 1 {
                    let pin = parts[1].trimmingCharacters(in: .whitespaces)
                    startPinCountdown(pin: pin)
                }
            } else if trimmed.contains("Waiting for you to approve") {
                if case .enterPin(let pin, _) = self.step {
                    withAnimation {
                        self.step = .waitingApproval(pin: pin)
                    }
                }
            } else if trimmed.contains("Login successful") {
                stopTimer()
                var mid = "Active"
                if let midPart = trimmed.components(separatedBy: "mid=").dropFirst().first {
                    mid = midPart.components(separatedBy: " ").first ?? "Active"
                }
                withAnimation(.spring()) {
                    self.step = .success(mid: mid)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    self.onLoginSuccess?()
                }
            } else if trimmed.contains("Login failed:") {
                stopTimer()
                let err = trimmed.replacingOccurrences(of: "[Yomi] Login failed:", with: "").trimmingCharacters(in: .whitespaces)
                withAnimation {
                    self.step = .failure(error: err.isEmpty ? "Authentication failed" : err)
                }
            }
        }
    }

    private func startPinCountdown(pin: String) {
        stopTimer()
        remainingPinSeconds = 180
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
            self.step = .enterPin(pin: pin, countdown: remainingPinSeconds)
        }

        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tickPinCountdown() }
        }
    }

    private func tickPinCountdown() {
        remainingPinSeconds -= 1
        if remainingPinSeconds <= 0 {
            stopTimer()
            withAnimation {
                step = .failure(error: "PIN expired. Please request a new one.")
            }
        } else if case .enterPin(let pin, _) = step {
            step = .enterPin(pin: pin, countdown: remainingPinSeconds)
        }
    }

    func cancel() {
        stopTimer()
        loginProcess?.terminate()
        loginProcess = nil
        step = .inputPhone
    }

    private func stopTimer() {
        countdownTimer?.invalidate()
        countdownTimer = nil
    }

    deinit {
        countdownTimer?.invalidate()
        loginProcess?.terminate()
    }
}

// MARK: - Enterprise-Craft Login Window UI

struct LoginSheetView: View {
    @ObservedObject var viewModel: LoginViewModel

    var body: some View {
        VStack(spacing: 0) {
            switch viewModel.step {
            case .inputPhone:
                EnterprisePhoneInputView(viewModel: viewModel)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.98)), removal: .opacity))
            case .requestingPin:
                EnterpriseRequestingView()
                    .transition(.opacity)
            case .enterPin(let pin, let countdown):
                EnterprisePinDisplayView(pin: pin, countdown: countdown, waitingApproval: false)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .trailing)), removal: .opacity))
            case .waitingApproval(let pin):
                EnterprisePinDisplayView(pin: pin, countdown: 0, waitingApproval: true)
                    .transition(.opacity)
            case .success(let mid):
                EnterpriseSuccessView(mid: mid)
                    .transition(.asymmetric(insertion: .scale.combined(with: .opacity), removal: .opacity))
            case .failure(let error):
                EnterpriseFailureView(error: error) {
                    withAnimation {
                        viewModel.step = .inputPhone
                    }
                }
            }
        }
        .padding(28)
        .frame(width: 390, height: 410)
    }
}

// MARK: - Enterprise Subviews

struct EnterpriseBrandHero: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [EnterpriseTheme.accent.opacity(0.35), Color.clear]),
                        center: .center,
                        startRadius: 4,
                        endRadius: 36
                    )
                )
                .frame(width: 72, height: 72)

            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                    LinearGradient(
                        gradient: Gradient(colors: [
                            Color(NSColor.controlBackgroundColor).opacity(0.7),
                            Color(NSColor.controlBackgroundColor).opacity(0.3),
                        ]),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 54, height: 54)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(
                            LinearGradient(
                                gradient: Gradient(colors: [
                                    Color.white.opacity(0.35),
                                    Color.white.opacity(0.08),
                                ]),
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                )
                .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)

            Image(systemName: "shield.checkered")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [EnterpriseTheme.accent, EnterpriseTheme.accent.opacity(0.8)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
        }
    }
}

struct EnterprisePhoneInputView: View {
    @ObservedObject var viewModel: LoginViewModel
    @FocusState private var isPhoneFocused: Bool

    var body: some View {
        VStack(spacing: 20) {
            EnterpriseBrandHero()

            VStack(spacing: 5) {
                Text("Passwordless Authentication")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.primary)

                Text("Enter your phone number to receive a verification PIN in your LINE mobile app.")
                    .font(.system(size: 12.5))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .padding(.horizontal, 4)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 0) {
                    Menu {
                        ForEach(viewModel.regions) { reg in
                            Button(action: {
                                viewModel.selectedRegion = reg.code
                            }) {
                                Text(reg.label)
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(viewModel.regions.first(where: { $0.code == viewModel.selectedRegion })?.shortName ?? "TW +886")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.primary)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.04))
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .padding(.leading, 6)

                    Rectangle()
                        .fill(Color.white.opacity(0.12))
                        .frame(width: 1, height: 20)
                        .padding(.horizontal, 6)

                    TextField("0912 345 678", text: $viewModel.phoneNumber)
                        .textFieldStyle(PlainTextFieldStyle())
                        .font(.system(size: 14.5, weight: .medium, design: .monospaced))
                        .focused($isPhoneFocused)
                        .padding(.vertical, 9)
                        .padding(.trailing, 10)
                        .onSubmit {
                            viewModel.startLogin()
                        }
                }
                .background(Color(NSColor.controlBackgroundColor).opacity(0.45))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(
                            isPhoneFocused ? EnterpriseTheme.accent : EnterpriseTheme.hairline,
                            lineWidth: isPhoneFocused ? 1.5 : 1
                        )
                )

                HStack(spacing: 5) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 10.5))
                        .foregroundColor(.green.opacity(0.9))
                    Text("Requires: LINE > Settings > Account > Allow other device login")
                        .font(.system(size: 10.5))
                        .foregroundColor(Color(NSColor.tertiaryLabelColor))
                }
                .padding(.leading, 2)
            }
            .padding(.top, 2)

            Button(action: {
                viewModel.startLogin()
            }) {
                HStack(spacing: 7) {
                    Text("Request Verification PIN")
                        .font(.system(size: 13.5, weight: .semibold))
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(
                    LinearGradient(
                        gradient: Gradient(colors: [
                            EnterpriseTheme.accent,
                            EnterpriseTheme.accent.opacity(0.88),
                        ]),
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .shadow(color: EnterpriseTheme.accent.opacity(0.35), radius: 8, x: 0, y: 3)
            }
            .buttonStyle(PlainButtonStyle())
            .padding(.top, 2)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                isPhoneFocused = true
            }
        }
    }
}

struct EnterpriseRequestingView: View {
    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.1), lineWidth: 3)
                    .frame(width: 52, height: 52)
                ProgressView()
                    .scaleEffect(1.1)
            }

            VStack(spacing: 5) {
                Text("Connecting to LINE Security...")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.primary)
                Text("Negotiating end-to-end encrypted session keys")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

struct EnterprisePinDisplayView: View {
    let pin: String
    let countdown: Int
    let waitingApproval: Bool

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 4) {
                Text(waitingApproval ? "Approve Login on Phone" : "Enter Verification PIN")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.primary)

                Text(waitingApproval ? "PIN verified. Tap 「用戶確認」 on your phone to finish." : "Open LINE on your primary phone and type:")
                    .font(.system(size: 12.5))
                    .foregroundColor(.secondary)
            }

            HStack(spacing: 11) {
                ForEach(Array(pin), id: \.self) { char in
                    Text(String(char))
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .foregroundColor(EnterpriseTheme.accent)
                        .frame(width: 52, height: 64)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(EnterpriseTheme.accent.opacity(0.1))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(
                                            LinearGradient(
                                                gradient: Gradient(colors: [
                                                    EnterpriseTheme.accent.opacity(0.6),
                                                    EnterpriseTheme.accent.opacity(0.2),
                                                ]),
                                                startPoint: .topLeading,
                                                endPoint: .bottomTrailing
                                            ),
                                            lineWidth: 1.5
                                        )
                                )
                                .shadow(color: EnterpriseTheme.accent.opacity(0.2), radius: 6, x: 0, y: 3)
                        )
                }
            }
            .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 7) {
                EnterpriseStepRow(step: "1", text: "Open LINE app on your mobile phone")
                EnterpriseStepRow(step: "2", text: "Enter the 4 digits shown above")
                EnterpriseStepRow(step: "3", text: "Tap 「用戶確認」 and approve pairing")
            }
            .padding(.horizontal, 8)

            HStack(spacing: 8) {
                if waitingApproval {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                    Text("Device approval in progress...")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.green)
                } else {
                    Image(systemName: "timer")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                    Text("Expires in \(countdown)s")
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.top, 2)
        }
    }
}

struct EnterpriseStepRow: View {
    let step: String
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Text(step)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundColor(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.secondary.opacity(0.6)))

            Text(text)
                .font(.system(size: 12.5))
                .foregroundColor(.primary.opacity(0.85))

            Spacer()
        }
    }
}

struct EnterpriseSuccessView: View {
    let mid: String

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.16))
                    .frame(width: 60, height: 60)
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundColor(.green)
            }

            VStack(spacing: 5) {
                Text("LINE Connected")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.primary)

                Text("MID: \(mid)")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(.secondary)
            }

            Text("Letter-Sealing E2EE session active and ready for AI copilot.")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxHeight: .infinity)
    }
}

struct EnterpriseFailureView: View {
    let error: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(EnterpriseTheme.accent.opacity(0.14))
                    .frame(width: 54, height: 54)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
            }

            VStack(spacing: 4) {
                Text("Authentication Failed")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.primary)
                Text(error)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
            }

            Button(action: onRetry) {
                Text("Try Again")
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 7)
                    .background(EnterpriseTheme.accent)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(PlainButtonStyle())
        }
        .frame(maxHeight: .infinity)
    }
}
