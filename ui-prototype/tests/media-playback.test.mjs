import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const fixtureDirectory = process.env.KING_MEDIA_FIXTURE_DIR;
const edgeCandidates = [
  join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
];
const edge = edgeCandidates.find(existsSync);

test("Windows media engine decodes and starts local MP4 and MP3", {
  skip: !fixtureDirectory || !edge ? "set KING_MEDIA_FIXTURE_DIR and install Microsoft Edge" : false,
}, () => {
  const harness = new URL(pathToFileURL(join(process.cwd(), "tests", "media-playback-harness.html")));
  harness.searchParams.set("video", pathToFileURL(join(fixtureDirectory, "flower.mp4")).href);
  harness.searchParams.set("audio", pathToFileURL(join(fixtureDirectory, "t-rex-roar.mp3")).href);
  const profile = join(tmpdir(), `king-media-edge-${process.pid}`);

  try {
    const run = spawnSync(edge, [
      "--headless=new",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required",
      "--virtual-time-budget=5000",
      "--dump-dom",
      `--user-data-dir=${profile}`,
      harness.href,
    ], { encoding: "utf8", timeout: 15000 });

    assert.equal(run.status, 0, run.stderr || "Edge media check failed");
    assert.match(run.stdout, /data-status="pass"/);
    const payloadText = run.stdout.match(/<pre id="result" data-status="pass">([^<]+)<\/pre>/)?.[1];
    assert.ok(payloadText, "missing media result payload");
    const payload = JSON.parse(payloadText.replaceAll("&quot;", '"'));
    assert.ok(payload.video.duration > 0);
    assert.ok(payload.audio.duration > 0);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
