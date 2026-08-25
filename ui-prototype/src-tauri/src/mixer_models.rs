use serde::Serialize;
use std::{fs, path::Path};

#[cfg(windows)]
use std::{
    os::windows::process::CommandExt,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DRIVER_PROBE_TTL: Duration = Duration::from_secs(30);
#[cfg(windows)]
static QU_DRIVER_PROBE_CACHE: OnceLock<Mutex<Option<(Instant, bool)>>> = OnceLock::new();

const QU16_MODEL_ID: &str = "allen-heath-qu16";
const QU16_RESOURCE_URL: &str =
    "https://www.allen-heath.com/hardware/qu/qu-classic/qu-16/resources/";
const QU16_ARCHIVE_NAME: &str = "AllenHeath-Qu-Windows-Driver-v5.72.0.zip";
const DRIVER_INSTALL_SCRIPT: &str = include_str!("../scripts/install-mixer-driver.ps1");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerDriverStatus {
    pub state: String,
    pub title: String,
    pub message: String,
    pub model_id: String,
    pub driver_version: String,
}

fn validate_model(model_id: &str) -> Result<(), String> {
    match model_id {
        QU16_MODEL_ID => Ok(()),
        _ => Err(format!("未知调音台型号包：{model_id}")),
    }
}

#[cfg(windows)]
fn qu_driver_installed() -> bool {
    let cache = QU_DRIVER_PROBE_CACHE.get_or_init(|| Mutex::new(None));
    // Keep the lock while probing so StrictMode reloads and concurrent settings
    // requests cannot spawn several registry readers at once.
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((checked_at, installed)) = *cached {
        if checked_at.elapsed() < DRIVER_PROBE_TTL {
            return installed;
        }
    }

    let installed = [r"HKLM\SOFTWARE\ASIO", r"HKLM\SOFTWARE\WOW6432Node\ASIO"]
        .iter()
        .filter_map(|key| {
            let mut command = std::process::Command::new("reg.exe");
            command
                .args(["query", key, "/s"])
                // A GUI Tauri process has no parent console. Without this flag,
                // Windows Terminal may open a visible `reg.exe` tab for every
                // status probe and then report 0x800700e8 as its pipe closes.
                .creation_flags(CREATE_NO_WINDOW);
            command.output().ok()
        })
        .map(|output| String::from_utf8_lossy(&output.stdout).to_lowercase())
        .any(|text| {
            (text.contains("allen & heath") || text.contains("allenheath"))
                && (text.contains("qu") || text.contains("asio"))
        });
    *cached = Some((Instant::now(), installed));
    installed
}

#[cfg(windows)]
fn cache_qu_driver_installed(installed: bool) {
    let cache = QU_DRIVER_PROBE_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = Some((Instant::now(), installed));
}

#[cfg(not(windows))]
fn qu_driver_installed() -> bool {
    false
}

pub fn driver_status(model_id: &str) -> Result<MixerDriverStatus, String> {
    validate_model(model_id)?;
    if qu_driver_installed() {
        Ok(MixerDriverStatus {
            state: "ready".into(),
            title: "驱动已就绪".into(),
            message: "已检测到 Allen & Heath Qu Windows 音频驱动".into(),
            model_id: model_id.into(),
            driver_version: "5.72.0".into(),
        })
    } else {
        Ok(MixerDriverStatus {
            state: "consent-required".into(),
            title: "需要一次厂商授权".into(),
            message: "Qu ASIO/WDM 5.72.0 由官方 EULA 保护；接受后完成安装，程序会自动识别".into(),
            model_id: model_id.into(),
            driver_version: "5.72.0".into(),
        })
    }
}

pub fn configure(app_data: &Path, model_id: &str) -> Result<MixerDriverStatus, String> {
    validate_model(model_id)?;
    let directory = app_data.join("mixer-models");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let config = serde_json::json!({
        "schemaVersion": 1,
        "selectedModelId": model_id,
        "uiRenderer": "qu-classic",
        "driverProvisioning": "vendor-eula"
    });
    fs::write(
        directory.join("active-model.json"),
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    driver_status(model_id)
}

pub fn open_driver_support(model_id: &str) -> Result<(), String> {
    validate_model(model_id)?;
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(QU16_RESOURCE_URL)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn install_from_downloads(
    app_data: &Path,
    downloads: &Path,
    model_id: &str,
) -> Result<MixerDriverStatus, String> {
    validate_model(model_id)?;
    if qu_driver_installed() {
        return driver_status(model_id);
    }
    let downloaded_archive = downloads.join(QU16_ARCHIVE_NAME);
    let developer_archive = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .join("vendor")
        .join("allen-heath")
        .join("qu16")
        .join(QU16_ARCHIVE_NAME);
    let archive = if downloaded_archive.is_file() {
        downloaded_archive
    } else if developer_archive.is_file() {
        developer_archive
    } else {
        return Ok(MixerDriverStatus {
            state: "waiting-download".into(),
            title: "等待官方下载".into(),
            message: format!("接受厂商 EULA 后，将 {QU16_ARCHIVE_NAME} 保存到下载目录"),
            model_id: model_id.into(),
            driver_version: "5.72.0".into(),
        });
    };
    let root = app_data.join("mixer-models").join("allen-heath-qu16");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let script = root.join("install-driver.ps1");
    let extract_directory = root.join("driver-5.72.0");
    fs::write(&script, DRIVER_INSTALL_SCRIPT).map_err(|error| error.to_string())?;
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-ArchivePath")
        .arg(&archive)
        .arg("-ExtractDirectory")
        .arg(&extract_directory)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("Allen & Heath 驱动安装未完成：{status}"));
    }
    #[cfg(windows)]
    cache_qu_driver_installed(true);
    Ok(MixerDriverStatus {
        state: "ready".into(),
        title: "驱动安装完成".into(),
        message: "Qu ASIO/WDM 5.72.0 已由厂商签名安装程序完成安装".into(),
        model_id: model_id.into(),
        driver_version: "5.72.0".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_model_packages() {
        assert!(driver_status("unknown-console").is_err());
    }
}
