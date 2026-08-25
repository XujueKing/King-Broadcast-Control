use libloading::{Library, Symbol};
use serde::Serialize;
use std::path::{Path, PathBuf};

type MpvClientApiVersion = unsafe extern "C" fn() -> u64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvRuntimeStatus {
    pub available: bool,
    pub library_path: Option<String>,
    pub client_api_major: Option<u32>,
    pub client_api_minor: Option<u32>,
    pub message: String,
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            paths.push(directory.join("libmpv-2.dll"));
        }
    }
    paths.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".local-tools")
            .join("mpv")
            .join("libmpv-2.dll"),
    );
    paths.dedup();
    paths
}

fn inspect_library(path: &Path) -> Result<(u32, u32), String> {
    let library =
        unsafe { Library::new(path) }.map_err(|error| format!("无法加载 libmpv: {error}"))?;
    let version: Symbol<MpvClientApiVersion> = unsafe { library.get(b"mpv_client_api_version\0") }
        .map_err(|error| format!("libmpv 缺少客户端 ABI: {error}"))?;
    let packed = unsafe { version() };
    Ok(((packed >> 16) as u32, (packed & 0xffff) as u32))
}

fn detect_runtime() -> LibMpvRuntimeStatus {
    let mut last_error = None;
    for candidate in candidate_paths() {
        if !candidate.is_file() {
            continue;
        }
        match inspect_library(&candidate) {
            Ok((major, minor)) => {
                return LibMpvRuntimeStatus {
                    available: true,
                    library_path: Some(candidate.to_string_lossy().into_owned()),
                    client_api_major: Some(major),
                    client_api_minor: Some(minor),
                    message: format!("libmpv ABI {major}.{minor} 已就绪，等待原生双渲染面"),
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    LibMpvRuntimeStatus {
        available: false,
        library_path: None,
        client_api_major: None,
        client_api_minor: None,
        message: last_error
            .unwrap_or_else(|| "未找到 libmpv-2.dll，请运行 npm run setup:mpv".to_string()),
    }
}

#[tauri::command]
pub fn libmpv_runtime_status() -> LibMpvRuntimeStatus {
    detect_runtime()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_libmpv_is_discoverable_when_provisioned() {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".local-tools")
            .join("mpv")
            .join("libmpv-2.dll");
        if development.is_file() {
            assert!(candidate_paths().iter().any(|path| path == &development));
            assert!(
                inspect_library(&development)
                    .expect("provisioned libmpv must load")
                    .0
                    >= 2
            );
        }
    }
    #[test]
    fn status_never_claims_available_without_an_abi_version() {
        let status = detect_runtime();
        if status.available {
            assert!(status.client_api_major.is_some());
            assert!(status
                .library_path
                .as_deref()
                .is_some_and(|path| path.ends_with("libmpv-2.dll")));
        }
    }
}
