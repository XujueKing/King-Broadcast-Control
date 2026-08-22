use std::{
    collections::hash_map::DefaultHasher,
    collections::HashMap,
    fs::File,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use symphonia::{
    core::{
        audio::SampleBuffer,
        codecs::DecoderOptions,
        errors::Error,
        formats::FormatOptions,
        io::{MediaSourceStream, MediaSourceStreamOptions},
        meta::MetadataOptions,
        probe::Hint,
    },
    default::{get_codecs, get_probe},
};

#[derive(Clone, Default)]
pub struct WaveformCache(Arc<Mutex<HashMap<String, AudioAnalysis>>>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub peaks: Vec<u8>,
    pub bpm: f32,
    pub bpm_confidence: f32,
    pub beats: Vec<f32>,
    pub downbeats: Vec<f32>,
    pub bars: Vec<f32>,
    pub grid_stability: f32,
    #[serde(default)]
    pub duration_seconds: f32,
    #[serde(default)]
    pub correction: Option<RhythmCorrection>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmCorrection {
    pub bpm: f32,
    pub first_downbeat_seconds: f32,
    pub beats_per_bar: u8,
}

const ANALYSIS_VERSION: &str = "v4";

impl WaveformCache {
    fn get(&self, key: &str) -> Option<AudioAnalysis> {
        self.0.lock().ok()?.get(key).cloned()
    }

    fn insert(&self, key: String, analysis: AudioAnalysis) {
        if let Ok(mut values) = self.0.lock() {
            values.insert(key, analysis);
        }
    }
}

fn cache_key(path: &Path, sample_count: usize) -> Result<String, String> {
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    Ok(format!(
        "{}|{}|{}|{}|{}",
        ANALYSIS_VERSION,
        path.to_string_lossy(),
        metadata.len(),
        modified,
        sample_count
    ))
}

fn open_analysis_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS audio_analysis (
               cache_key TEXT PRIMARY KEY,
               media_path TEXT NOT NULL,
               algorithm_version TEXT NOT NULL,
               sample_count INTEGER NOT NULL,
               status TEXT NOT NULL,
               analysis_json BLOB,
               error_message TEXT,
               analyzed_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_audio_analysis_media_path
               ON audio_analysis(media_path);
             CREATE TABLE IF NOT EXISTS rhythm_correction (
               cache_key TEXT PRIMARY KEY,
               bpm REAL NOT NULL,
               first_downbeat_seconds REAL NOT NULL,
               beats_per_bar INTEGER NOT NULL,
               updated_at_unix_ms INTEGER NOT NULL,
               FOREIGN KEY(cache_key) REFERENCES audio_analysis(cache_key) ON DELETE CASCADE
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn current_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn load_database_analysis(
    database_path: &Path,
    key: &str,
    sample_count: usize,
) -> Result<Option<AudioAnalysis>, String> {
    let connection = open_analysis_database(database_path)?;
    let bytes = connection
        .query_row(
            "SELECT analysis_json FROM audio_analysis
             WHERE cache_key = ?1 AND status = 'ready' AND algorithm_version = ?2",
            params![key, ANALYSIS_VERSION],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let mut analysis =
        serde_json::from_slice::<AudioAnalysis>(&bytes).map_err(|error| error.to_string())?;
    let correction = connection
        .query_row(
            "SELECT bpm, first_downbeat_seconds, beats_per_bar
             FROM rhythm_correction WHERE cache_key = ?1",
            params![key],
            |row| {
                Ok(RhythmCorrection {
                    bpm: row.get(0)?,
                    first_downbeat_seconds: row.get(1)?,
                    beats_per_bar: row.get::<_, i64>(2)?.clamp(1, 16) as u8,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(correction) = correction {
        apply_rhythm_correction(&mut analysis, correction);
    }
    Ok((analysis.peaks.len() == sample_count).then_some(analysis))
}

fn apply_rhythm_correction(analysis: &mut AudioAnalysis, correction: RhythmCorrection) {
    let bpm = correction.bpm.clamp(30.0, 300.0);
    let beat_interval = 60.0 / bpm;
    let beats_per_bar = correction.beats_per_bar.clamp(1, 16) as usize;
    let duration = if analysis.duration_seconds > 0.0 {
        analysis.duration_seconds
    } else {
        analysis.beats.last().copied().unwrap_or_default() + beat_interval
    };
    let mut first = correction.first_downbeat_seconds.max(0.0);
    while first - beat_interval * beats_per_bar as f32 >= 0.0 {
        first -= beat_interval * beats_per_bar as f32;
    }
    let mut beats = Vec::new();
    let mut time = first;
    while time <= duration + 0.001 {
        beats.push(time);
        time += beat_interval;
    }
    let downbeats = beats
        .iter()
        .step_by(beats_per_bar)
        .copied()
        .collect::<Vec<_>>();
    analysis.bpm = bpm;
    analysis.bpm_confidence = 1.0;
    analysis.grid_stability = 1.0;
    analysis.beats = beats;
    analysis.downbeats = downbeats.clone();
    analysis.bars = downbeats;
    analysis.correction = Some(RhythmCorrection { bpm, ..correction });
}

pub fn save_rhythm_correction(
    cache: WaveformCache,
    path: PathBuf,
    sample_count: usize,
    database_path: PathBuf,
    correction: RhythmCorrection,
) -> Result<AudioAnalysis, String> {
    let sample_count = sample_count.clamp(256, 65536);
    let key = cache_key(&path, sample_count)?;
    let connection = open_analysis_database(&database_path)?;
    connection
        .execute(
            "INSERT INTO rhythm_correction (
               cache_key, bpm, first_downbeat_seconds, beats_per_bar, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(cache_key) DO UPDATE SET
               bpm=excluded.bpm,
               first_downbeat_seconds=excluded.first_downbeat_seconds,
               beats_per_bar=excluded.beats_per_bar,
               updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![
                key,
                correction.bpm.clamp(30.0, 300.0),
                correction.first_downbeat_seconds.max(0.0),
                correction.beats_per_bar.clamp(1, 16) as i64,
                current_unix_ms(),
            ],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    let analysis = load_database_analysis(&database_path, &key, sample_count)?
        .ok_or_else(|| "歌曲尚未完成波形与节拍分析".to_string())?;
    cache.insert(key, analysis.clone());
    Ok(analysis)
}

fn save_database_analysis(
    database_path: &Path,
    key: &str,
    media_path: &Path,
    sample_count: usize,
    analysis: &AudioAnalysis,
) -> Result<(), String> {
    let connection = open_analysis_database(database_path)?;
    let encoded = serde_json::to_vec(analysis).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO audio_analysis (
               cache_key, media_path, algorithm_version, sample_count, status,
               analysis_json, error_message, analyzed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, 'ready', ?5, NULL, ?6)
             ON CONFLICT(cache_key) DO UPDATE SET
               media_path=excluded.media_path,
               algorithm_version=excluded.algorithm_version,
               sample_count=excluded.sample_count,
               status='ready',
               analysis_json=excluded.analysis_json,
               error_message=NULL,
               analyzed_at_unix_ms=excluded.analyzed_at_unix_ms",
            params![
                key,
                media_path.to_string_lossy(),
                ANALYSIS_VERSION,
                sample_count as i64,
                encoded,
                current_unix_ms(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn save_database_failure(
    database_path: &Path,
    key: &str,
    media_path: &Path,
    sample_count: usize,
    message: &str,
) -> Result<(), String> {
    let connection = open_analysis_database(database_path)?;
    connection
        .execute(
            "INSERT INTO audio_analysis (
               cache_key, media_path, algorithm_version, sample_count, status,
               analysis_json, error_message, analyzed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, 'failed', NULL, ?5, ?6)
             ON CONFLICT(cache_key) DO UPDATE SET
               status='failed', analysis_json=NULL, error_message=excluded.error_message,
               analyzed_at_unix_ms=excluded.analyzed_at_unix_ms",
            params![
                key,
                media_path.to_string_lossy(),
                ANALYSIS_VERSION,
                sample_count as i64,
                message,
                current_unix_ms(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn resample_peaks(source: &[f32], sample_count: usize) -> Vec<u8> {
    if source.is_empty() {
        return vec![0; sample_count];
    }
    let levels: Vec<f32> = (0..sample_count)
        .map(|index| {
            let start = index * source.len() / sample_count;
            let end = ((index + 1) * source.len() / sample_count)
                .max(start + 1)
                .min(source.len());
            let window = &source[start..end];
            let average = window.iter().copied().sum::<f32>() / window.len() as f32;
            let transient = window.iter().copied().fold(0.0_f32, f32::max);
            (average * 0.82 + transient * 0.18).clamp(0.0, 1.0)
        })
        .collect();
    let mut sorted = levels.clone();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let percentile = |ratio: f32| {
        let index = ((sorted.len().saturating_sub(1)) as f32 * ratio).round() as usize;
        sorted[index.min(sorted.len().saturating_sub(1))]
    };
    let noise_floor = percentile(0.03) * 0.65;
    let reference = percentile(0.985).max(noise_floor + 0.025);
    levels
        .into_iter()
        .map(|level| {
            let normalized = ((level - noise_floor) / (reference - noise_floor)).clamp(0.0, 1.0);
            (normalized.powf(0.86) * 100.0).round() as u8
        })
        .collect()
}

fn decode_audio_analysis(path: &Path, sample_count: usize) -> Result<AudioAnalysis, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let stream = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "音频文件中没有可解码音轨".to_string())?;
    let track_id = track.id;
    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| error.to_string())?;

    const FRAMES_PER_PEAK: usize = 512;
    let mut block_peaks = Vec::new();
    let mut block_peak = 0.0_f32;
    let mut block_square_sum = 0.0_f32;
    let mut block_frames = 0_usize;
    let mut rhythm_samples = Vec::new();
    let mut rhythm_accumulator = 0.0_f32;
    let mut rhythm_accumulator_count = 0_usize;
    let mut rhythm_factor = 1_usize;
    let mut sample_rate = 0_u32;
    let mut total_frames = 0_usize;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(_)) => break,
            Err(error) => return Err(error.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(Error::DecodeError(_)) => continue,
            Err(Error::IoError(_)) => break,
            Err(error) => return Err(error.to_string()),
        };
        let specification = *decoded.spec();
        if sample_rate == 0 {
            sample_rate = specification.rate;
            rhythm_factor = (sample_rate / 8_000).max(1) as usize;
        }
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, specification);
        samples.copy_interleaved_ref(decoded);
        let channels = specification.channels.count().max(1);
        for frame in samples.samples().chunks(channels) {
            let mono = frame.iter().copied().sum::<f32>() / channels as f32;
            rhythm_accumulator += mono;
            rhythm_accumulator_count += 1;
            if rhythm_accumulator_count == rhythm_factor {
                rhythm_samples.push(rhythm_accumulator / rhythm_accumulator_count as f32);
                rhythm_accumulator = 0.0;
                rhythm_accumulator_count = 0;
            }
            let peak = frame
                .iter()
                .map(|sample| sample.abs())
                .fold(0.0_f32, f32::max);
            block_peak = block_peak.max(peak);
            block_square_sum +=
                frame.iter().map(|sample| sample * sample).sum::<f32>() / channels as f32;
            block_frames += 1;
            total_frames += 1;
            if block_frames == FRAMES_PER_PEAK {
                let rms = (block_square_sum / block_frames as f32).sqrt();
                block_peaks.push((rms * 0.84 + block_peak * 0.16).clamp(0.0, 1.0));
                block_peak = 0.0;
                block_square_sum = 0.0;
                block_frames = 0;
            }
        }
    }
    if block_frames > 0 {
        let rms = (block_square_sum / block_frames as f32).sqrt();
        block_peaks.push((rms * 0.84 + block_peak * 0.16).clamp(0.0, 1.0));
    }
    if rhythm_accumulator_count > 0 {
        rhythm_samples.push(rhythm_accumulator / rhythm_accumulator_count as f32);
    }
    let peaks = resample_peaks(&block_peaks, sample_count);
    let rhythm = if sample_rate > 0 && !rhythm_samples.is_empty() {
        let rhythm_sample_rate = sample_rate / rhythm_factor as u32;
        let mut rhythm_config = stratum_dsp::AnalysisConfig::default();
        // Beat/Bar 时间必须与 mpv 的原文件 time-pos 共用绝对时间轴，不能裁掉片头静音。
        rhythm_config.enable_silence_trimming = false;
        stratum_dsp::analyze_audio(&rhythm_samples, rhythm_sample_rate, rhythm_config).ok()
    } else {
        None
    };
    let beats = rhythm
        .as_ref()
        .map(|value| value.beat_grid.beats.clone())
        .unwrap_or_default();
    let detected_downbeats = rhythm
        .as_ref()
        .map(|value| value.beat_grid.downbeats.clone())
        .unwrap_or_default();
    // 部分曲目只能稳定识别 Beat 而无法可靠判定第一拍相位；此时按常见 4/4
    // 网格生成可编辑的小节候选，避免整首歌只有一两个小节标记。
    let downbeats = if detected_downbeats.len().saturating_mul(12) >= beats.len() {
        detected_downbeats
    } else {
        beats.iter().step_by(4).copied().collect()
    };
    Ok(AudioAnalysis {
        peaks,
        bpm: rhythm.as_ref().map(|value| value.bpm).unwrap_or_default(),
        bpm_confidence: rhythm
            .as_ref()
            .map(|value| value.bpm_confidence)
            .unwrap_or_default(),
        beats,
        bars: downbeats.clone(),
        downbeats,
        grid_stability: rhythm
            .as_ref()
            .map(|value| value.grid_stability)
            .unwrap_or_default(),
        duration_seconds: if sample_rate > 0 {
            total_frames as f32 / sample_rate as f32
        } else {
            0.0
        },
        correction: None,
    })
}

pub async fn analyze(
    cache: WaveformCache,
    path: PathBuf,
    sample_count: usize,
    cache_directory: PathBuf,
    database_path: PathBuf,
) -> Result<AudioAnalysis, String> {
    let sample_count = sample_count.clamp(256, 65536);
    let key = cache_key(&path, sample_count)?;
    if let Some(analysis) = cache.get(&key) {
        return Ok(analysis);
    }
    if let Some(analysis) = load_database_analysis(&database_path, &key, sample_count)? {
        cache.insert(key, analysis.clone());
        return Ok(analysis);
    }
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    let disk_path = cache_directory.join(format!("{:016x}.json", hasher.finish()));
    if let Ok(bytes) = std::fs::read(&disk_path) {
        if let Ok(analysis) = serde_json::from_slice::<AudioAnalysis>(&bytes) {
            if analysis.peaks.len() == sample_count {
                save_database_analysis(&database_path, &key, &path, sample_count, &analysis)?;
                cache.insert(key, analysis.clone());
                return Ok(analysis);
            }
        }
    }
    let decode_path = path.clone();
    let analysis_result =
        tauri::async_runtime::spawn_blocking(move || decode_audio_analysis(&path, sample_count))
            .await
            .map_err(|error| error.to_string())?;
    let analysis = match analysis_result {
        Ok(analysis) => analysis,
        Err(error) => {
            let _ = save_database_failure(&database_path, &key, &decode_path, sample_count, &error);
            return Err(error);
        }
    };
    save_database_analysis(&database_path, &key, &decode_path, sample_count, &analysis)?;
    cache.insert(key, analysis.clone());
    std::fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;
    let temporary_path = disk_path.with_extension(format!("{}.tmp", std::process::id()));
    let encoded = serde_json::to_vec(&analysis).map_err(|error| error.to_string())?;
    std::fs::write(&temporary_path, encoded).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_path, &disk_path).map_err(|error| error.to_string())?;
    Ok(analysis)
}
