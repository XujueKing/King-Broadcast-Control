use std::{
    env,
    path::{Path, PathBuf},
};

pub fn ai_root_candidates() -> Vec<PathBuf> {
    if let Some(root) = env::var_os("KING_AUDIO_AI_ROOT") {
        return vec![PathBuf::from(root)];
    }
    let mut roots = Vec::new();
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            roots.push(directory.join("ai-runtime"));
        }
    }
    if let Some(app_data) = env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("club.king.broadcast-control/ai-runtime"));
    }
    // Compatibility for the developer machine; installed copies use the portable paths above.
    roots.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf(),
    );
    roots
}

pub fn find_ai_root_in(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .find(|root| {
            root.join(".venv-audio-ai/Scripts/python.exe").is_file()
                && root.join("ai-worker/worker.py").is_file()
                && root.join("ai-worker/pipeline.json").is_file()
        })
        .cloned()
}

pub fn ai_root() -> Option<PathBuf> {
    find_ai_root_in(&ai_root_candidates())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_runtime_never_qualifies_as_ready() {
        assert!(find_ai_root_in(&[PathBuf::from("Z:/king-audit-missing-environment")]).is_none());
    }
    #[test]
    fn portable_root_requires_python_worker_and_pipeline() {
        let root = env::temp_dir().join(format!("king-ai-root-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".venv-audio-ai/Scripts")).unwrap();
        std::fs::create_dir_all(root.join("ai-worker")).unwrap();
        std::fs::write(root.join(".venv-audio-ai/Scripts/python.exe"), b"fixture").unwrap();
        std::fs::write(root.join("ai-worker/worker.py"), b"fixture").unwrap();
        assert!(find_ai_root_in(&[root.clone()]).is_none());
        std::fs::write(root.join("ai-worker/pipeline.json"), b"{}").unwrap();
        assert_eq!(find_ai_root_in(&[root.clone()]), Some(root.clone()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
