import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const importerSource = await readFile(new URL("../src-tauri/src/audio_importer.rs", import.meta.url), "utf8");
const analysisSource = await readFile(new URL("../src-tauri/src/ai_analysis.rs", import.meta.url), "utf8");

test("encrypted local imports decode first and then use the normal AI pipeline", () => {
  assert.match(importerSource, /is_encrypted_import_path/);
  assert.doesNotMatch(analysisSource, /\("skipped",\s*"encrypted-import-playback"\)/);
  assert.match(analysisSource, /stage IN \('missing-artist', 'encrypted-import-playback'\)/);
  assert.doesNotMatch(appSource, /aiProcessingDisabled/);
  assert.match(appSource, /shouldQueueAudioAiAnalysis\(\s*runtimeCapability\.aiProcessingAvailable,\s*audioAiWorker\.enabled/);
  assert.match(appSource, /audioAiQueueAllowed \? nextAudio : \[\]/);
});
