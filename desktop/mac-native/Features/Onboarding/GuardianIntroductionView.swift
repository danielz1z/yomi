import SwiftUI

struct GuardianIntroductionView: View {
    let onFinish: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 7) {
                Text("兩位閱巡者，前來值勤")
                    .font(.system(size: 27, weight: .bold))
                Text("阿聞與吽行，替你讀懂訊息、完成交代並守住注意力。")
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
            }
            .padding(.top, 28)
            .padding(.bottom, 22)

            HStack(alignment: .top, spacing: 14) {
                guardianCard(
                    mode: .line,
                    name: "阿聞",
                    role: "閱巡者・人間來訊",
                    introduction: "我是阿聞。替你守住 LINE 的人間來訊；你寫下的話，由我送回目前對話。"
                )
                guardianCard(
                    mode: .yomi,
                    name: "吽行",
                    role: "閱巡者・任務執行",
                    introduction: "我是吽行。替你理解交代、核對資料並執行任務；也能聽你說話、查看拖進來的檔案。"
                )
            }
            .padding(.horizontal, 24)

            VStack(alignment: .leading, spacing: 9) {
                instruction(icon: "bubble.left.fill", text: "阿聞模式：直接回覆目前的 LINE 對話。")
                instruction(icon: "seal.fill", text: "按右側狛犬原位切換，畫面與對話上下文都不會消失。")
                instruction(icon: "mic.fill", text: "吽行模式：可以打字、說話，或拖入檔案交代任務。")
            }
            .padding(16)
            .background(EnterpriseTheme.controlFill)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 24)
            .padding(.top, 16)

            HStack {
                Text("未讀不等於需要注意；我們會先替你整理。")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                Spacer()
                Button("讓兩位閱巡者開始值勤", action: onFinish)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityHint("關閉介紹並進入今日 Briefing")
            }
            .padding(24)
        }
        .frame(width: 640)
        .background(EnterpriseTheme.canvas)
        .interactiveDismissDisabled()
        .accessibilityElement(children: .contain)
    }

    private func guardianCard(
        mode: YomiKomainuMode,
        name: String,
        role: String,
        introduction: String
    ) -> some View {
        HStack(alignment: .top, spacing: 14) {
            YomiGuardiansMark(mode: mode, size: 82)
                .frame(width: 88, height: 88, alignment: .center)

            VStack(alignment: .leading, spacing: 5) {
                Text(name)
                    .font(.system(size: 20, weight: .bold))
                Text(role)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(EnterpriseTheme.accent)
                Text(introduction)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 126, alignment: .topLeading)
        .background(EnterpriseTheme.raisedSurface)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(EnterpriseTheme.hairline)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func instruction(icon: String, text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(EnterpriseTheme.accent)
                .frame(width: 20)
            Text(text)
                .font(.system(size: 13, weight: .medium))
            Spacer(minLength: 0)
        }
    }
}
