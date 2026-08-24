use crate::platform::data_dir;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::process::Command;
use tracing::info;
#[cfg(target_os = "macos")]
use tracing::{error, warn};

#[cfg(target_os = "macos")]
pub const SERVICE_NAME: &str = "dev.rikai.yomi.credentials";
#[cfg(target_os = "macos")]
pub const ACCOUNT_NAME: &str = "line";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LineCredentials {
    #[serde(default)]
    pub line_auth_token: Option<String>,
    #[serde(default)]
    pub line_certificate: Option<String>,
    #[serde(default)]
    pub line_refresh_token: Option<String>,
    #[serde(default)]
    pub line_mid: Option<String>,
    #[serde(default)]
    pub line_e2ee_public_key: Option<String>,
    #[serde(default)]
    pub line_e2ee_private_key: Option<String>,
}

impl LineCredentials {
    pub fn is_valid(&self) -> bool {
        self.line_auth_token
            .as_ref()
            .is_some_and(|tok| !tok.trim().is_empty())
    }

    pub fn mid_display(&self) -> String {
        self.line_mid.as_deref().unwrap_or("未知名稱").to_string()
    }
}

pub struct KeychainStore;

impl KeychainStore {
    /// Reads credentials from macOS Keychain and the shared Yomi data directory fallback.
    pub fn load() -> Result<LineCredentials, String> {
        #[cfg(target_os = "macos")]
        {
            let output = Command::new("security")
                .args([
                    "find-generic-password",
                    "-s",
                    SERVICE_NAME,
                    "-a",
                    ACCOUNT_NAME,
                    "-w",
                ])
                .output();

            match output {
                Ok(out) => {
                    if out.status.success() {
                        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !text.is_empty() {
                            match serde_json::from_str::<LineCredentials>(&text) {
                                Ok(creds) => {
                                    info!(
                                        "成功自 macOS Keychain ({}) 讀取 LINE 憑證",
                                        SERVICE_NAME
                                    );
                                    return Ok(creds);
                                }
                                Err(err) => {
                                    warn!("Keychain 內容解析失敗: {:?}", err);
                                }
                            }
                        }
                    } else {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        if !stderr.contains("could not be found") {
                            warn!("Keychain 讀取錯誤: {}", stderr.trim());
                        }
                    }
                }
                Err(err) => {
                    error!("執行 security 指令失敗: {:?}", err);
                }
            }
        }

        // Use the same per-user data directory as the TypeScript client.
        if let Some(data_dir) = data_dir() {
            let path = data_dir.join("line-credentials.json");
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(creds) = serde_json::from_str::<LineCredentials>(&content) {
                        info!("成功自檔案 ({:?}) 讀取 LINE 憑證", path);
                        return Ok(creds);
                    }
                }
            }
        }

        Err("未在系統憑證庫或 Yomi 資料目錄找到有效憑證".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credentials_validation() {
        let creds_empty = LineCredentials::default();
        assert!(!creds_empty.is_valid());

        let creds_valid = LineCredentials {
            line_auth_token: Some("fake_auth_token_xyz".to_string()),
            line_mid: Some("u123456789".to_string()),
            ..Default::default()
        };
        assert!(creds_valid.is_valid());
        assert_eq!(creds_valid.mid_display(), "u123456789");
    }

    #[test]
    fn test_deserialize_from_json() {
        let json = r#"{
            "line_auth_token": "token_abc",
            "line_mid": "u987654321",
            "line_certificate": "cert_123",
            "line_e2ee_public_key": "pubkey_hex"
        }"#;

        let parsed: LineCredentials = serde_json::from_str(json).unwrap();
        assert!(parsed.is_valid());
        assert_eq!(parsed.line_auth_token.as_deref(), Some("token_abc"));
        assert_eq!(parsed.line_certificate.as_deref(), Some("cert_123"));
        assert_eq!(parsed.mid_display(), "u987654321");
    }
}
