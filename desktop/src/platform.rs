use std::path::PathBuf;

/// Resolve the Node executable, Yomi entry point, and working directory used
/// by desktop-owned subprocesses. Installed bundles always win; environment
/// overrides and the repository checkout exist only for development.
pub fn yomi_runtime_paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let executable_root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf));
    if let Some(root) = executable_root {
        let node = root.join("runtime").join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        });
        let run_mjs = root.join("YomiCore").join("run.mjs");
        if node.exists() && run_mjs.exists() {
            return Some((node, run_mjs, root.join("YomiCore")));
        }
    }

    let run_mjs = std::env::var_os("YOMI_RUN_MJS")
        .map(PathBuf::from)
        .or_else(|| {
            let candidate = std::env::current_dir().ok()?.join("run.mjs");
            candidate.exists().then_some(candidate)
        })?;
    let node = std::env::var_os("YOMI_NODE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    let cwd = run_mjs.parent()?.to_path_buf();
    Some((node, run_mjs, cwd))
}

/// Return the canonical per-user Yomi data directory for the current platform.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("YOMI_DATA_DIR") {
        return Some(PathBuf::from(override_dir));
    }

    #[cfg(target_os = "windows")]
    {
        let app_data = std::env::var_os("APPDATA").or_else(|| {
            std::env::var_os("USERPROFILE").map(|profile| {
                PathBuf::from(profile)
                    .join("AppData")
                    .join("Roaming")
                    .into_os_string()
            })
        });
        app_data.map(|path| PathBuf::from(path).join("yomi"))
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(PathBuf::from).map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("yomi")
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let xdg = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"));
        Some(xdg.join("yomi"))
    }
}

/// Open a URL with the platform's default browser.
pub fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map(|_| ())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::open_url;

    #[test]
    fn browser_helper_has_a_stable_signature() {
        let _: fn(&str) -> std::io::Result<()> = open_url;
    }
}
