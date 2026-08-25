use serde::Serialize;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub mode: String,
    pub has_nvidia: bool,
    pub gpu_names: Vec<String>,
    pub total_vram_mib: u64,
    pub driver_version: Option<String>,
    pub ai_processing_available: bool,
    pub message: String,
}

fn nvidia_smi_output() -> Option<String> {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn from_nvidia_smi_output(output: Option<&str>) -> RuntimeCapabilities {
    let mut gpu_names = Vec::new();
    let mut total_vram_mib = 0_u64;
    let mut driver_version = None;
    if let Some(output) = output {
        for line in output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let fields: Vec<_> = line.split(',').map(str::trim).collect();
            if let Some(name) = fields.first().filter(|value| !value.is_empty()) {
                gpu_names.push((*name).to_string());
            }
            total_vram_mib = total_vram_mib.saturating_add(
                fields
                    .get(1)
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or_default(),
            );
            if driver_version.is_none() {
                driver_version = fields.get(2).map(|value| (*value).to_string());
            }
        }
    }
    let has_nvidia = !gpu_names.is_empty();
    RuntimeCapabilities {
        mode: if has_nvidia { "full" } else { "player" }.to_string(),
        has_nvidia,
        gpu_names: gpu_names.clone(),
        total_vram_mib,
        driver_version,
        ai_processing_available: has_nvidia,
        message: if has_nvidia {
            format!(
                "全功能版 · {} · {:.1} GB 显存",
                gpu_names.join(" / "),
                total_vram_mib as f64 / 1024.0
            )
        } else {
            "播放版 · 未检测到 NVIDIA GPU · 可导入并播放 .kingsong".to_string()
        },
    }
}

pub fn detect() -> RuntimeCapabilities {
    if let Ok(forced) = std::env::var("KING_FORCE_RUNTIME_MODE") {
        let has_nvidia = forced.eq_ignore_ascii_case("full");
        return RuntimeCapabilities {
            mode: if has_nvidia { "full" } else { "player" }.to_string(),
            has_nvidia,
            gpu_names: has_nvidia
                .then(|| "测试 NVIDIA GPU".to_string())
                .into_iter()
                .collect(),
            total_vram_mib: 0,
            driver_version: None,
            ai_processing_available: has_nvidia,
            message: if has_nvidia {
                "全功能版（测试覆盖）"
            } else {
                "播放版（测试覆盖）"
            }
            .to_string(),
        };
    }

    let output = nvidia_smi_output();
    from_nvidia_smi_output(output.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_payload_uses_stable_mode_names() {
        let value = RuntimeCapabilities {
            mode: "player".to_string(),
            has_nvidia: false,
            gpu_names: Vec::new(),
            total_vram_mib: 0,
            driver_version: None,
            ai_processing_available: false,
            message: "播放版".to_string(),
        };
        assert_eq!(value.mode, "player");
        assert!(!value.ai_processing_available);
    }

    #[test]
    fn nvidia_presence_selects_full_and_absence_selects_player() {
        let full = from_nvidia_smi_output(Some("NVIDIA GeForce RTX 5090, 24463, 592.01\n"));
        assert_eq!(full.mode, "full");
        assert_eq!(full.total_vram_mib, 24463);
        let player = from_nvidia_smi_output(None);
        assert_eq!(player.mode, "player");
        assert!(!player.ai_processing_available);
    }
}
