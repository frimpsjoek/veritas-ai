//! The search model (snowflake-arctic-embed-s, 133 MB): downloaded on first start instead of shipped in the installer
//! (spec 024 D4). The same three files, from the same place, as `bin/veritas model`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const BASE: &str = "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main";
// The big file first, so the bar moves for the part that takes time.
const FILES: [&str; 3] = ["onnx/model.onnx", "tokenizer.json", "config.json"];
// Known sizes, so the bar shows the whole download from the start; a changed file only makes the estimate rough.
const EXPECTED_BYTES: u64 = 133_093_492 + 711_649 + 703;

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

pub fn dir(data: &Path) -> PathBuf {
    data.join("models").join("snowflake-arctic-embed-s")
}

/// What the server checks before it can search by meaning (kb.py MODEL_DIR).
pub fn present(data: &Path) -> bool {
    let model = dir(data);
    model.join("onnx").join("model.onnx").is_file() && model.join("tokenizer.json").is_file()
}

/// Downloads the files that are missing, reporting `model-progress` to the start page. Each file is written to
/// `<name>.part` and renamed when complete, so a download cut off half way is never taken for the model.
pub async fn download(app: &AppHandle, data: &Path) -> Result<(), String> {
    let model = dir(data);
    fs::create_dir_all(model.join("onnx")).map_err(|e| format!("cannot create {}: {e}", model.display()))?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Veritas/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut done = 0u64;
    for name in FILES {
        let target = model.join(name);
        if target.is_file() {
            done += target.metadata().map(|m| m.len()).unwrap_or(0);
            continue;
        }
        let mut response = client
            .get(format!("{BASE}/{name}"))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("could not download the search model ({name}): {e}"))?;
        let part = target.with_extension("part");
        let mut file = fs::File::create(&part).map_err(|e| format!("cannot write {}: {e}", part.display()))?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("the download of {name} was cut off: {e}"))?
        {
            file.write_all(&chunk).map_err(|e| format!("cannot write {}: {e}", part.display()))?;
            done += chunk.len() as u64;
            let _ = app.emit("model-progress", Progress { done, total: EXPECTED_BYTES.max(done) });
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&part, &target).map_err(|e| format!("cannot finish {}: {e}", target.display()))?;
    }
    Ok(())
}
