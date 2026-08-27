use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const FORMAT: &str = "club.king.kinglight";
const VERSION: u64 = 1;
const MAX_PACKAGE_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KinglightDirectories {
    pub root_directory: String,
    pub inbox_directory: String,
    pub outbox_directory: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct KinglightExportResult {
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct KinglightImportResult {
    pub path: String,
    pub package: Value,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn directories(app_data: &Path) -> Result<KinglightDirectories, String> {
    let root = app_data.join("lighting").join("packages");
    let inbox = root.join("inbox");
    let outbox = root.join("outbox");
    fs::create_dir_all(&inbox).map_err(|error| error.to_string())?;
    fs::create_dir_all(&outbox).map_err(|error| error.to_string())?;
    Ok(KinglightDirectories {
        root_directory: path_text(&root),
        inbox_directory: path_text(&inbox),
        outbox_directory: path_text(&outbox),
    })
}

fn validate_payload(payload: &str) -> Result<Value, String> {
    if payload.len() > MAX_PACKAGE_BYTES {
        return Err(".kinglight 配置包超过 512 KiB 安全上限".to_string());
    }
    let value: Value =
        serde_json::from_str(payload).map_err(|_| ".kinglight JSON 无效".to_string())?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT)
        || value.get("version").and_then(Value::as_u64) != Some(VERSION)
    {
        return Err("不支持的 .kinglight 格式或版本".to_string());
    }
    if value
        .pointer("/safety/executeOnImport")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Err(".kinglight 必须明确禁止导入即执行".to_string());
    }
    Ok(value)
}

fn safe_name(value: Option<&str>) -> String {
    let name: String = value
        .unwrap_or("lighting")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = name.trim_matches(['-', '.']);
    if trimmed.is_empty() {
        "lighting".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn export(app_data: &Path, payload: &str) -> Result<KinglightExportResult, String> {
    let value = validate_payload(payload)?;
    let paths = directories(app_data)?;
    let outbox = PathBuf::from(paths.outbox_directory);
    let show_name = safe_name(value.pointer("/console/showName").and_then(Value::as_str));
    let destination = outbox.join(format!("KING-{show_name}-{}.kinglight", timestamp()));
    let partial = destination.with_extension("kinglight.partial");
    let encoded = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    fs::write(&partial, encoded).map_err(|error| error.to_string())?;
    fs::rename(&partial, &destination).map_err(|error| error.to_string())?;
    Ok(KinglightExportResult {
        path: path_text(&destination),
    })
}

pub fn import_latest(app_data: &Path) -> Result<KinglightImportResult, String> {
    let paths = directories(app_data)?;
    let inbox = PathBuf::from(paths.inbox_directory);
    let mut candidates = fs::read_dir(&inbox)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("kinglight"))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let path = candidates
        .pop()
        .ok_or_else(|| "灯光配置收件箱中没有 .kinglight".to_string())?;
    let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let package = validate_payload(&payload)?;
    Ok(KinglightImportResult {
        path: path_text(&path),
        package,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("kinglight-{name}-{}", timestamp()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn payload() -> &'static str {
        r#"{"format":"club.king.kinglight","version":1,"console":{"showName":"2024.12.28"},"safety":{"executeOnImport":false}}"#
    }

    #[test]
    fn export_and_import_latest_round_trip() {
        let app_data = root("round-trip");
        let exported = export(&app_data, payload()).unwrap();
        let paths = directories(&app_data).unwrap();
        let inbox = PathBuf::from(paths.inbox_directory).join("venue.kinglight");
        fs::copy(exported.path, &inbox).unwrap();
        let imported = import_latest(&app_data).unwrap();
        assert_eq!(imported.package["format"], FORMAT);
        let _ = fs::remove_dir_all(app_data);
    }

    #[test]
    fn rejects_execute_on_import() {
        let unsafe_payload =
            r#"{"format":"club.king.kinglight","version":1,"safety":{"executeOnImport":true}}"#;
        assert!(validate_payload(unsafe_payload).is_err());
    }
}
