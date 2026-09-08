use flate2::read::ZlibDecoder;
use serde::Serialize;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const KGM_MAGIC: [u8; 28] = [
    0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b, 0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14,
    0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
];
const ENCRYPTED_EXTENSIONS: [&str; 3] = ["kgm", "kgma", "vpr"];
const PLAYABLE_EXTENSIONS: [&str; 7] = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];
const KRC_MAGIC: &[u8; 4] = b"krc1";
const KRC_XOR_KEY: [u8; 16] = [
    64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
];

pub(crate) fn is_encrypted_import_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".king-imported")
    })
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportStatus {
    pub state: String,
    pub detected: usize,
    pub ready: usize,
    pub failed: usize,
    pub decoder_available: bool,
    pub message: String,
}

#[derive(Default)]
pub struct AudioImporter(Mutex<()>);

impl AudioImporter {
    pub fn prepare(&self, audio_root: &Path) -> AudioImportStatus {
        let _guard = match self.0.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return AudioImportStatus {
                    state: "error".into(),
                    message: "KGMA 导入器状态锁已损坏".into(),
                    ..Default::default()
                }
            }
        };
        let mut status = prepare_encrypted_audio(audio_root);
        let lyrics = sync_playable_lyrics(audio_root);
        if lyrics.synced > 0 || lyrics.ambiguous > 0 || lyrics.failed > 0 {
            let lyric_message = format!(
                "酷狗歌词：新增 {} 首、待确认 {} 首、失败 {} 首",
                lyrics.synced, lyrics.ambiguous, lyrics.failed
            );
            if status.message.is_empty() {
                status.message = lyric_message;
            } else {
                status.message.push_str("；");
                status.message.push_str(&lyric_message);
            }
        }
        status
    }
}

fn is_encrypted_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            let extension = extension.to_ascii_lowercase();
            ENCRYPTED_EXTENSIONS.contains(&extension.as_str())
        })
}

fn is_playable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            let extension = extension.to_ascii_lowercase();
            PLAYABLE_EXTENSIONS.contains(&extension.as_str())
        })
}

fn has_kgm_header(path: &Path) -> bool {
    let mut header = [0_u8; KGM_MAGIC.len()];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && header == KGM_MAGIC
}

fn collect_encrypted_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if path
                .file_name()
                .is_some_and(|name| name == ".king-imported")
            {
                continue;
            }
            collect_encrypted_files(&path, files)?;
        } else if path.is_file() && is_encrypted_extension(&path) && has_kgm_header(&path) {
            files.push(path);
        }
    }
    Ok(())
}

fn decoder_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("KING_KGM_DECODER_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("kgm-decoder.exe"));
            candidates.push(directory.join("resources").join("kgm-decoder.exe"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".local-tools")
            .join("kgm-decoder")
            .join("kgm-decoder.exe"),
    );
    candidates
}

fn find_decoder() -> Option<PathBuf> {
    decoder_candidates().into_iter().find(|path| path.is_file())
}

fn source_cache_id(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    hasher.update(canonical.to_string_lossy().to_lowercase().as_bytes());
    hasher.update(&metadata.len().to_le_bytes());
    hasher.update(&modified.to_le_bytes());
    Ok(hasher.finalize().to_hex()[..20].to_string())
}

fn source_path_id(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    hasher.update(canonical.to_string_lossy().to_lowercase().as_bytes());
    hasher.finalize().to_hex()[..20].to_string()
}

fn imported_directory(audio_root: &Path, source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "KGMA 文件缺少父目录".to_string())?;
    let relative_parent = parent
        .strip_prefix(audio_root)
        .map_err(|_| format!("KGMA 文件不在曲库目录内：{}", source.to_string_lossy()))?;
    Ok(audio_root.join(".king-imported").join(relative_parent))
}

fn import_state_path(audio_root: &Path, source: &Path) -> PathBuf {
    audio_root
        .join(".king-imported")
        .join(".state")
        .join(format!("{}.txt", source_path_id(source)))
}

fn sniff_audio_extension(path: &Path) -> Result<&'static str, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 64];
    let length = file.read(&mut header).map_err(|error| error.to_string())?;
    let header = &header[..length];
    if header.starts_with(b"fLaC") {
        return Ok("flac");
    }
    if header.starts_with(b"OggS") {
        return Ok("ogg");
    }
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WAVE" {
        return Ok("wav");
    }
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        return Ok("m4a");
    }
    if header.starts_with(b"ID3")
        || header.len() >= 2 && header[0] == 0xff && header[1] & 0xe0 == 0xe0
    {
        return Ok(if header.len() >= 2 && header[1] & 0xf6 == 0xf0 {
            "aac"
        } else {
            "mp3"
        });
    }
    Err("解码产物不是受支持的 MP3/FLAC/WAV/M4A/AAC/OGG 音频".into())
}

fn existing_decoded_audio(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && is_playable_extension(path)
                && fs::metadata(path).is_ok_and(|metadata| metadata.len() > 128)
                && sniff_audio_extension(path).is_ok()
        })
}

fn existing_imported_audio(directory: &Path, source_stem: &OsStr) -> Option<PathBuf> {
    PLAYABLE_EXTENSIONS
        .iter()
        .map(|extension| directory.join(source_stem).with_extension(extension))
        .find(|path| {
            path.is_file()
                && fs::metadata(path).is_ok_and(|metadata| metadata.len() > 128)
                && sniff_audio_extension(path).is_ok()
        })
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_kugou_lyrics_suffix(value: &str) -> bool {
    let parts = value.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && is_hex(parts[0], 32)
        && !parts[1].is_empty()
        && parts[1].bytes().all(|byte| byte.is_ascii_digit())
        && is_hex(parts[2], 8)
}

fn strip_kugou_lyrics_suffix(value: &str) -> &str {
    let Some((before_zero, zero)) = value.rsplit_once('-') else {
        return value;
    };
    let Some((before_id, id)) = before_zero.rsplit_once('-') else {
        return value;
    };
    let Some((display, hash)) = before_id.rsplit_once('-') else {
        return value;
    };
    if is_kugou_lyrics_suffix(&format!("{hash}-{id}-{zero}")) {
        display
    } else {
        value
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LyricsIdentity {
    artist: Option<String>,
    title: String,
    full: String,
}

fn normalize_lyrics_component(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn lyrics_identity(value: &str) -> LyricsIdentity {
    let display = strip_kugou_lyrics_suffix(value).trim();
    let (artist, title) = display
        .split_once(" - ")
        .map(|(artist, title)| (Some(artist.trim()), title.trim()))
        .unwrap_or((None, display));
    LyricsIdentity {
        artist: artist
            .map(normalize_lyrics_component)
            .filter(|value| !value.is_empty()),
        title: normalize_lyrics_component(title),
        full: normalize_lyrics_component(display),
    }
}

fn artist_parts(value: &str) -> Vec<String> {
    value
        .split(['、', ',', '，', '&', '＆', '/', ';', '；'])
        .map(normalize_lyrics_component)
        .filter(|part| !part.is_empty())
        .collect()
}

fn artists_overlap(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left = artist_parts(left);
    let right = artist_parts(right);
    left.iter().any(|part| right.contains(part))
}

fn lyrics_match_score(source_stem: &str, candidate: &Path) -> Option<usize> {
    let candidate_stem = candidate.file_stem()?.to_string_lossy();
    if candidate_stem.eq_ignore_ascii_case(source_stem) {
        return Some(0);
    }
    let suffix = candidate_stem.get(source_stem.len()..)?.strip_prefix('-')?;
    if candidate_stem[..source_stem.len()].eq_ignore_ascii_case(source_stem)
        && is_kugou_lyrics_suffix(suffix)
    {
        return Some(1);
    }
    None
}

fn fuzzy_lyrics_match_score(source_stem: &str, candidate: &Path) -> Option<usize> {
    if let Some(score) = lyrics_match_score(source_stem, candidate) {
        return Some(score);
    }
    let candidate_stem = candidate.file_stem()?.to_string_lossy();
    let source = lyrics_identity(source_stem);
    let candidate = lyrics_identity(&candidate_stem);
    if source.title.is_empty() || candidate.title.is_empty() {
        return None;
    }
    if source.full == candidate.full {
        return Some(10);
    }
    if source.title != candidate.title {
        return None;
    }
    match (&source.artist, &candidate.artist) {
        (Some(source_artist), Some(candidate_artist))
            if artists_overlap(source_artist, candidate_artist) =>
        {
            Some(20)
        }
        (None, Some(_)) | (None, None) => Some(30),
        (Some(_), None) => Some(35),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LyricsMatch {
    Found(PathBuf),
    Ambiguous,
    Missing,
}

fn lyrics_extension_priority(path: &Path) -> usize {
    if path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lrc"))
    {
        0
    } else {
        1
    }
}

fn select_lyrics_candidate(
    source: &Path,
    candidates: impl IntoIterator<Item = PathBuf>,
) -> LyricsMatch {
    let Some(source_stem) = source.file_stem().map(|value| value.to_string_lossy()) else {
        return LyricsMatch::Missing;
    };
    let mut scored = candidates
        .into_iter()
        .filter(|path| path.is_file())
        .filter_map(|path| fuzzy_lyrics_match_score(&source_stem, &path).map(|score| (score, path)))
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| {
                lyrics_extension_priority(&left.1).cmp(&lyrics_extension_priority(&right.1))
            })
            .then_with(|| left.1.cmp(&right.1))
    });
    let Some((best_score, best_path)) = scored.first() else {
        return LyricsMatch::Missing;
    };
    let best_identity = best_path
        .file_stem()
        .map(|value| lyrics_identity(&value.to_string_lossy()));
    let conflicts = scored
        .iter()
        .take_while(|(score, _)| score == best_score)
        .filter_map(|(_, path)| {
            path.file_stem()
                .map(|value| lyrics_identity(&value.to_string_lossy()))
        })
        .any(|identity| best_identity.as_ref().is_some_and(|best| identity != *best));
    if conflicts {
        LyricsMatch::Ambiguous
    } else {
        LyricsMatch::Found(best_path.clone())
    }
}

fn find_lyrics_sidecar(source: &Path) -> Option<PathBuf> {
    let candidates = fs::read_dir(source.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("lrc") || extension.eq_ignore_ascii_case("krc")
                })
        })
        .collect::<Vec<_>>();
    match select_lyrics_candidate(source, candidates) {
        LyricsMatch::Found(path) => Some(path),
        LyricsMatch::Ambiguous | LyricsMatch::Missing => None,
    }
}

fn decode_text_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes[3..].to_vec()).map_err(|error| error.to_string());
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).map_err(|error| error.to_string());
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).map_err(|error| error.to_string());
    }
    if let Ok(value) = String::from_utf8(bytes.to_vec()) {
        return Ok(value);
    }
    let (value, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        Err("歌词既不是 UTF-8/UTF-16，也不能按 GBK 解码".into())
    } else {
        Ok(value.into_owned())
    }
}

fn parse_kugou_lyrics_path(contents: &str) -> Option<PathBuf> {
    contents.lines().find_map(|line| {
        let (key, value) = line.trim().trim_start_matches('\u{feff}').split_once('=')?;
        if key.trim().eq_ignore_ascii_case("LyricPath") {
            let value = value.trim().trim_matches('"');
            (!value.is_empty()).then(|| PathBuf::from(value))
        } else {
            None
        }
    })
}

fn kugou_lyrics_directory() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KING_KUGOU_LYRIC_PATH") {
        let path = PathBuf::from(path);
        return path.is_dir().then_some(path);
    }
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from)?;
    let ini = app_data.join("KuGou8").join("KuGou.ini");
    let contents = decode_text_bytes(&fs::read(ini).ok()?).ok()?;
    let path = parse_kugou_lyrics_path(&contents)?;
    path.is_dir().then_some(path)
}

fn collect_lyrics_files(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(OsStr::to_str)
                    .is_some_and(|extension| {
                        extension.eq_ignore_ascii_case("lrc")
                            || extension.eq_ignore_ascii_case("krc")
                    })
        })
        .collect()
}

fn collect_playable_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_playable_files(&path, files)?;
        } else if path.is_file() && is_playable_extension(&path) {
            files.push(path);
        }
    }
    Ok(())
}

#[derive(Default)]
struct LyricsSyncSummary {
    synced: usize,
    ambiguous: usize,
    failed: usize,
}

fn sync_playable_lyrics(audio_root: &Path) -> LyricsSyncSummary {
    let kugou_directory = kugou_lyrics_directory();
    sync_playable_lyrics_with_cache(audio_root, kugou_directory.as_deref())
}

fn sync_playable_lyrics_with_cache(
    audio_root: &Path,
    kugou_directory: Option<&Path>,
) -> LyricsSyncSummary {
    let mut summary = LyricsSyncSummary::default();
    let mut audio_files = Vec::new();
    if collect_playable_files(audio_root, &mut audio_files).is_err() {
        summary.failed += 1;
        return summary;
    }
    let kugou_candidates = kugou_directory
        .map(collect_lyrics_files)
        .unwrap_or_default();
    for audio in audio_files {
        if audio.with_extension("lrc").is_file() {
            continue;
        }
        let mut candidates = audio.parent().map(collect_lyrics_files).unwrap_or_default();
        candidates.extend(kugou_candidates.iter().cloned());
        match select_lyrics_candidate(&audio, candidates) {
            LyricsMatch::Found(source) => {
                match install_lyrics_file(&source, &audio.with_extension("lrc")) {
                    Ok(true) => summary.synced += 1,
                    Ok(false) => {}
                    Err(_) => summary.failed += 1,
                }
            }
            LyricsMatch::Ambiguous => summary.ambiguous += 1,
            LyricsMatch::Missing => {}
        }
    }
    summary
}

fn strip_krc_word_timing(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' if inside_tag => inside_tag = false,
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }
    result
}

fn format_lrc_timestamp(milliseconds: u64) -> String {
    let minutes = milliseconds / 60_000;
    let seconds = (milliseconds % 60_000) / 1_000;
    let hundredths = (milliseconds % 1_000) / 10;
    format!("[{minutes:02}:{seconds:02}.{hundredths:02}]")
}

fn decode_krc_bytes(bytes: &[u8]) -> Result<String, String> {
    const MAX_KRC_BYTES: usize = 2 * 1024 * 1024;
    if bytes.len() < KRC_MAGIC.len() || &bytes[..KRC_MAGIC.len()] != KRC_MAGIC {
        return Err("KRC 文件头无效".into());
    }
    if bytes.len() > MAX_KRC_BYTES {
        return Err("KRC 歌词超过 2 MB 安全限制".into());
    }
    let mut compressed = bytes[KRC_MAGIC.len()..].to_vec();
    for (index, byte) in compressed.iter_mut().enumerate() {
        *byte ^= KRC_XOR_KEY[index % KRC_XOR_KEY.len()];
    }
    let mut decoder = ZlibDecoder::new(compressed.as_slice());
    let mut decoded = String::new();
    decoder
        .read_to_string(&mut decoded)
        .map_err(|error| format!("KRC 解压失败：{error}"))?;

    let mut lrc = String::new();
    for raw_line in decoded.lines() {
        let line = raw_line.trim_end_matches('\r');
        let Some((header, body)) = line.strip_prefix('[').and_then(|line| line.split_once(']'))
        else {
            continue;
        };
        if let Some((start, _duration)) = header.split_once(',') {
            let start = start
                .parse::<u64>()
                .map_err(|_| format!("KRC 行时间无效：{header}"))?;
            let text = strip_krc_word_timing(body);
            if !text.is_empty() {
                lrc.push_str(&format_lrc_timestamp(start));
                lrc.push_str(&text);
                lrc.push_str("\r\n");
            }
        } else if ["ar:", "ti:", "al:", "by:", "offset:"]
            .iter()
            .any(|prefix| header.starts_with(prefix))
        {
            lrc.push('[');
            lrc.push_str(header);
            lrc.push_str("]\r\n");
        }
    }
    if lrc.is_empty() {
        return Err("KRC 中没有可转换的歌词行".into());
    }
    Ok(lrc)
}

fn install_lyrics_file(source_lyrics: &Path, destination: &Path) -> Result<bool, String> {
    if destination.is_file() {
        return Ok(false);
    }
    if source_lyrics
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("krc"))
    {
        let bytes = fs::read(&source_lyrics).map_err(|error| format!("读取 KRC 失败：{error}"))?;
        let lrc = decode_krc_bytes(&bytes)?;
        fs::write(&destination, lrc.as_bytes())
            .map_err(|error| format!("写入同名 LRC 失败：{error}"))?;
    } else {
        let bytes = fs::read(source_lyrics).map_err(|error| format!("读取 LRC 失败：{error}"))?;
        let lrc = decode_text_bytes(&bytes).map_err(|error| format!("解码 LRC 失败：{error}"))?;
        fs::write(destination, lrc.as_bytes())
            .map_err(|error| format!("写入同名 LRC 失败：{error}"))?;
    }
    Ok(true)
}

fn sync_lyrics_sidecar(source: &Path, decoded: &Path) -> Result<(), String> {
    let destination = decoded.with_extension("lrc");
    if destination.is_file() {
        return Ok(());
    }
    let Some(source_lyrics) = find_lyrics_sidecar(source) else {
        return Ok(());
    };
    install_lyrics_file(&source_lyrics, &destination)?;
    Ok(())
}

fn install_decoded_audio(
    decoded: &Path,
    destination_directory: &Path,
    source_stem: &OsStr,
) -> Result<PathBuf, String> {
    let actual_extension = sniff_audio_extension(decoded)?;
    fs::create_dir_all(destination_directory).map_err(|error| error.to_string())?;
    let destination = destination_directory
        .join(source_stem)
        .with_extension(actual_extension);
    let temporary = destination.with_extension(format!("{actual_extension}.tmp"));
    let _ = fs::remove_file(&temporary);
    fs::copy(decoded, &temporary).map_err(|error| format!("保存解码音频失败：{error}"))?;
    for extension in PLAYABLE_EXTENSIONS {
        let stale = destination_directory
            .join(source_stem)
            .with_extension(extension);
        if stale != destination {
            let _ = fs::remove_file(stale);
        }
    }
    if destination.is_file() {
        fs::remove_file(&destination).map_err(|error| format!("替换旧解码音频失败：{error}"))?;
    }
    fs::rename(&temporary, &destination).map_err(|error| format!("提交解码音频失败：{error}"))?;
    Ok(destination)
}

fn write_import_state(audio_root: &Path, source: &Path, version: &str) -> Result<(), String> {
    let state_path = import_state_path(audio_root, source);
    let state_directory = state_path
        .parent()
        .ok_or_else(|| "KGMA 状态目录无效".to_string())?;
    fs::create_dir_all(state_directory).map_err(|error| error.to_string())?;
    fs::write(state_path, version.as_bytes()).map_err(|error| error.to_string())
}

fn cleanup_legacy_cache(source: &Path, cache_id: &str) {
    let Some(parent) = source.parent() else {
        return;
    };
    let legacy_root = parent.join(".king-imported");
    let legacy_directory = legacy_root.join(cache_id);
    let _ = fs::remove_dir_all(legacy_directory);
    if fs::read_dir(&legacy_root).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = fs::remove_dir(legacy_root);
    }
}

fn decode_one(decoder: &Path, audio_root: &Path, source: &Path) -> Result<PathBuf, String> {
    let cache_id = source_cache_id(source)?;
    let source_stem = source
        .file_stem()
        .ok_or_else(|| "KGMA 文件名无效".to_string())?;
    let destination_directory = imported_directory(audio_root, source)?;
    let state_matches = fs::read_to_string(import_state_path(audio_root, source))
        .is_ok_and(|value| value == cache_id);
    if state_matches {
        if let Some(existing) = existing_imported_audio(&destination_directory, source_stem) {
            sync_lyrics_sidecar(source, &existing)?;
            cleanup_legacy_cache(source, &cache_id);
            return Ok(existing);
        }
    }

    let legacy_directory = source
        .parent()
        .ok_or_else(|| "KGMA 文件缺少父目录".to_string())?
        .join(".king-imported")
        .join(&cache_id);
    if let Some(existing) = existing_decoded_audio(&legacy_directory) {
        let imported = install_decoded_audio(&existing, &destination_directory, source_stem)?;
        sync_lyrics_sidecar(source, &imported)?;
        write_import_state(audio_root, source, &cache_id)?;
        cleanup_legacy_cache(source, &cache_id);
        return Ok(imported);
    }

    let work_directory = std::env::temp_dir().join(format!(
        "king-kgma-import-{}-{cache_id}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&work_directory);
    fs::create_dir_all(&work_directory).map_err(|error| error.to_string())?;
    let result = (|| {
        let source_name = source
            .file_name()
            .ok_or_else(|| "KGMA 文件名无效".to_string())?;
        let staged_source = work_directory.join(source_name);
        fs::copy(source, &staged_source)
            .map_err(|error| format!("复制 KGMA 到临时导入目录失败：{error}"))?;

        let mut command = Command::new(decoder);
        command
            .arg("--keep-file")
            .arg(&staged_source)
            .current_dir(&work_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let result = command
            .output()
            .map_err(|error| format!("无法启动 KGMA 解码器：{error}"))?;
        if !result.status.success() {
            return Err(format!(
                "KGMA 解码器退出码 {}：{}",
                result.status,
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        let decoded = existing_decoded_audio(&work_directory).ok_or_else(|| {
            format!(
                "KGMA 解码器未生成音频：{}",
                String::from_utf8_lossy(&result.stdout).trim()
            )
        })?;
        let imported = install_decoded_audio(&decoded, &destination_directory, source_stem)?;
        sync_lyrics_sidecar(source, &imported)?;
        write_import_state(audio_root, source, &cache_id)?;
        Ok(imported)
    })();
    let _ = fs::remove_dir_all(&work_directory);
    if result.is_ok() {
        cleanup_legacy_cache(source, &cache_id);
    }
    result
}

fn prepare_encrypted_audio(audio_root: &Path) -> AudioImportStatus {
    let mut sources = Vec::new();
    if let Err(error) = collect_encrypted_files(audio_root, &mut sources) {
        return AudioImportStatus {
            state: "error".into(),
            message: format!("扫描 KGMA 失败：{error}"),
            ..Default::default()
        };
    }
    if sources.is_empty() {
        return AudioImportStatus {
            state: "idle".into(),
            decoder_available: find_decoder().is_some(),
            message: "未发现 KGM/KGMA/VPR".into(),
            ..Default::default()
        };
    }
    let Some(decoder) = find_decoder() else {
        return AudioImportStatus {
            state: "decoder-missing".into(),
            detected: sources.len(),
            failed: sources.len(),
            decoder_available: false,
            message: format!("识别到 {} 首 KGMA，但本机未找到已校验解码器", sources.len()),
            ..Default::default()
        };
    };
    let mut ready = 0;
    let mut errors = Vec::new();
    for source in &sources {
        match decode_one(&decoder, audio_root, source) {
            Ok(_) => ready += 1,
            Err(error) => errors.push(format!(
                "{}：{error}",
                source.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }
    let failed = errors.len();
    AudioImportStatus {
        state: if failed == 0 { "ready" } else { "error" }.into(),
        detected: sources.len(),
        ready,
        failed,
        decoder_available: true,
        message: if failed == 0 {
            format!("KGMA 本地导入完成：{ready}/{}", sources.len())
        } else {
            format!(
                "KGMA 导入完成：{ready}/{}；{}",
                sources.len(),
                errors.join("；")
            )
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_real_kgm_header_and_rejects_extension_only_files() {
        let root =
            std::env::temp_dir().join(format!("king-kgma-recognition-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let valid = root.join("valid.KGMA");
        let invalid = root.join("invalid.kgma");
        let mut bytes = KGM_MAGIC.to_vec();
        bytes.resize(1024, 0);
        fs::write(&valid, bytes).unwrap();
        fs::write(&invalid, b"not a kgma file").unwrap();
        let mut files = Vec::new();
        collect_encrypted_files(&root, &mut files).unwrap();
        assert_eq!(files, vec![valid]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recognizes_files_inside_the_managed_encrypted_import_cache() {
        assert!(is_encrypted_import_path(Path::new(
            r"C:\music\酷狗\.king-imported\abc\song.flac"
        )));
        assert!(!is_encrypted_import_path(Path::new(
            r"C:\music\普通歌曲\song.flac"
        )));
    }

    #[test]
    fn detects_real_audio_container_instead_of_trusting_extension() {
        let root = std::env::temp_dir().join(format!("king-kgma-sniff-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let fake_mp3 = root.join("song.mp3");
        fs::write(&fake_mp3, b"fLaC\0\0\0\x22").unwrap();
        assert_eq!(sniff_audio_extension(&fake_mp3).unwrap(), "flac");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uses_one_central_import_root_with_readable_names() {
        let root = std::env::temp_dir().join(format!("king-kgma-layout-{}", std::process::id()));
        let category = root.join("酷狗");
        fs::create_dir_all(&category).unwrap();
        let source = category.join("歌手 - 歌名.kgma");

        assert_eq!(
            imported_directory(&root, &source).unwrap(),
            root.join(".king-imported").join("酷狗")
        );
        assert_eq!(
            imported_directory(&root, &source)
                .unwrap()
                .join(source.file_stem().unwrap())
                .with_extension("flac"),
            root.join(".king-imported")
                .join("酷狗")
                .join("歌手 - 歌名.flac")
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn encode_test_krc(value: &str) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(value.as_bytes()).unwrap();
        let mut compressed = encoder.finish().unwrap();
        for (index, byte) in compressed.iter_mut().enumerate() {
            *byte ^= KRC_XOR_KEY[index % KRC_XOR_KEY.len()];
        }
        let mut result = KRC_MAGIC.to_vec();
        result.extend_from_slice(&compressed);
        result
    }

    #[test]
    fn matches_late_kugou_krc_and_writes_same_name_lrc() {
        let root = std::env::temp_dir().join(format!("king-krc-sidecar-{}", std::process::id()));
        let category = root.join("酷狗");
        let imported = root.join(".king-imported").join("酷狗");
        fs::create_dir_all(&category).unwrap();
        fs::create_dir_all(&imported).unwrap();
        let source = category.join("GGWVP - 这最后一次的分离 发了疯的想你 (DJ版).kgma");
        let decoded = imported.join("GGWVP - 这最后一次的分离 发了疯的想你 (DJ版).flac");
        fs::write(&source, b"source marker").unwrap();
        fs::write(&decoded, b"decoded marker").unwrap();
        let lyrics = category.join(
            "GGWVP - 这最后一次的分离 发了疯的想你 (DJ版)-35037d7e62b38d4e5f8adbde270ac65b-767881186-00000000.krc",
        );
        fs::write(
            &lyrics,
            encode_test_krc("[ar:GGWVP]\r\n[584,4079]<0,544,0>这<544,647,0>最<1191,576,0>后\r\n"),
        )
        .unwrap();

        assert_eq!(find_lyrics_sidecar(&source), Some(lyrics));
        sync_lyrics_sidecar(&source, &decoded).unwrap();
        let lrc = fs::read_to_string(decoded.with_extension("lrc")).unwrap();
        assert!(lrc.contains("[ar:GGWVP]"));
        assert!(lrc.contains("[00:00.58]这最后"));
        assert!(!lrc.contains('<'));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_the_configured_kugou_lyrics_directory() {
        let contents = "[LyricConfigSection]\r\nLockLyrics=0\r\nLyricPath=D:\\KuGou\\Lyric\\\r\n";
        assert_eq!(
            parse_kugou_lyrics_path(contents),
            Some(PathBuf::from(r"D:\KuGou\Lyric\"))
        );
    }

    #[test]
    fn matches_title_only_audio_to_unique_artist_prefixed_kugou_lyrics() {
        let root =
            std::env::temp_dir().join(format!("king-kugou-title-match-{}", std::process::id()));
        let audio_root = root.join("audio");
        let cache = root.join("lyrics");
        fs::create_dir_all(&audio_root).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let audio = audio_root.join("爱如潮水 (Live).flac");
        fs::write(&audio, b"fLaC audio marker").unwrap();
        fs::write(
            cache.join(
                "GAI周延 - 爱如潮水 (Live)-952334ab58bae217283d0157c962323a-146867915-00000000.krc",
            ),
            encode_test_krc("[ar:GAI周延]\r\n[1000,2000]<0,500,0>爱<500,500,0>如潮水\r\n"),
        )
        .unwrap();

        let summary = sync_playable_lyrics_with_cache(&audio_root, Some(&cache));

        assert_eq!(summary.synced, 1);
        assert_eq!(summary.ambiguous, 0);
        assert!(fs::read_to_string(audio.with_extension("lrc"))
            .unwrap()
            .contains("[00:01.00]爱如潮水"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_ambiguous_title_only_lyrics() {
        let root =
            std::env::temp_dir().join(format!("king-kugou-ambiguous-{}", std::process::id()));
        let audio_root = root.join("audio");
        let cache = root.join("lyrics");
        fs::create_dir_all(&audio_root).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let audio = audio_root.join("答案.flac");
        fs::write(&audio, b"fLaC audio marker").unwrap();
        for (artist, hash) in [
            ("歌手甲", "11111111111111111111111111111111"),
            ("歌手乙", "22222222222222222222222222222222"),
        ] {
            fs::write(
                cache.join(format!("{artist} - 答案-{hash}-123456789-00000000.krc")),
                encode_test_krc("[1000,2000]<0,500,0>答<500,500,0>案\r\n"),
            )
            .unwrap();
        }

        let summary = sync_playable_lyrics_with_cache(&audio_root, Some(&cache));

        assert_eq!(summary.synced, 0);
        assert_eq!(summary.ambiguous, 1);
        assert!(!audio.with_extension("lrc").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_overwrites_an_existing_lrc() {
        let root =
            std::env::temp_dir().join(format!("king-kugou-preserve-lrc-{}", std::process::id()));
        let audio_root = root.join("audio");
        let cache = root.join("lyrics");
        fs::create_dir_all(&audio_root).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let audio = audio_root.join("歌手 - 歌名.flac");
        let lrc = audio.with_extension("lrc");
        fs::write(&audio, b"fLaC audio marker").unwrap();
        fs::write(&lrc, "[00:01.00]用户歌词\r\n").unwrap();
        fs::write(
            cache.join("歌手 - 歌名-33333333333333333333333333333333-123456789-00000000.krc"),
            encode_test_krc("[1000,2000]<0,500,0>缓存歌词\r\n"),
        )
        .unwrap();

        let summary = sync_playable_lyrics_with_cache(&audio_root, Some(&cache));

        assert_eq!(summary.synced, 0);
        assert_eq!(fs::read_to_string(&lrc).unwrap(), "[00:01.00]用户歌词\r\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_removes_only_the_current_legacy_hash_directory() {
        let root = std::env::temp_dir().join(format!("king-kgma-legacy-{}", std::process::id()));
        let category = root.join("酷狗");
        fs::create_dir_all(&category).unwrap();
        let source = category.join("song.kgma");
        let mut bytes = KGM_MAGIC.to_vec();
        bytes.resize(1024, 0);
        fs::write(&source, bytes).unwrap();
        let expected = category
            .join(".king-imported")
            .join(source_cache_id(&source).unwrap());
        let stale = category.join(".king-imported").join("stale-version");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(&stale).unwrap();

        cleanup_legacy_cache(&source, &source_cache_id(&source).unwrap());

        assert!(!expected.exists());
        assert!(stale.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn converted_audio_survives_after_the_user_removes_the_source() {
        let root = std::env::temp_dir().join(format!("king-kgma-retain-{}", std::process::id()));
        let imported = root.join(".king-imported").join("酷狗");
        fs::create_dir_all(&imported).unwrap();
        let converted = imported.join("歌手 - 歌名.flac");
        fs::write(&converted, b"fLaC converted playback asset").unwrap();

        let status = prepare_encrypted_audio(&root);

        assert_eq!(status.state, "idle");
        assert!(converted.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_configured_real_kgma_fixture_without_modifying_the_source() {
        let Some(root) = std::env::var_os("KING_KGMA_FIXTURE_ROOT").map(PathBuf::from) else {
            return;
        };
        let mut sources = Vec::new();
        collect_encrypted_files(&root, &mut sources).unwrap();
        assert!(
            !sources.is_empty(),
            "configured fixture root contains no KGMA"
        );
        let source_hashes = sources
            .iter()
            .map(|source| (source.clone(), blake3::hash(&fs::read(source).unwrap())))
            .collect::<Vec<_>>();

        let status = AudioImporter::default().prepare(&root);
        assert_eq!(status.state, "ready", "{}", status.message);
        assert_eq!(status.detected, sources.len());
        assert_eq!(status.ready, sources.len());
        assert_eq!(status.failed, 0);
        for (source, expected_hash) in source_hashes {
            assert_eq!(blake3::hash(&fs::read(source).unwrap()), expected_hash);
        }
    }
}
