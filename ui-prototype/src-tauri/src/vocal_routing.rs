use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ROUTING_FILE: &str = "vocal-routing.json";

pub fn status(app_data: &Path) -> Result<Value, String> {
    let path = routing_path(app_data);
    if !path.is_file() {
        return Ok(json!({
            "saved": false,
            "savedPath": path,
            "report": null,
            "message": "尚未保存 Vocal Engine 通道映射",
        }));
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取通道映射失败：{error}"))?;
    let report: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("通道映射文件无效：{error}"))?;
    validate_offline_report(&report)?;
    Ok(json!({
        "saved": true,
        "savedPath": path,
        "report": report,
        "message": "已加载离线通道映射；仍需连接 Qu-16 完成现场确认",
    }))
}

pub fn discover_virtual() -> Result<Value, String> {
    run_engine_report("discover-routing-virtual")
}

pub fn simulate_calibration_wizard() -> Result<Value, String> {
    run_engine_report("simulate-calibration-wizard")
}

pub fn replay_meter_fixture() -> Result<Value, String> {
    run_engine_report("replay-meter-fixture")
}

pub fn replay_joint_evidence() -> Result<Value, String> {
    run_engine_report("replay-joint-evidence")
}

pub fn replay_desktop_qu16_bridge() -> Result<Value, String> {
    run_engine_report("replay-desktop-qu16-bridge")
}

fn run_engine_report(command_name: &str) -> Result<Value, String> {
    let executable = super::vocal_runtime::resolve_vocal_engine_executable()?;
    let mut command = Command::new(&executable);
    command
        .arg(command_name)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("无法启动通道发现程序：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "离线校准程序执行失败".into()
        } else {
            format!("离线校准失败：{detail}")
        });
    }
    let report: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("通道发现报告无效：{error}"))?;
    validate_offline_report(&report)?;
    Ok(report)
}

pub fn save_offline(app_data: &Path, report: Value) -> Result<Value, String> {
    validate_offline_report(&report)?;
    fs::create_dir_all(app_data).map_err(|error| format!("建立配置目录失败：{error}"))?;
    let path = routing_path(app_data);
    let encoded =
        serde_json::to_vec_pretty(&report).map_err(|error| format!("编码通道映射失败：{error}"))?;
    fs::write(&path, encoded).map_err(|error| format!("保存通道映射失败：{error}"))?;
    Ok(json!({
        "saved": true,
        "savedPath": path,
        "report": report,
        "message": "离线映射已保存；现场确认前不会解除硬件阻断",
    }))
}

fn routing_path(app_data: &Path) -> PathBuf {
    app_data.join(ROUTING_FILE)
}

fn validate_offline_report(report: &Value) -> Result<(), String> {
    let mode = report.get("mode").and_then(Value::as_str);
    let common_safe = report.get("schemaVersion").and_then(Value::as_u64) == Some(1)
        && report.get("hardwareReady").and_then(Value::as_bool) == Some(false);
    let mode_safe = match mode {
        Some("virtual_signal_trace") => {
            report
                .get("structuralValidationPassed")
                .and_then(Value::as_bool)
                == Some(true)
                && report.get("writesPerformed").and_then(Value::as_bool) == Some(false)
                && report.get("audioOutputStarted").and_then(Value::as_bool) == Some(false)
        }
        Some("virtual_calibration_wizard") => {
            report.get("finalState").and_then(Value::as_str) == Some("complete")
                && report.get("completedLanes").and_then(Value::as_u64) == Some(3)
                && report.get("physicalAudioStarted").and_then(Value::as_bool) == Some(false)
                && report.get("qu16WritesPerformed").and_then(Value::as_bool) == Some(false)
        }
        _ => false,
    };
    if !common_safe || !mode_safe {
        return Err("拒绝保存：离线通道报告的安全标记不完整".into());
    }
    let map = report
        .get("routingMap")
        .and_then(Value::as_object)
        .ok_or_else(|| "拒绝保存：缺少 routingMap".to_string())?;
    if map.get("physicalHardware").and_then(Value::as_bool) != Some(false)
        || map.get("qu16MappingVerified").and_then(Value::as_bool) != Some(false)
    {
        return Err("拒绝保存：虚拟映射不能声明 Qu-16 已验证".into());
    }
    let lanes = map
        .get("lanes")
        .and_then(Value::as_array)
        .filter(|lanes| lanes.len() == 3)
        .ok_or_else(|| "拒绝保存：必须包含三路 Vocal Lane".to_string())?;
    let mut lane_ids = HashSet::new();
    let mut inputs = HashSet::new();
    let mut returns = HashSet::new();
    for lane in lanes {
        let lane_id = lane
            .get("lane")
            .and_then(Value::as_str)
            .ok_or_else(|| "拒绝保存：Vocal Lane 标识无效".to_string())?;
        let input = lane
            .get("inputDriverIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "拒绝保存：输入索引无效".to_string())?;
        let output = lane
            .get("returnDriverIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "拒绝保存：返回索引无效".to_string())?;
        if lane.get("evidence").and_then(Value::as_str) != Some("virtual_signal_trace")
            || !lane_ids.insert(lane_id)
            || !inputs.insert(input)
            || !returns.insert(output)
        {
            return Err("拒绝保存：通道证据或唯一性校验失败".into());
        }
    }
    if lane_ids != HashSet::from(["mic1", "mic2", "mic3"]) {
        return Err("拒绝保存：三路 Vocal Lane 不完整".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_report() -> Value {
        json!({
            "schemaVersion": 1,
            "mode": "virtual_signal_trace",
            "structuralValidationPassed": true,
            "hardwareReady": false,
            "writesPerformed": false,
            "audioOutputStarted": false,
            "routingMap": {
                "physicalHardware": false,
                "qu16MappingVerified": false,
                "lanes": [
                    {"lane":"mic1","inputDriverIndex":2,"returnDriverIndex":1,"evidence":"virtual_signal_trace"},
                    {"lane":"mic2","inputDriverIndex":5,"returnDriverIndex":4,"evidence":"virtual_signal_trace"},
                    {"lane":"mic3","inputDriverIndex":9,"returnDriverIndex":8,"evidence":"virtual_signal_trace"}
                ]
            }
        })
    }

    fn valid_wizard_report() -> Value {
        let mut report = valid_report();
        report["mode"] = json!("virtual_calibration_wizard");
        report["finalState"] = json!("complete");
        report["completedLanes"] = json!(3);
        report["physicalAudioStarted"] = json!(false);
        report["qu16WritesPerformed"] = json!(false);
        report
    }

    #[test]
    fn offline_report_cannot_claim_hardware_readiness() {
        let mut report = valid_report();
        report["hardwareReady"] = json!(true);
        assert!(validate_offline_report(&report).is_err());
    }

    #[test]
    fn duplicate_route_is_rejected_before_save() {
        let mut report = valid_report();
        report["routingMap"]["lanes"][1]["inputDriverIndex"] = json!(2);
        assert!(validate_offline_report(&report).is_err());
    }

    #[test]
    fn status_round_trip_preserves_safe_report() {
        let root = std::env::temp_dir().join(format!("king-vocal-routing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let saved = save_offline(&root, valid_report()).unwrap();
        assert_eq!(saved["saved"], true);
        let loaded = status(&root).unwrap();
        assert_eq!(loaded["saved"], true);
        assert_eq!(loaded["report"]["hardwareReady"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_virtual_wizard_report_is_saveable_but_still_offline() {
        let report = valid_wizard_report();
        assert!(validate_offline_report(&report).is_ok());
        assert_eq!(report["hardwareReady"], false);
    }
}
