use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LoginUiState {
    Starting,
    Pin { pin: String },
    WaitingApproval { pin: String },
    Success,
    Error { message: String },
}

#[derive(Debug, Clone)]
pub enum DesktopEvent {
    Login(LoginUiState),
    RefreshAccount,
}
