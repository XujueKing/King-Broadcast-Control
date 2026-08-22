use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const PIPELINE_VERSION: &str = "king-audio-ai-v1";
pub const SEPARATOR_MODEL: &str = "htdemucs";
pub const ASR_MODEL: &str = "Qwen/Qwen3-ASR-1.7B";
pub const ALIGNER_MODEL: &str = "Qwen/Qwen3-ForcedAligner-0.6B";

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
    pub vocals_path: PathBuf,
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

fn current_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn open_database(path: &Path) -> Result<Connection, String> {
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
               UNIQUE(media_fingerprint, pipeline_version)
             );
             CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_status
               ON ai_analysis_jobs(status, updated_at_unix_ms);
             CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_media_path
               ON ai_analysis_jobs(media_path);",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

// A bounded fingerprint avoids reading an entire multi-hour file on the UI scan path.
// It combines file size with 1 MiB samples from the beginning, middle and end. The
// Python worker will later write the full source checksum into its finished manifest.
fn fingerprint(path: &Path) -> Result<String, String> {
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
    let now = current_unix_ms();
    let connection = open_database(&database_path)?;
    connection
        .execute(
            "INSERT INTO ai_analysis_jobs (
               media_path, media_fingerprint, pipeline_version, status, stage,
               derived_directory, separator_model, asr_model, aligner_model,
               attempts, error_message, created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, 'queued', 'pending', ?4, ?5, ?6, ?7, 0, NULL, ?8, ?8)
             ON CONFLICT(media_fingerprint, pipeline_version) DO UPDATE SET
               media_path=excluded.media_path,
               derived_directory=excluded.derived_directory,
               separator_model=excluded.separator_model,
               asr_model=excluded.asr_model,
               aligner_model=excluded.aligner_model,
               updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![
                media_path_string,
                fingerprint,
                PIPELINE_VERSION,
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
             WHERE status='ready' AND pipeline_version=?1",
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
            vocals_path: directory.join("vocals.flac"),
            accompaniment_path: directory.join("no_vocals.flac"),
        };
        if value.lyrics_path.is_file()
            && value.vocals_path.is_file()
            && value.accompaniment_path.is_file()
        {
            artifacts.insert(media_path, value);
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
    fn exposes_only_complete_ready_artifacts_and_preserves_ready_manifest() {
        let root = test_root("ready-artifacts");
        fs::create_dir_all(&root).unwrap();
        let media = root.join("song.mp3");
        fs::write(&media, b"completed media bytes").unwrap();
        let database = root.join("king.sqlite3");
        let derived_root = root.join("analysis");
        let job = queue_blocking(media.clone(), database.clone(), derived_root.clone()).unwrap();
        let derived = PathBuf::from(&job.derived_directory);
        for name in ["lyrics.lrc", "vocals.flac", "no_vocals.flac"] {
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

        queue_blocking(media, database, derived_root).unwrap();
        assert_eq!(
            fs::read(derived.join("manifest.json")).unwrap(),
            finished_manifest
        );
        fs::remove_dir_all(root).unwrap();
    }
}
