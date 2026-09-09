use crate::ai_analysis;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAGIC: &[u8; 8] = b"KSG1\r\n\x1a\n";
const FORMAT_NAME: &str = "club.king.kingsong";
const FORMAT_VERSION: u16 = 1;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 16;
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPackageDirectories {
    pub root_directory: String,
    pub inbox_directory: String,
    pub outbox_directory: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPackageResult {
    pub path: String,
    pub song_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPackageImportReport {
    pub imported: Vec<SongPackageResult>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongManifest {
    format: String,
    format_version: u16,
    song_id: String,
    title: String,
    artist: Option<String>,
    pipeline_version: String,
    separator_model: String,
    asr_model: String,
    aligner_model: String,
    created_at_unix_ms: u128,
    original_file: String,
    accompaniment_file: String,
    lyrics_file: String,
    timestamps_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference_file: Option<String>,
    hash_algorithm: String,
}

#[derive(Clone, Debug)]
struct EntryRecord {
    name: String,
    source: PathBuf,
    size: u64,
    hash: [u8; 32],
}

#[derive(Clone, Debug)]
struct PackedEntry {
    name: String,
    size: u64,
    hash: [u8; 32],
}

static IMPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, PartialEq)]
struct ImportFileStamp {
    path: PathBuf,
    size: u64,
    modified: u128,
}

fn file_stamp(path: &Path) -> Option<ImportFileStamp> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(ImportFileStamp {
        path: path.to_path_buf(),
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    })
}

#[derive(Serialize, Deserialize)]
struct ImportReceipt {
    package: ImportFileStamp,
    files: Vec<ImportFileStamp>,
    result: SongPackageResult,
}

fn receipt_path(app_data: &Path, media_root: &Path, package: &Path) -> PathBuf {
    let key = format!("{}|{}", media_root.display(), package.display());
    app_data
        .join("song-packages/receipts")
        .join(format!("{}.json", blake3::hash(key.as_bytes()).to_hex()))
}

fn cached_import(
    app_data: &Path,
    receipt: &Path,
    package: &ImportFileStamp,
) -> Option<SongPackageResult> {
    let saved: ImportReceipt = serde_json::from_slice(&fs::read(receipt).ok()?).ok()?;
    if &saved.package != package
        || saved.files.is_empty()
        || saved
            .files
            .iter()
            .any(|file| file_stamp(&file.path).as_ref() != Some(file))
    {
        return None;
    }
    // Metadata caching skips unpacking only after a fully verified import, and only
    // while every published file and the ready database registration are intact.
    let job = ai_analysis::ready_job_for_media_path(
        &app_data.join("king-club.sqlite3"),
        Path::new(&saved.result.path),
    )
    .ok()?;
    if job.media_fingerprint != saved.result.song_id {
        return None;
    }
    Some(SongPackageResult {
        status: "already-imported".into(),
        ..saved.result
    })
}

pub fn directories(app_data: &Path) -> Result<SongPackageDirectories, String> {
    let root = app_data.join("song-packages");
    let inbox = root.join("inbox");
    let outbox = root.join("outbox");
    fs::create_dir_all(&inbox).map_err(|error| error.to_string())?;
    fs::create_dir_all(&outbox).map_err(|error| error.to_string())?;
    Ok(SongPackageDirectories {
        root_directory: root.to_string_lossy().into_owned(),
        inbox_directory: inbox.to_string_lossy().into_owned(),
        outbox_directory: outbox.to_string_lossy().into_owned(),
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "未命名歌曲".to_string()
    } else {
        cleaned.chars().take(120).collect()
    }
}

fn hash_file(path: &Path) -> Result<([u8; 32], u64), String> {
    let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut hasher = blake3::Hasher::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size = size.saturating_add(read as u64);
    }
    Ok((*hasher.finalize().as_bytes(), size))
}

fn validate_reference_map(path: &Path, song_id: &str) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("无法读取参考音高图：{error}"))?,
    )
    .map_err(|error| format!("参考音高图格式错误：{error}"))?;
    let source_duration = payload
        .get("sourceDurationSamples")
        .and_then(serde_json::Value::as_u64);
    let valid_segments = payload
        .get("segments")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|segments| {
            !segments.is_empty()
                && segments.iter().all(|segment| {
                    let start = segment
                        .get("startSample")
                        .and_then(serde_json::Value::as_u64);
                    let end = segment.get("endSample").and_then(serde_json::Value::as_u64);
                    let midi = segment.get("midiNote").and_then(serde_json::Value::as_u64);
                    let target = segment.get("targetHz").and_then(serde_json::Value::as_f64);
                    let confidence = segment
                        .get("confidence")
                        .and_then(serde_json::Value::as_f64);
                    start.zip(end).is_some_and(|(start, end)| {
                        start < end && source_duration.map_or(true, |duration| end <= duration)
                    }) && midi.is_some_and(|midi| midi <= 127)
                        && target.is_some_and(|target| target.is_finite() && target > 0.0)
                        && confidence.is_some_and(|confidence| (0.0..=1.0).contains(&confidence))
                })
                && segments.windows(2).all(|pair| {
                    pair[0]
                        .get("startSample")
                        .and_then(serde_json::Value::as_u64)
                        <= pair[1]
                            .get("startSample")
                            .and_then(serde_json::Value::as_u64)
                })
        });
    if payload
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || payload
            .get("sampleRate")
            .and_then(serde_json::Value::as_u64)
            != Some(48_000)
        || payload
            .get("sourceFingerprint")
            .and_then(serde_json::Value::as_str)
            != Some(song_id)
        || !valid_segments
    {
        return Err("参考音高图与歌曲指纹、采样率或格式不匹配".to_string());
    }
    Ok(())
}

fn unique_output_path(directory: &Path, base_name: &str) -> PathBuf {
    let first = directory.join(format!("{base_name}.kingsong"));
    if !first.exists() {
        return first;
    }
    (2..10_000)
        .map(|index| directory.join(format!("{base_name} ({index}).kingsong")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| directory.join(format!("{base_name}-{}.kingsong", now_ms())))
}

fn write_u16(writer: &mut impl Write, value: u16) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

fn write_u32(writer: &mut impl Write, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

fn write_u64(writer: &mut impl Write, value: u64) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

fn read_u16(reader: &mut impl Read) -> Result<u16, String> {
    let mut value = [0_u8; 2];
    reader
        .read_exact(&mut value)
        .map_err(|error| error.to_string())?;
    Ok(u16::from_le_bytes(value))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, String> {
    let mut value = [0_u8; 4];
    reader
        .read_exact(&mut value)
        .map_err(|error| error.to_string())?;
    Ok(u32::from_le_bytes(value))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, String> {
    let mut value = [0_u8; 8];
    reader
        .read_exact(&mut value)
        .map_err(|error| error.to_string())?;
    Ok(u64::from_le_bytes(value))
}

fn write_container(
    destination: &Path,
    manifest: &SongManifest,
    entries: &[EntryRecord],
) -> Result<(), String> {
    let manifest_bytes = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES || entries.len() > MAX_ENTRY_COUNT {
        return Err(".kingsong 元数据超出格式限制".to_string());
    }
    let partial = destination.with_extension("kingsong.partial");
    let result = (|| {
        let file = File::create(&partial).map_err(|error| error.to_string())?;
        let mut writer = BufWriter::new(file);
        writer.write_all(MAGIC).map_err(|error| error.to_string())?;
        write_u32(&mut writer, manifest_bytes.len() as u32)?;
        write_u16(&mut writer, entries.len() as u16)?;
        write_u16(&mut writer, 0)?;
        writer
            .write_all(&manifest_bytes)
            .map_err(|error| error.to_string())?;
        for entry in entries {
            let name = entry.name.as_bytes();
            write_u16(&mut writer, name.len() as u16)?;
            writer.write_all(name).map_err(|error| error.to_string())?;
            write_u64(&mut writer, entry.size)?;
            writer
                .write_all(&entry.hash)
                .map_err(|error| error.to_string())?;
        }
        for entry in entries {
            let mut source =
                BufReader::new(File::open(&entry.source).map_err(|error| error.to_string())?);
            std::io::copy(&mut source, &mut writer).map_err(|error| error.to_string())?;
        }
        writer.flush().map_err(|error| error.to_string())?;
        drop(writer);
        fs::rename(&partial, destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

pub fn export_song(
    app_data: &Path,
    media_path: &Path,
    title: Option<&str>,
    artist: Option<&str>,
) -> Result<SongPackageResult, String> {
    let database = app_data.join("king-club.sqlite3");
    let job = ai_analysis::ready_job_for_media_path(&database, media_path)?;
    let derived = PathBuf::from(&job.derived_directory);
    let original_extension = media_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            value
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or("audio")
        .to_ascii_lowercase();
    let original_file = format!("media/original.{original_extension}");
    let title = title
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            media_path
                .file_stem()
                .map(|value| value.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "未命名歌曲".to_string());
    let reference_source = derived.join("reference.json");
    let reference_file = reference_source
        .is_file()
        .then(|| "analysis/reference.json".to_string());
    if job.pipeline_version == ai_analysis::PIPELINE_VERSION && reference_file.is_none() {
        return Err("当前制作版本缺少 reference.json，请重新进入制作队列".to_string());
    }
    if reference_file.is_some() {
        validate_reference_map(&reference_source, &job.media_fingerprint)?;
    }
    let manifest = SongManifest {
        format: FORMAT_NAME.to_string(),
        format_version: FORMAT_VERSION,
        song_id: job.media_fingerprint.clone(),
        title: title.clone(),
        artist: artist
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        pipeline_version: job.pipeline_version.clone(),
        separator_model: job.separator_model.clone(),
        asr_model: job.asr_model.clone(),
        aligner_model: job.aligner_model.clone(),
        created_at_unix_ms: now_ms(),
        original_file: original_file.clone(),
        accompaniment_file: "media/accompaniment.flac".to_string(),
        lyrics_file: "lyrics/lyrics.lrc".to_string(),
        timestamps_file: "lyrics/lyrics.words.json".to_string(),
        reference_file: reference_file.clone(),
        hash_algorithm: "blake3".to_string(),
    };
    let mut sources = vec![
        (original_file, media_path.to_path_buf()),
        (
            "media/accompaniment.flac".to_string(),
            derived.join("no_vocals.flac"),
        ),
        ("lyrics/lyrics.lrc".to_string(), derived.join("lyrics.lrc")),
        (
            "lyrics/lyrics.words.json".to_string(),
            derived.join("lyrics.words.json"),
        ),
    ];
    if let Some(reference_file) = reference_file {
        sources.push((reference_file, reference_source));
    }
    let mut entries = Vec::new();
    for (name, source) in sources {
        if !source.is_file() {
            return Err(format!("歌曲包缺少必需成品：{}", source.display()));
        }
        let (hash, size) = hash_file(&source)?;
        entries.push(EntryRecord {
            name,
            source,
            size,
            hash,
        });
    }
    let package_directories = directories(app_data)?;
    let base_name = sanitize_filename(&match manifest.artist.as_deref() {
        Some(artist) => format!("{artist} - {}", manifest.title),
        None => manifest.title.clone(),
    });
    let destination =
        unique_output_path(Path::new(&package_directories.outbox_directory), &base_name);
    write_container(&destination, &manifest, &entries)?;
    Ok(SongPackageResult {
        path: destination.to_string_lossy().into_owned(),
        song_id: manifest.song_id,
        title: manifest.title,
        artist: manifest.artist,
        status: "exported".to_string(),
    })
}

fn read_header(reader: &mut impl Read) -> Result<(SongManifest, Vec<PackedEntry>), String> {
    let mut magic = [0_u8; 8];
    reader
        .read_exact(&mut magic)
        .map_err(|error| error.to_string())?;
    if &magic != MAGIC {
        return Err("不是有效的 KINGSONG 二进制歌曲包".to_string());
    }
    let manifest_length = read_u32(reader)? as usize;
    let entry_count = read_u16(reader)? as usize;
    let _reserved = read_u16(reader)?;
    if manifest_length == 0
        || manifest_length > MAX_MANIFEST_BYTES
        || entry_count == 0
        || entry_count > MAX_ENTRY_COUNT
    {
        return Err(".kingsong 文件头超出安全限制".to_string());
    }
    let mut manifest_bytes = vec![0_u8; manifest_length];
    reader
        .read_exact(&mut manifest_bytes)
        .map_err(|error| error.to_string())?;
    let manifest: SongManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| error.to_string())?;
    if manifest.format != FORMAT_NAME || manifest.format_version != FORMAT_VERSION {
        return Err("不支持的 .kingsong 格式或版本".to_string());
    }
    if manifest.song_id.len() != 64
        || !manifest
            .song_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || manifest.hash_algorithm != "blake3"
    {
        return Err(".kingsong 标识或校验算法无效".to_string());
    }
    let mut required: HashSet<_> = [
        manifest.original_file.clone(),
        manifest.accompaniment_file.clone(),
        manifest.lyrics_file.clone(),
        manifest.timestamps_file.clone(),
    ]
    .into_iter()
    .collect();
    if let Some(reference_file) = &manifest.reference_file {
        required.insert(reference_file.clone());
    }
    let mut names = HashSet::new();
    let mut total_size = 0_u64;
    let mut entries = Vec::new();
    for _ in 0..entry_count {
        let name_length = read_u16(reader)? as usize;
        if name_length == 0 || name_length > 256 {
            return Err(".kingsong 文件名长度无效".to_string());
        }
        let mut name_bytes = vec![0_u8; name_length];
        reader
            .read_exact(&mut name_bytes)
            .map_err(|error| error.to_string())?;
        let name = String::from_utf8(name_bytes).map_err(|error| error.to_string())?;
        let size = read_u64(reader)?;
        let mut hash = [0_u8; 32];
        reader
            .read_exact(&mut hash)
            .map_err(|error| error.to_string())?;
        if !required.contains(&name)
            || name.contains('\\')
            || name.starts_with('/')
            || name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || !names.insert(name.clone())
            || size > MAX_ENTRY_BYTES
        {
            return Err(".kingsong 包含不安全或重复的文件条目".to_string());
        }
        total_size = total_size.saturating_add(size);
        if total_size > MAX_TOTAL_BYTES {
            return Err(".kingsong 解包尺寸超出安全限制".to_string());
        }
        entries.push(PackedEntry { name, size, hash });
    }
    if names != required {
        return Err(".kingsong 缺少必需文件".to_string());
    }
    Ok((manifest, entries))
}

fn copy_entry(
    reader: &mut impl Read,
    destination: &Path,
    entry: &PackedEntry,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut writer = BufWriter::new(File::create(destination).map_err(|error| error.to_string())?);
    let mut remaining = entry.size;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    while remaining > 0 {
        let requested = remaining.min(buffer.len() as u64) as usize;
        let read = reader
            .read(&mut buffer[..requested])
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err(".kingsong 数据块提前结束".to_string());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    writer.flush().map_err(|error| error.to_string())?;
    if hasher.finalize().as_bytes() != &entry.hash {
        return Err(format!(".kingsong 文件校验失败：{}", entry.name));
    }
    Ok(())
}

fn remove_staging(path: &Path) {
    if path
        .components()
        .any(|component| component.as_os_str() == "song-packages")
        && path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("staging-"))
    {
        let _ = fs::remove_dir_all(path);
    }
}

pub fn import_song(
    app_data: &Path,
    media_root: &Path,
    package_path: &Path,
) -> Result<SongPackageResult, String> {
    if package_path
        .extension()
        .and_then(|value| value.to_str())
        .map_or(true, |value| !value.eq_ignore_ascii_case("kingsong"))
    {
        return Err("只能导入 .kingsong 文件".to_string());
    }
    let _guard = IMPORT_LOCK.lock().map_err(|_| "歌曲导入锁异常")?;
    let package_path = package_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let stamp = file_stamp(&package_path).ok_or("无法读取歌曲包状态")?;
    let receipt = receipt_path(app_data, media_root, &package_path);
    if let Some(cached) = cached_import(app_data, &receipt, &stamp) {
        return Ok(cached);
    }
    let package = File::open(&package_path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(package);
    let (manifest, entries) = read_header(&mut reader)?;
    let package_root = app_data.join("song-packages");
    fs::create_dir_all(&package_root).map_err(|error| error.to_string())?;
    let staging = package_root.join(format!("staging-{}-{}", std::process::id(), now_ms()));
    let staging_media = staging.join("media");
    let staging_analysis = staging.join("analysis");
    fs::create_dir_all(&staging_media).map_err(|error| error.to_string())?;
    fs::create_dir_all(&staging_analysis).map_err(|error| error.to_string())?;
    let import_result = (|| {
        let original_extension = Path::new(&manifest.original_file)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            })
            .ok_or_else(|| ".kingsong 原唱扩展名无效".to_string())?;
        for entry in &entries {
            let destination = if entry.name == manifest.original_file {
                staging_media.join(format!("original.{original_extension}"))
            } else if entry.name == manifest.accompaniment_file {
                staging_analysis.join("no_vocals.flac")
            } else if entry.name == manifest.lyrics_file {
                staging_analysis.join("lyrics.lrc")
            } else if entry.name == manifest.timestamps_file {
                staging_analysis.join("lyrics.words.json")
            } else if manifest.reference_file.as_deref() == Some(entry.name.as_str()) {
                staging_analysis.join("reference.json")
            } else {
                return Err(".kingsong 包含未知条目".to_string());
            };
            copy_entry(&mut reader, &destination, entry)?;
        }
        fs::write(
            staging_media.join("kingsong.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let original_name = format!("original.{original_extension}");
        let staged_original = staging_media.join(&original_name);
        if ai_analysis::fingerprint(&staged_original)? != manifest.song_id {
            return Err(".kingsong 歌曲指纹与原唱内容不一致".to_string());
        }
        if manifest.reference_file.is_some() {
            validate_reference_map(&staging_analysis.join("reference.json"), &manifest.song_id)?;
        }
        let target_media_directory = media_root
            .join("audio")
            .join("imported")
            .join(&manifest.song_id);
        let target_analysis_directory = app_data.join("analysis").join(&manifest.song_id);
        let target_original = target_media_directory.join(&original_name);
        if target_original.is_file()
            && target_analysis_directory.join("no_vocals.flac").is_file()
            && target_analysis_directory.join("lyrics.lrc").is_file()
            && target_analysis_directory
                .join("lyrics.words.json")
                .is_file()
            && manifest.reference_file.as_ref().map_or(true, |_| {
                target_analysis_directory.join("reference.json").is_file()
            })
        {
            if ai_analysis::fingerprint(&target_original)? != manifest.song_id {
                return Err("本机已有同 ID 但内容不同的歌曲".to_string());
            }
            // A cache miss must revalidate published derivatives as well as the
            // original. Never bless a changed/corrupt target with a fresh receipt.
            for entry in fs::read_dir(&staging_analysis).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let target = target_analysis_directory.join(entry.file_name());
                if hash_file(&entry.path())? != hash_file(&target)? {
                    return Err("本机同 ID 的制作文件与歌曲包不一致，请检查后重新导入".to_string());
                }
            }
            ai_analysis::register_imported_ready(
                &app_data.join("king-club.sqlite3"),
                &target_original,
                &manifest.song_id,
                &target_analysis_directory,
                &manifest.pipeline_version,
                &manifest.separator_model,
                &manifest.asr_model,
                &manifest.aligner_model,
            )?;
            return Ok(target_original);
        }
        if target_media_directory.exists() || target_analysis_directory.exists() {
            return Err("本机存在未完成的同 ID 导入目录，请人工检查后重试".to_string());
        }
        if let Some(parent) = target_media_directory.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if let Some(parent) = target_analysis_directory.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::rename(&staging_analysis, &target_analysis_directory)
            .map_err(|error| error.to_string())?;
        if let Err(error) = fs::rename(&staging_media, &target_media_directory) {
            let _ = fs::rename(&target_analysis_directory, &staging_analysis);
            return Err(format!("歌曲媒体发布失败：{error}"));
        }
        let target_original = target_media_directory.join(original_name);
        ai_analysis::register_imported_ready(
            &app_data.join("king-club.sqlite3"),
            &target_original,
            &manifest.song_id,
            &target_analysis_directory,
            &manifest.pipeline_version,
            &manifest.separator_model,
            &manifest.asr_model,
            &manifest.aligner_model,
        )?;
        Ok(target_original)
    })();
    match import_result {
        Ok(target_original) => {
            remove_staging(&staging);
            let mut paths = vec![
                target_original.clone(),
                target_original.parent().unwrap().join("kingsong.json"),
            ];
            let analysis = app_data.join("analysis").join(&manifest.song_id);
            paths.extend(
                ["no_vocals.flac", "lyrics.lrc", "lyrics.words.json"]
                    .into_iter()
                    .map(|name| analysis.join(name)),
            );
            if manifest.reference_file.is_some() {
                paths.push(analysis.join("reference.json"));
            }
            let result = SongPackageResult {
                path: target_original.to_string_lossy().into_owned(),
                song_id: manifest.song_id,
                title: manifest.title,
                artist: manifest.artist,
                status: "imported".into(),
            };
            let stamps: Option<Vec<_>> = paths.iter().map(|path| file_stamp(path)).collect();
            if let Some(files) = stamps {
                if let Some(parent) = receipt.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(bytes) = serde_json::to_vec(&ImportReceipt {
                    package: stamp,
                    files,
                    result: result.clone(),
                }) {
                    // A missing/partial receipt is treated as a cache miss; source packages remain untouched.
                    let _ = fs::write(&receipt, bytes);
                }
            }
            Ok(result)
        }
        Err(error) => {
            remove_staging(&staging);
            Err(error)
        }
    }
}

pub fn import_inbox(app_data: &Path, media_root: &Path) -> Result<SongPackageImportReport, String> {
    let package_directories = directories(app_data)?;
    let inbox = Path::new(&package_directories.inbox_directory);
    let mut packages: Vec<_> = fs::read_dir(inbox)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("kingsong"))
        })
        .collect();
    packages.sort();
    let mut report = SongPackageImportReport {
        imported: Vec::new(),
        errors: Vec::new(),
    };
    for package in packages {
        match import_song(app_data, media_root, &package) {
            Ok(result) => report.imported.push(result),
            Err(error) => report.errors.push(format!(
                "{}：{error}",
                package.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "king-kingsong-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    #[test]
    fn binary_container_round_trip_and_rejects_wrong_magic() {
        let root = test_root("round-trip");
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original.flac");
        let accompaniment = root.join("no_vocals.flac");
        let lyrics = root.join("lyrics.lrc");
        let words = root.join("lyrics.words.json");
        fs::write(&original, b"original-audio").unwrap();
        fs::write(&accompaniment, b"accompaniment-audio").unwrap();
        fs::write(&lyrics, b"[00:00.00]test\n").unwrap();
        fs::write(&words, b"{\"items\":[]}").unwrap();
        let sources = [
            ("media/original.flac", original),
            ("media/accompaniment.flac", accompaniment),
            ("lyrics/lyrics.lrc", lyrics),
            ("lyrics/lyrics.words.json", words),
        ];
        let entries: Vec<_> = sources
            .into_iter()
            .map(|(name, source)| {
                let (hash, size) = hash_file(&source).unwrap();
                EntryRecord {
                    name: name.to_string(),
                    source,
                    size,
                    hash,
                }
            })
            .collect();
        let manifest = SongManifest {
            format: FORMAT_NAME.to_string(),
            format_version: FORMAT_VERSION,
            song_id: "a".repeat(64),
            title: "Test".to_string(),
            artist: None,
            pipeline_version: "test".to_string(),
            separator_model: "test".to_string(),
            asr_model: "test".to_string(),
            aligner_model: "test".to_string(),
            created_at_unix_ms: now_ms(),
            original_file: "media/original.flac".to_string(),
            accompaniment_file: "media/accompaniment.flac".to_string(),
            lyrics_file: "lyrics/lyrics.lrc".to_string(),
            timestamps_file: "lyrics/lyrics.words.json".to_string(),
            reference_file: None,
            hash_algorithm: "blake3".to_string(),
        };
        let package = root.join("test.kingsong");
        write_container(&package, &manifest, &entries).unwrap();
        let mut reader = BufReader::new(File::open(&package).unwrap());
        let (decoded, packed) = read_header(&mut reader).unwrap();
        assert_eq!(decoded.format, FORMAT_NAME);
        assert_eq!(packed.len(), 4);
        fs::write(root.join("bad.kingsong"), b"not-a-package").unwrap();
        let mut bad = BufReader::new(File::open(root.join("bad.kingsong")).unwrap());
        assert!(read_header(&mut bad).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_reference_map_for_another_song() {
        let root = test_root("reference-identity");
        fs::create_dir_all(&root).unwrap();
        let reference = root.join("reference.json");
        fs::write(
            &reference,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "sampleRate": 48_000,
                "hopFrames": 128,
                "sourceFingerprint": "b".repeat(64),
                "sourceDurationSamples": 128,
                "segments": [{
                    "startSample": 0,
                    "endSample": 128,
                    "midiNote": 69,
                    "targetHz": 440.0,
                    "confidence": 0.99
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(validate_reference_map(&reference, &"a".repeat(64)).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exports_and_imports_a_portable_ready_song() {
        let root = test_root("portable");
        let source_app = root.join("source-app");
        let source_media = root.join("source-media/song.flac");
        let source_analysis = source_app.join("analysis/source");
        fs::create_dir_all(source_media.parent().unwrap()).unwrap();
        fs::create_dir_all(&source_analysis).unwrap();
        fs::write(&source_media, b"portable original audio bytes").unwrap();
        fs::write(
            source_analysis.join("no_vocals.flac"),
            b"portable accompaniment",
        )
        .unwrap();
        fs::write(source_analysis.join("lyrics.lrc"), b"[00:00.00]portable\n").unwrap();
        fs::write(source_analysis.join("lyrics.words.json"), b"{\"items\":[]}").unwrap();
        let fingerprint = ai_analysis::fingerprint(&source_media).unwrap();
        fs::write(
            source_analysis.join("reference.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "sampleRate": 48_000,
                "hopFrames": 128,
                "source": "vocals.flac",
                "sourceFingerprint": fingerprint,
                "sourceDurationSamples": 128,
                "timelineOffsetSamples": 0,
                "segments": [{
                    "startSample": 0,
                    "endSample": 128,
                    "midiNote": 69,
                    "targetHz": 440.0,
                    "confidence": 0.99
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        ai_analysis::register_imported_ready(
            &source_app.join("king-club.sqlite3"),
            &source_media,
            &fingerprint,
            &source_analysis,
            ai_analysis::PIPELINE_VERSION,
            ai_analysis::SEPARATOR_MODEL,
            ai_analysis::ASR_MODEL,
            ai_analysis::ALIGNER_MODEL,
        )
        .unwrap();
        let exported =
            export_song(&source_app, &source_media, Some("Portable"), Some("KING")).unwrap();
        let target_app = root.join("target-app");
        let target_media = root.join("target-media");
        let imported = import_song(&target_app, &target_media, Path::new(&exported.path)).unwrap();
        assert!(Path::new(&imported.path).is_file());
        assert_eq!(imported.song_id, fingerprint);
        let again = import_song(&target_app, &target_media, Path::new(&exported.path)).unwrap();
        assert_eq!(again.status, "already-imported");
        fs::remove_file(
            target_app.join("song-packages/receipts").join(
                receipt_path(
                    &target_app,
                    &target_media,
                    &Path::new(&exported.path).canonicalize().unwrap(),
                )
                .file_name()
                .unwrap(),
            ),
        )
        .unwrap();
        let verified_again =
            import_song(&target_app, &target_media, Path::new(&exported.path)).unwrap();
        assert_eq!(verified_again.status, "imported");
        let jobs = ai_analysis::list(&target_app.join("king-club.sqlite3")).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, "ready");
        assert!(Path::new(&jobs[0].derived_directory)
            .join("no_vocals.flac")
            .is_file());
        assert!(Path::new(&jobs[0].derived_directory)
            .join("reference.json")
            .is_file());
        fs::write(
            Path::new(&jobs[0].derived_directory).join("no_vocals.flac"),
            b"changed derivative",
        )
        .unwrap();
        let changed =
            import_song(&target_app, &target_media, Path::new(&exported.path)).unwrap_err();
        assert!(changed.contains("不一致"));
        let _ = fs::remove_dir_all(&root);
    }
}
