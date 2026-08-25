use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use lofty::{file::AudioFile, probe::Probe};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const PIPELINE_VERSION: &str = "king-audio-ai-moss-v6";
pub const SEPARATOR_MODEL: &str = "model_bs_roformer_ep_317_sdr_12.9755.ckpt";
pub const ASR_MODEL: &str = "OpenMOSS-Team/MOSS-Music-8B-Thinking";
pub const ALIGNER_MODEL: &str = "MOSS-Music native timestamps";
const AUTO_LYRICS_MAX_DURATION: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysisJob {
    pub id: i64,
    pub media_path: String,
    pub media_fingerprint: String,
    pub pipeline_version: String,
    pub status: String,
    pub stage: String,
    pub derived_directory: String,
    pub separator_model: String,
    pub asr_model: String,
    pub aligner_model: String,
    pub attempts: i64,
    pub error_message: Option<String>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug)]
pub struct ReadyAudioArtifacts {
    pub lyrics_path: PathBuf,
    pub words_path: PathBuf,
    pub vocals_path: Option<PathBuf>,
    pub accompaniment_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisManifest<'a> {
    media_path: &'a str,
    media_fingerprint: &'a str,
    pipeline_version: &'a str,
    separator_model: &'a str,
    asr_model: &'a str,
    aligner_model: &'a str,
    status: &'a str,
}

pub(crate) fn current_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub(crate) fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               media_path TEXT NOT NULL,
               media_fingerprint TEXT NOT NULL,
               pipeline_version TEXT NOT NULL,
               status TEXT NOT NULL,
               stage TEXT NOT NULL,
               derived_directory TEXT NOT NULL,
               separator_model TEXT NOT NULL,
               asr_model TEXT NOT NULL,
               aligner_model TEXT NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,
               error_message TEXT,
               created_at_unix_ms INTEGER NOT NULL,
               updated_at_unix_ms INTEGER NOT NULL,
               priority INTEGER NOT NULL DEFAULT 2,
               UNIQUE(media_fingerprint, pipeline_version)
             );
             CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_status
               ON ai_analysis_jobs(status, updated_at_unix_ms);
             CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_media_path
               ON ai_analysis_jobs(media_path);",
        )
        .map_err(|error| error.to_string())?;
    let has_priority = connection
        .prepare("PRAGMA table_info(ai_analysis_jobs)")
        .and_then(|mut statement| {
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(columns
                .filter_map(Result::ok)
                .any(|column| column == "priority"))
        })
        .map_err(|error| error.to_string())?;
    if !has_priority {
        connection
            .execute(
                "ALTER TABLE ai_analysis_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 2",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_scheduler
             ON ai_analysis_jobs(status, priority, created_at_unix_ms, id)",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

// A bounded fingerprint avoids reading an entire multi-hour file on the UI scan path.
// It combines file size with 1 MiB samples from the beginning, middle and end. The
// Python worker will later write the full source checksum into its finished manifest.
pub(crate) fn fingerprint(path: &Path) -> Result<String, String> {
    const CHUNK_SIZE: usize = 1024 * 1024;
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("AI analysis source is not a file".to_string());
    }
    let size = metadata.len();
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());
    let offsets = [
        0,
        size.saturating_sub(CHUNK_SIZE as u64) / 2,
        size.saturating_sub(CHUNK_SIZE as u64),
    ];
    let mut buffer = vec![0_u8; CHUNK_SIZE];
    for offset in offsets {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        hasher.update(&offset.to_le_bytes());
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiAnalysisJob> {
    Ok(AiAnalysisJob {
        id: row.get(0)?,
        media_path: row.get(1)?,
        media_fingerprint: row.get(2)?,
        pipeline_version: row.get(3)?,
        status: row.get(4)?,
        stage: row.get(5)?,
        derived_directory: row.get(6)?,
        separator_model: row.get(7)?,
        asr_model: row.get(8)?,
        aligner_model: row.get(9)?,
        attempts: row.get(10)?,
        error_message: row.get(11)?,
        created_at_unix_ms: row.get(12)?,
        updated_at_unix_ms: row.get(13)?,
    })
}

fn queue_blocking(
    media_path: PathBuf,
    database_path: PathBuf,
    derived_root: PathBuf,
) -> Result<AiAnalysisJob, String> {
    let canonical_path = media_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let fingerprint = fingerprint(&canonical_path)?;
    let derived_directory = derived_root.join(&fingerprint);
    fs::create_dir_all(&derived_directory).map_err(|error| error.to_string())?;
    let media_path_string = canonical_path.to_string_lossy().into_owned();
    let derived_directory_string = derived_directory.to_string_lossy().into_owned();
    let is_long_form = Probe::open(&canonical_path)
        .and_then(|probe| probe.read())
        .map(|tagged| tagged.properties().duration() >= AUTO_LYRICS_MAX_DURATION)
        .unwrap_or(false);
    let (initial_status, initial_stage) = if is_long_form {
        ("skipped", "dj-long-form")
    } else {
        ("queued", "pending")
    };
    let now = current_unix_ms();
    let connection = open_database(&database_path)?;
    connection
        .execute(
            "INSERT INTO ai_analysis_jobs (
               media_path, media_fingerprint, pipeline_version, status, stage,
               derived_directory, separator_model, asr_model, aligner_model,
               attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?10)
             ON CONFLICT(media_fingerprint, pipeline_version) DO UPDATE SET
               media_path=excluded.media_path,
               derived_directory=excluded.derived_directory,
               separator_model=excluded.separator_model,
               asr_model=excluded.asr_model,
               aligner_model=excluded.aligner_model,
               status=CASE
                 WHEN ai_analysis_jobs.status='ready' THEN ai_analysis_jobs.status
                 WHEN excluded.status='skipped' THEN excluded.status
                 ELSE ai_analysis_jobs.status
               END,
               stage=CASE
                 WHEN ai_analysis_jobs.status='ready' THEN ai_analysis_jobs.stage
                 WHEN excluded.status='skipped' THEN excluded.stage
                 ELSE ai_analysis_jobs.stage
               END,
               error_message=CASE
                 WHEN excluded.status='skipped' THEN NULL
                 ELSE ai_analysis_jobs.error_message
               END,
               updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![
                media_path_string,
                fingerprint,
                PIPELINE_VERSION,
                initial_status,
                initial_stage,
                derived_directory_string,
                SEPARATOR_MODEL,
                ASR_MODEL,
                ALIGNER_MODEL,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    let job = connection
        .query_row(
            "SELECT id, media_path, media_fingerprint, pipeline_version, status, stage,
                    derived_directory, separator_model, asr_model, aligner_model,
                    attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             FROM ai_analysis_jobs
             WHERE media_fingerprint = ?1 AND pipeline_version = ?2",
            params![fingerprint, PIPELINE_VERSION],
            row_to_job,
        )
        .map_err(|error| error.to_string())?;
    let manifest = AnalysisManifest {
        media_path: &job.media_path,
        media_fingerprint: &job.media_fingerprint,
        pipeline_version: &job.pipeline_version,
        separator_model: &job.separator_model,
        asr_model: &job.asr_model,
        aligner_model: &job.aligner_model,
        status: &job.status,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    let manifest_path = derived_directory.join("manifest.json");
    if job.status != "ready" || !manifest_path.is_file() {
        fs::write(manifest_path, manifest_bytes).map_err(|error| error.to_string())?;
    }
    Ok(job)
}

pub async fn queue(
    media_path: PathBuf,
    database_path: PathBuf,
    derived_root: PathBuf,
) -> Result<AiAnalysisJob, String> {
    tauri::async_runtime::spawn_blocking(move || {
        queue_blocking(media_path, database_path, derived_root)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub fn list(database_path: &Path) -> Result<Vec<AiAnalysisJob>, String> {
    let connection = open_database(database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, media_path, media_fingerprint, pipeline_version, status, stage,
                    derived_directory, separator_model, asr_model, aligner_model,
                    attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             FROM ai_analysis_jobs ORDER BY created_at_unix_ms DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_job)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn update_scheduler_priorities(
    database_path: &Path,
    playing_paths: &[PathBuf],
    deck_paths: &[PathBuf],
) -> Result<usize, String> {
    let mut connection = open_database(database_path)?;
    let now = current_unix_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut changed = transaction
        .execute(
            "UPDATE ai_analysis_jobs
             SET priority=2,
                 status=CASE WHEN status='paused' THEN 'queued' ELSE status END,
                 stage=CASE WHEN status='paused' THEN 'resuming-after-playback' ELSE stage END,
                 error_message=CASE WHEN status='paused' THEN NULL ELSE error_message END,
                 updated_at_unix_ms=CASE WHEN status='paused' THEN ?1 ELSE updated_at_unix_ms END
             WHERE status IN ('queued', 'running', 'failed', 'paused')",
            params![now],
        )
        .map_err(|error| error.to_string())?;
    for path in deck_paths {
        let canonical = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .into_owned();
        changed += transaction
            .execute(
                "UPDATE ai_analysis_jobs SET priority=1
                 WHERE media_path=?1 AND status IN ('queued', 'running', 'failed')",
                params![canonical],
            )
            .map_err(|error| error.to_string())?;
    }
    for path in playing_paths {
        let canonical = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .into_owned();
        changed += transaction
            .execute(
                "UPDATE ai_analysis_jobs SET priority=0
                 WHERE media_path=?1 AND status IN ('queued', 'running', 'failed')",
                params![canonical],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

pub fn ready_job_for_media_path(
    database_path: &Path,
    media_path: &Path,
) -> Result<AiAnalysisJob, String> {
    let canonical = media_path
        .canonicalize()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let connection = open_database(database_path)?;
    connection
        .query_row(
            "SELECT id, media_path, media_fingerprint, pipeline_version, status, stage,
                    derived_directory, separator_model, asr_model, aligner_model,
                    attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             FROM ai_analysis_jobs
             WHERE media_path=?1 AND status='ready'
             ORDER BY updated_at_unix_ms DESC LIMIT 1",
            params![canonical],
            row_to_job,
        )
        .map_err(|_| "歌曲尚未制作完成，不能导出 .kingsong".to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn register_imported_ready(
    database_path: &Path,
    media_path: &Path,
    expected_fingerprint: &str,
    derived_directory: &Path,
    pipeline_version: &str,
    separator_model: &str,
    asr_model: &str,
    aligner_model: &str,
) -> Result<AiAnalysisJob, String> {
    let canonical_path = media_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let actual_fingerprint = fingerprint(&canonical_path)?;
    if actual_fingerprint != expected_fingerprint {
        return Err(".kingsong 原唱内容指纹不匹配".to_string());
    }
    let media_path_string = canonical_path.to_string_lossy().into_owned();
    let derived_directory_string = derived_directory.to_string_lossy().into_owned();
    let now = current_unix_ms();
    let connection = open_database(database_path)?;
    connection
        .execute(
            "INSERT INTO ai_analysis_jobs (
               media_path, media_fingerprint, pipeline_version, status, stage,
               derived_directory, separator_model, asr_model, aligner_model,
               attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, 'ready', 'complete', ?4, ?5, ?6, ?7, 0, NULL, ?8, ?8)
             ON CONFLICT(media_fingerprint, pipeline_version) DO UPDATE SET
               media_path=excluded.media_path,
               status='ready', stage='complete',
               derived_directory=excluded.derived_directory,
               separator_model=excluded.separator_model,
               asr_model=excluded.asr_model,
               aligner_model=excluded.aligner_model,
               error_message=NULL,
               updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![
                media_path_string,
                expected_fingerprint,
                pipeline_version,
                derived_directory_string,
                separator_model,
                asr_model,
                aligner_model,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, media_path, media_fingerprint, pipeline_version, status, stage,
                    derived_directory, separator_model, asr_model, aligner_model,
                    attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             FROM ai_analysis_jobs
             WHERE media_fingerprint=?1 AND pipeline_version=?2",
            params![expected_fingerprint, pipeline_version],
            row_to_job,
        )
        .map_err(|error| error.to_string())
}

pub fn ready_artifacts_by_media_path(
    database_path: &Path,
) -> Result<HashMap<String, ReadyAudioArtifacts>, String> {
    if !database_path.is_file() {
        return Ok(HashMap::new());
    }
    let connection = open_database(database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT media_path, derived_directory FROM ai_analysis_jobs
             WHERE status='ready'
             ORDER BY CASE WHEN pipeline_version=?1 THEN 0 ELSE 1 END,
                      updated_at_unix_ms DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![PIPELINE_VERSION], |row| {
            Ok((
                row.get::<_, String>(0)?,
                PathBuf::from(row.get::<_, String>(1)?),
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut artifacts = HashMap::new();
    for row in rows {
        let (media_path, directory) = row.map_err(|error| error.to_string())?;
        let value = ReadyAudioArtifacts {
            lyrics_path: directory.join("lyrics.lrc"),
            words_path: directory.join("lyrics.words.json"),
            vocals_path: directory
                .join("vocals.flac")
                .is_file()
                .then(|| directory.join("vocals.flac")),
            accompaniment_path: directory.join("no_vocals.flac"),
        };
        if value.lyrics_path.is_file()
            && value.words_path.is_file()
            && value.accompaniment_path.is_file()
        {
            // Keep the newest current-pipeline result when available, but
            // continue exposing the last complete version while an upgrade is
            // queued/running. A model or lyric-rule upgrade must never make a
            // playable song temporarily lose its lyrics or accompaniment.
            artifacts.entry(media_path).or_insert(value);
        }
    }
    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "king-ai-analysis-{label}-{}-{}",
            std::process::id(),
            current_unix_ms()
        ))
    }

    #[test]
    fn queues_once_and_persists_the_selected_models() {
        let root = test_root("queue");
        fs::create_dir_all(&root).unwrap();
        let media = root.join("song.mp3");
        let mut file = File::create(&media).unwrap();
        file.write_all(b"stable fake audio payload").unwrap();
        let database = root.join("king.sqlite3");
        let derived = root.join("analysis");

        let first = queue_blocking(media.clone(), database.clone(), derived.clone()).unwrap();
        let second = queue_blocking(media, database.clone(), derived).unwrap();
        let jobs = list(&database).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].asr_model, ASR_MODEL);
        assert_eq!(jobs[0].aligner_model, ALIGNER_MODEL);
        assert!(Path::new(&jobs[0].derived_directory)
            .join("manifest.json")
            .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renamed_identical_media_reuses_the_existing_job() {
        let root = test_root("rename");
        fs::create_dir_all(&root).unwrap();
        let first_path = root.join("first.mp3");
        fs::write(&first_path, b"the same media bytes").unwrap();
        let database = root.join("king.sqlite3");
        let derived = root.join("analysis");
        let first = queue_blocking(first_path.clone(), database.clone(), derived.clone()).unwrap();
        let second_path = root.join("renamed.mp3");
        fs::rename(first_path, &second_path).unwrap();
        let second = queue_blocking(second_path.clone(), database.clone(), derived).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(
            second.media_path,
            second_path.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(list(&database).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scheduler_prioritizes_playing_then_loaded_then_background() {
        let root = test_root("scheduler");
        fs::create_dir_all(&root).unwrap();
        let playing = root.join("playing.mp3");
        let loaded = root.join("loaded.mp3");
        let background = root.join("background.mp3");
        fs::write(&playing, b"playing media").unwrap();
        fs::write(&loaded, b"loaded media").unwrap();
        fs::write(&background, b"background media").unwrap();
        let database = root.join("king.sqlite3");
        let derived = root.join("analysis");
        let playing_job =
            queue_blocking(playing.clone(), database.clone(), derived.clone()).unwrap();
        let loaded_job = queue_blocking(loaded.clone(), database.clone(), derived.clone()).unwrap();
        let background_job = queue_blocking(background, database.clone(), derived).unwrap();
        open_database(&database)
            .unwrap()
            .execute(
                "UPDATE ai_analysis_jobs SET status='paused', stage='paused-for-playback' WHERE id=?1",
                params![background_job.id],
            )
            .unwrap();

        update_scheduler_priorities(&database, &[playing], &[loaded]).unwrap();

        let connection = open_database(&database).unwrap();
        let read = |id| {
            connection
                .query_row(
                    "SELECT priority, status FROM ai_analysis_jobs WHERE id=?1",
                    params![id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap()
        };
        assert_eq!(read(playing_job.id), (0, "queued".to_string()));
        assert_eq!(read(loaded_job.id), (1, "queued".to_string()));
        assert_eq!(read(background_job.id), (2, "queued".to_string()));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exposes_only_complete_ready_artifacts_and_preserves_ready_manifest() {
        let root = test_root("ready-artifacts");
        fs::create_dir_all(&root).unwrap();
        let media = root.join("song.mp3");
        fs::write(&media, b"completed media bytes").unwrap();
        let database = root.join("king.sqlite3");
        let derived_root = root.join("analysis");
        let job = queue_blocking(media.clone(), database.clone(), derived_root.clone()).unwrap();
        let derived = PathBuf::from(&job.derived_directory);
        for name in ["lyrics.lrc", "lyrics.words.json", "no_vocals.flac"] {
            fs::write(derived.join(name), b"ready").unwrap();
        }
        let finished_manifest = b"{\"status\":\"ready\",\"language\":\"Chinese\"}";
        fs::write(derived.join("manifest.json"), finished_manifest).unwrap();
        open_database(&database)
            .unwrap()
            .execute(
                "UPDATE ai_analysis_jobs SET status='ready', stage='complete' WHERE id=?1",
                params![job.id],
            )
            .unwrap();

        let artifacts = ready_artifacts_by_media_path(&database).unwrap();
        let key = media.canonicalize().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            artifacts.get(&key).unwrap().lyrics_path,
            derived.join("lyrics.lrc")
        );
        assert!(artifacts.get(&key).unwrap().vocals_path.is_none());

        queue_blocking(media, database, derived_root).unwrap();
        assert_eq!(
            fs::read(derived.join("manifest.json")).unwrap(),
            finished_manifest
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_previous_ready_artifacts_visible_during_pipeline_upgrade() {
        let root = test_root("upgrade-fallback");
        fs::create_dir_all(&root).unwrap();
        let media = root.join("song.mp3");
        fs::write(&media, b"upgrade media bytes").unwrap();
        let database = root.join("king.sqlite3");
        let current = queue_blocking(
            media.clone(),
            database.clone(),
            root.join("current-analysis"),
        )
        .unwrap();
        let previous_directory = root.join("previous-analysis");
        fs::create_dir_all(&previous_directory).unwrap();
        for name in ["lyrics.lrc", "lyrics.words.json", "no_vocals.flac"] {
            fs::write(previous_directory.join(name), b"previous-ready").unwrap();
        }
        let connection = open_database(&database).unwrap();
        connection
            .execute(
                "INSERT INTO ai_analysis_jobs (
                   media_path, media_fingerprint, pipeline_version, status, stage,
                   derived_directory, separator_model, asr_model, aligner_model,
                   attempts, error_message, created_at_unix_ms, updated_at_unix_ms
                 ) VALUES (?1, ?2, 'previous-pipeline', 'ready', 'complete',
                           ?3, 'previous-separator', 'previous-asr', 'previous-aligner',
                           0, NULL, 1, 1)",
                params![
                    current.media_path,
                    current.media_fingerprint,
                    previous_directory.to_string_lossy(),
                ],
            )
            .unwrap();

        let key = media.canonicalize().unwrap().to_string_lossy().into_owned();
        let artifacts = ready_artifacts_by_media_path(&database).unwrap();
        assert_eq!(
            artifacts.get(&key).unwrap().lyrics_path,
            previous_directory.join("lyrics.lrc")
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
