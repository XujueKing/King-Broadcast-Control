use king_vocal_engine::profile_capture::{
    profile_input_devices, record_profile_sample, ProfileCaptureReport, ProfileInputDevice,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

pub const PROFILE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalProfileSample {
    pub prompt_id: String,
    pub path: String,
    pub captured_at_unix_ms: u64,
    pub report: ProfileCaptureReport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalProfile {
    pub schema_version: u32,
    pub id: String,
    pub display_name: String,
    pub consent_confirmed: bool,
    pub created_at_unix_ms: u64,
    pub state: String,
    pub accepted_sample_count: usize,
    pub required_sample_count: usize,
    pub accepted_seconds: f32,
    pub samples: BTreeMap<String, VocalProfileSample>,
    pub generator_state: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareSingerReferenceReport {
    pub profile_id: String,
    pub media_path: String,
    pub request_path: String,
    pub state: String,
    pub generator_available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingerReferenceBindingReport {
    pub profile_id: String,
    pub display_name: String,
    pub media_path: String,
    pub reference_path: String,
    pub reference_vocal_path: String,
    pub ready: bool,
    pub state: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SingerReferenceRequest<'a> {
    schema_version: u32,
    profile_id: &'a str,
    display_name: &'a str,
    media_path: &'a str,
    analysis_directory: &'a str,
    lyrics_path: String,
    words_path: String,
    accompaniment_path: String,
    source_vocals_path: String,
    sample_paths: Vec<String>,
    output_reference_path: String,
    created_at_unix_ms: u64,
    state: &'a str,
}

pub fn input_devices() -> Result<Vec<ProfileInputDevice>, String> {
    profile_input_devices().map_err(|error| error.to_string())
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<VocalProfile>, String> {
    let root = profiles_root(app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut profiles = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| read_manifest(&entry.path().join("profile.json")).ok())
        .map(|mut profile| {
            refresh_readiness(app, &mut profile);
            profile
        })
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| right.created_at_unix_ms.cmp(&left.created_at_unix_ms));
    Ok(profiles)
}

pub fn create(
    app: &tauri::AppHandle,
    display_name: String,
    consent_confirmed: bool,
) -> Result<VocalProfile, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("请输入歌手姓名或艺名".into());
    }
    if !consent_confirmed {
        return Err("必须由本人明确同意采集和生成，并允许随时删除歌手包".into());
    }
    let created_at_unix_ms = now_ms();
    let id = format!("{}-{}", safe_slug(display_name), created_at_unix_ms);
    let root = profiles_root(app)?.join(&id);
    fs::create_dir_all(root.join("samples")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("requests")).map_err(|error| error.to_string())?;
    let profile = VocalProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        id,
        display_name: display_name.into(),
        consent_confirmed,
        created_at_unix_ms,
        state: "collecting".into(),
        accepted_sample_count: 0,
        required_sample_count: 6,
        accepted_seconds: 0.0,
        samples: BTreeMap::new(),
        generator_state: generator_state(app),
        message: "请依次录制 6 段干声；不要音乐、伴奏、混响或原唱".into(),
    };
    write_manifest(&root.join("profile.json"), &profile)?;
    Ok(profile)
}

pub fn record(
    app: &tauri::AppHandle,
    profile_id: String,
    prompt_id: String,
    device_name: String,
    channel: usize,
) -> Result<VocalProfile, String> {
    validate_prompt(&prompt_id)?;
    let root = validated_profile_root(app, &profile_id)?;
    let manifest_path = root.join("profile.json");
    let mut profile = read_manifest(&manifest_path)?;
    if !profile.consent_confirmed {
        return Err("歌手未确认采集与生成授权".into());
    }
    let destination = root.join("samples").join(format!("{prompt_id}.wav"));
    let report = record_profile_sample(&device_name, channel, 15, &destination)
        .map_err(|error| error.to_string())?;
    profile.samples.insert(
        prompt_id.clone(),
        VocalProfileSample {
            prompt_id,
            path: destination.to_string_lossy().into_owned(),
            captured_at_unix_ms: now_ms(),
            report,
        },
    );
    refresh_readiness(app, &mut profile);
    write_manifest(&manifest_path, &profile)?;
    Ok(profile)
}

pub fn delete(app: &tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let root = validated_profile_root(app, &profile_id)?;
    fs::remove_dir_all(root).map_err(|error| error.to_string())
}

pub fn prepare_song(
    app: &tauri::AppHandle,
    profile_id: String,
    media_path: String,
) -> Result<PrepareSingerReferenceReport, String> {
    let root = validated_profile_root(app, &profile_id)?;
    let profile = read_manifest(&root.join("profile.json"))?;
    if profile.state != "samples_ready" {
        return Err("歌手包尚未通过 6 段采样质量检查".into());
    }
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    let media = PathBuf::from(&media_path);
    let job = crate::ai_analysis::ready_job_for_media_path(&database_path, &media)
        .map_err(|_| "当前歌曲尚未完成歌词、旋律和时间轴制作".to_string())?;
    let analysis = PathBuf::from(&job.derived_directory);
    let lyrics_path = analysis.join("lyrics.lrc");
    let words_path = words_artifact_path(&analysis);
    let accompaniment_path = analysis.join("no_vocals.flac");
    let source_vocals_path = analysis.join("vocals.flac");
    for required in [
        &lyrics_path,
        &words_path,
        &accompaniment_path,
        &source_vocals_path,
    ] {
        if !required.is_file() {
            return Err(format!("当前歌曲缺少制作产物：{}", required.display()));
        }
    }
    let request_path = root
        .join("requests")
        .join(format!("{}.json", job.media_fingerprint));
    let output_reference = analysis.join(format!("singer-{}-reference.flac", profile.id));
    let available = generator_available(app);
    let state = if available {
        "queued"
    } else {
        "generator_required"
    };
    let request = SingerReferenceRequest {
        schema_version: 1,
        profile_id: &profile.id,
        display_name: &profile.display_name,
        media_path: &job.media_path,
        analysis_directory: &job.derived_directory,
        lyrics_path: lyrics_path.to_string_lossy().into_owned(),
        words_path: words_path.to_string_lossy().into_owned(),
        accompaniment_path: accompaniment_path.to_string_lossy().into_owned(),
        source_vocals_path: source_vocals_path.to_string_lossy().into_owned(),
        sample_paths: profile
            .samples
            .values()
            .filter(|sample| sample.report.accepted)
            .map(|sample| sample.path.clone())
            .collect(),
        output_reference_path: output_reference.to_string_lossy().into_owned(),
        created_at_unix_ms: now_ms(),
        state,
    };
    write_json(&request_path, &request)?;
    if available {
        spawn_generator_worker(app, &request_path)?;
    }
    Ok(PrepareSingerReferenceReport {
        profile_id,
        media_path,
        request_path: request_path.to_string_lossy().into_owned(),
        state: state.into(),
        generator_available: available,
        message: if available {
            "女声补音参考已进入离线生成队列".into()
        } else {
            "歌手包与歌曲参考已就绪；本机尚未安装歌声生成模型，未使用男原唱冒充女声".into()
        },
    })
}

pub fn resolve_song_reference(
    app: &tauri::AppHandle,
    profile_id: String,
    media_path: String,
) -> Result<SingerReferenceBindingReport, String> {
    let root = validated_profile_root(app, &profile_id)?;
    let profile = read_manifest(&root.join("profile.json"))?;
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    let media = PathBuf::from(&media_path);
    let job = crate::ai_analysis::ready_job_for_media_path(&database_path, &media)
        .map_err(|_| "当前歌曲尚未完成歌词、旋律和时间轴制作".to_string())?;
    let analysis = PathBuf::from(&job.derived_directory);
    let reference_path = analysis.join("reference.json");
    let reference_vocal_path = analysis.join(format!("singer-{}-reference.flac", profile.id));
    let ready = reference_path.is_file() && reference_vocal_path.is_file();
    let request_path = root
        .join("requests")
        .join(format!("{}.json", job.media_fingerprint));
    let request = fs::read(&request_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let request_state = request
        .as_ref()
        .and_then(|value| value.get("state"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("missing");
    let (state, message) = if ready {
        (
            "ready",
            "歌手专属补音参考已就绪；等待现场路由安全确认".to_string(),
        )
    } else {
        match request_state {
            "queued" => ("queued", "女声补音参考正在等待离线生成".into()),
            "preparing_reference" => (
                "preparing_reference",
                "正在从六段原始采样准备歌手音色参考".into(),
            ),
            "converting_voice" => (
                "converting_voice",
                "正在为指定歌曲生成歌手专属女声参考".into(),
            ),
            "encoding" => ("encoding", "女声参考已生成，正在编码 FLAC".into()),
            "failed" => {
                let error = request
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("未知错误");
                ("failed", format!("女声补音参考生成失败：{error}"))
            }
            "generator_required" => (
                "generator_required",
                "生成请求已保存，但本机歌声生成器尚不可用".into(),
            ),
            "ready" => (
                "missing",
                "生成记录为 ready，但歌手参考轨文件不存在，请重新生成".into(),
            ),
            _ => ("missing", "当前歌曲尚未生成该歌手的补音参考轨".into()),
        }
    };

    Ok(SingerReferenceBindingReport {
        profile_id: profile.id,
        display_name: profile.display_name,
        media_path: job.media_path,
        reference_path: reference_path.to_string_lossy().into_owned(),
        reference_vocal_path: reference_vocal_path.to_string_lossy().into_owned(),
        ready,
        state: state.into(),
        message,
    })
}

fn refresh_readiness(app: &tauri::AppHandle, profile: &mut VocalProfile) {
    profile.accepted_sample_count = profile
        .samples
        .values()
        .filter(|sample| sample.report.accepted)
        .count();
    profile.accepted_seconds = profile
        .samples
        .values()
        .filter(|sample| sample.report.accepted)
        .map(|sample| sample.report.duration_seconds)
        .sum();
    profile.generator_state = generator_state(app);
    if profile.accepted_sample_count == profile.required_sample_count
        && profile.accepted_seconds >= 85.0
    {
        profile.state = "samples_ready".into();
        profile.message = "采样合格；以后换歌不再重复录制，但每首歌仍需离线生成一次补音参考".into();
    } else {
        profile.state = "collecting".into();
        profile.message = format!(
            "已通过 {}/{} 段，共 {:.0} 秒",
            profile.accepted_sample_count, profile.required_sample_count, profile.accepted_seconds
        );
    }
}

fn words_artifact_path(analysis: &Path) -> PathBuf {
    let canonical = analysis.join("lyrics.words.json");
    if canonical.is_file() {
        return canonical;
    }

    let legacy = analysis.join("words.json");
    if legacy.is_file() {
        legacy
    } else {
        canonical
    }
}

fn profiles_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("vocal-profiles"))
}

fn validated_profile_root(app: &tauri::AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    if profile_id.is_empty()
        || profile_id.contains('/')
        || profile_id.contains('\\')
        || profile_id.contains("..")
    {
        return Err("歌手包 ID 非法".into());
    }
    let root = profiles_root(app)?.join(profile_id);
    if !root.join("profile.json").is_file() {
        return Err("歌手包不存在".into());
    }
    Ok(root)
}

fn generator_available(app: &tauri::AppHandle) -> bool {
    generator_manifest(app)
        .ok()
        .and_then(|manifest| {
            let python = manifest.get("python")?.as_str()?;
            let worker = manifest.get("workerScript")?.as_str()?;
            let runtime = manifest.get("runtimeRoot")?.as_str()?;
            Some(
                Path::new(python).is_file()
                    && Path::new(worker).is_file()
                    && Path::new(runtime).join("inference.py").is_file(),
            )
        })
        .unwrap_or(false)
}

fn generator_manifest(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models/vocal-generator/manifest.json");
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn spawn_generator_worker(app: &tauri::AppHandle, request_path: &Path) -> Result<(), String> {
    let manifest = generator_manifest(app)?;
    let field = |name: &str| {
        manifest
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("歌声生成器配置缺少 {name}"))
    };
    let python = field("python")?;
    let worker = field("workerScript")?;
    let runtime = field("runtimeRoot")?;
    let ffmpeg = field("ffmpeg")?;
    for required in [&python, &worker, &ffmpeg] {
        if !Path::new(required).is_file() {
            return Err(format!("歌声生成器文件不存在：{required}"));
        }
    }
    if !Path::new(&runtime).join("inference.py").is_file() {
        return Err("Seed-VC 运行时不完整，请重新执行生成器安装".into());
    }

    let mut command = Command::new(python);
    command
        .arg(worker)
        .arg("--request")
        .arg(request_path)
        .arg("--runtime")
        .arg(runtime)
        .arg("--ffmpeg")
        .arg(ffmpeg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动女声参考生成器失败：{error}"))
}

fn generator_state(app: &tauri::AppHandle) -> String {
    if generator_available(app) {
        "ready"
    } else {
        "not_installed"
    }
    .into()
}

fn validate_prompt(prompt_id: &str) -> Result<(), String> {
    if matches!(
        prompt_id,
        "low" | "mid" | "high" | "sustain" | "articulation" | "dynamics"
    ) {
        Ok(())
    } else {
        Err("未知采样提示".into())
    }
}

fn read_manifest(path: &Path) -> Result<VocalProfile, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn write_manifest(path: &Path, profile: &VocalProfile) -> Result<(), String> {
    write_json(path, profile)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    replace_file(&temporary, path)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn safe_slug(value: &str) -> String {
    let slug = value
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '-' | '_'))
        .take(32)
        .collect::<String>();
    if slug.is_empty() {
        "singer".into()
    } else {
        slug
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::{words_artifact_path, write_json};
    use serde_json::json;
    use std::{fs, path::PathBuf};

    fn temporary_directory(test_name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "king-vocal-profile-{test_name}-{}-{}",
            std::process::id(),
            super::now_ms()
        ));
        fs::create_dir_all(&directory).expect("create temporary test directory");
        directory
    }

    #[test]
    fn prefers_canonical_lyrics_words_artifact() {
        let directory = temporary_directory("canonical");
        let canonical = directory.join("lyrics.words.json");
        fs::write(directory.join("words.json"), b"legacy").expect("write legacy artifact");
        fs::write(&canonical, b"canonical").expect("write canonical artifact");

        assert_eq!(words_artifact_path(&directory), canonical);
        fs::remove_dir_all(directory).expect("remove temporary test directory");
    }

    #[test]
    fn falls_back_to_legacy_words_artifact() {
        let directory = temporary_directory("legacy");
        let legacy = directory.join("words.json");
        fs::write(&legacy, b"legacy").expect("write legacy artifact");

        assert_eq!(words_artifact_path(&directory), legacy);
        fs::remove_dir_all(directory).expect("remove temporary test directory");
    }

    #[test]
    fn atomically_replaces_an_existing_profile_manifest() {
        let directory = temporary_directory("replace-manifest");
        let manifest = directory.join("profile.json");
        write_json(&manifest, &json!({"state":"collecting"})).expect("write first manifest");
        write_json(&manifest, &json!({"state":"samples_ready"}))
            .expect("replace existing manifest");
        let current: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).expect("read replaced manifest"))
                .expect("parse replaced manifest");
        assert_eq!(current["state"], "samples_ready");
        fs::remove_dir_all(directory).expect("remove temporary test directory");
    }
}
