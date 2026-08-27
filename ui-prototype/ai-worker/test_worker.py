import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

import worker


class SchedulerTests(unittest.TestCase):
    def test_leases_jobs_in_three_tier_priority_order(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "scheduler.sqlite3"
            worker.ensure_job_table(database)
            connection = sqlite3.connect(database)
            try:
                for job_id, priority in ((1, 2), (2, 0), (3, 1)):
                    connection.execute(
                        """INSERT INTO ai_analysis_jobs (
                           id, media_path, media_fingerprint, pipeline_version, status, stage,
                           derived_directory, separator_model, asr_model, aligner_model,
                           attempts, error_message, created_at_unix_ms, updated_at_unix_ms, priority
                         ) VALUES (?, ?, ?, 'test', 'queued', 'pending', ?, 'separator',
                                   'asr', 'aligner', 0, NULL, ?, ?, ?)""",
                        (
                            job_id,
                            f"song-{job_id}.wav",
                            f"fingerprint-{job_id}",
                            f"derived-{job_id}",
                            job_id,
                            job_id,
                            priority,
                        ),
                    )
                connection.commit()
            finally:
                connection.close()

            self.assertEqual(worker.lease_job(database, None, include_failed=False)["id"], 2)
            self.assertEqual(worker.lease_job(database, None, include_failed=False)["id"], 3)
            self.assertEqual(worker.lease_job(database, None, include_failed=False)["id"], 1)

    def test_leases_only_the_requested_pipeline_version(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "pipeline.sqlite3"
            worker.ensure_job_table(database)
            connection = sqlite3.connect(database)
            try:
                for job_id, pipeline in ((1, "old"), (2, "current")):
                    connection.execute(
                        """INSERT INTO ai_analysis_jobs (
                           id, media_path, media_fingerprint, pipeline_version, status, stage,
                           derived_directory, separator_model, asr_model, aligner_model,
                           attempts, error_message, created_at_unix_ms, updated_at_unix_ms, priority
                         ) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, 'separator',
                                   'asr', 'aligner', 0, NULL, ?, ?, 2)""",
                        (
                            job_id,
                            f"song-{job_id}.wav",
                            f"fingerprint-{job_id}",
                            pipeline,
                            f"derived-{job_id}",
                            job_id,
                            job_id,
                        ),
                    )
                connection.commit()
            finally:
                connection.close()

            leased = worker.lease_job(
                database,
                None,
                include_failed=False,
                pipeline_version="current",
            )
            self.assertEqual(leased["id"], 2)


class MossResponseTests(unittest.TestCase):
    def test_compresses_reference_pitch_and_preserves_song_identity(self):
        payload = worker.build_reference_map(
            [440.0, 441.0, float("nan"), 493.88],
            [0.99, 0.98, 0.0, 0.97],
            source_fingerprint="a" * 64,
            source_duration_samples=512,
            separator_profile_value={"model": "test"},
        )
        self.assertEqual(payload["sourceFingerprint"], "a" * 64)
        self.assertEqual(payload["sampleRate"], 48_000)
        self.assertEqual([segment["midiNote"] for segment in payload["segments"]], [69, 71])
        self.assertEqual(payload["segments"][0]["endSample"], 256)

    def test_rejects_stale_reference_generator_or_separator_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference.json"
            payload = worker.build_reference_map(
                [440.0],
                [0.99],
                source_fingerprint="b" * 64,
                source_duration_samples=128,
                separator_profile_value={"model": "current"},
            )
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertTrue(
                worker.reference_map_is_current(path, "b" * 64, {"model": "current"})
            )
            self.assertFalse(
                worker.reference_map_is_current(path, "b" * 64, {"model": "old"})
            )

    def test_generates_reference_json_from_a_real_audio_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vocals = root / "vocals.flac"
            destination = root / "reference.json"
            sample_rate = 48_000
            samples = np.arange(sample_rate // 2, dtype=np.float32)
            tone = (0.2 * np.sin(2 * np.pi * 440.0 * samples / sample_rate)).astype(np.float32)
            sf.write(vocals, tone, sample_rate)
            payload = worker.generate_reference_map(
                vocals,
                destination,
                "c" * 64,
                {"model": "test"},
            )
            self.assertTrue(destination.is_file())
            self.assertTrue(payload["segments"])
            self.assertEqual(payload["segments"][0]["midiNote"], 69)

    def test_combines_full_instrument_stems_into_accompaniment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "drums.wav"
            second = root / "bass.wav"
            output = root / "no_vocals.flac"
            sf.write(first, np.full((4410, 2), 0.1, dtype=np.float32), 44100, subtype="FLOAT")
            sf.write(second, np.full((4410, 2), 0.2, dtype=np.float32), 44100, subtype="FLOAT")
            worker.combine_stems_to_flac([first, second], output)
            mixed, samplerate = sf.read(output, dtype="float32", always_2d=True)
            self.assertEqual(samplerate, 44100)
            self.assertTrue(np.allclose(mixed, 0.3, atol=1e-4))

    def test_requires_an_exact_separation_profile_marker(self):
        configuration = {
            "architecture": "bs-roformer",
            "model": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            "batchSize": 1,
            "overlap": 8,
            "fallbackModel": "htdemucs_ft",
            "fallbackShifts": 2,
            "fallbackOverlap": 0.5,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(worker.separation_is_current(root, configuration))
            (root / "separation.json").write_text(
                json.dumps({"profile": worker.separator_profile(configuration)}),
                encoding="utf-8",
            )
            self.assertTrue(worker.separation_is_current(root, configuration))

    def test_extracts_json_after_native_thinking_block(self):
        payload = worker.extract_json_object(
            '<think>reasoning with {internal} notes</think>\n'
            '{"language":"Chinese","items":[]}'
        )
        self.assertEqual(payload["language"], "Chinese")

    def test_extracts_fenced_json(self):
        payload = worker.extract_json_object(
            '```json\n{"language":"English","items":[]}\n```'
        )
        self.assertEqual(payload["language"], "English")

    def test_repairs_known_missing_items_delimiter(self):
        payload = worker.extract_json_object(
            '{"language":"English","items [{"text":"line",'
            '"startSeconds":1,"endSeconds":2}]}'
        )
        self.assertEqual(payload["items"][0]["text"], "line")

    def test_repairs_missing_commas_between_timestamp_items(self):
        payload = worker.extract_json_object(
            '{"language":"English","items":['
            '{"text":"one","startSeconds":1,"endSeconds":2}'
            '{"text":"two","startSeconds":2 "endSeconds":3}]}'
        )
        self.assertEqual([item["text"] for item in payload["items"]], ["one", "two"])

    def test_salvages_valid_flat_items_from_a_partially_broken_array(self):
        payload = worker.extract_json_object(
            '{"language":"Chinese","items":['
            '{"text":"保留","startSeconds":1,"endSeconds":2},'
            '{broken item},'
            '{"text":"继续","startSeconds":3,"endSeconds":4}]}'
        )
        self.assertEqual([item["text"] for item in payload["items"]], ["保留", "继续"])

    def test_salvages_timestamp_fields_when_an_object_has_an_invalid_property(self):
        payload = worker.extract_json_object(
            '{"language":"Chinese","items":['
            '{broken:true,"text":"抢救这一句","startSeconds":1.5,"endSeconds":3.2}]}'
        )
        self.assertEqual(
            payload["items"],
            [{"text": "抢救这一句", "startSeconds": 1.5, "endSeconds": 3.2}],
        )

    def test_normalizes_and_rejects_invalid_timestamp_items(self):
        items = worker.normalize_timestamp_items(
            {
                "items": [
                    {"text": " hello ", "start": 1, "end": 2.5},
                    {"text": "backward", "startSeconds": 4, "endSeconds": 3},
                    {"text": "", "startSeconds": 5, "endSeconds": 6},
                ]
            }
        )
        self.assertEqual(
            items,
            [{"text": "hello", "startSeconds": 1.0, "endSeconds": 2.5}],
        )

    def test_builds_lrc_from_timestamp_items(self):
        result = worker.build_lrc(
            [
                {"text": "你", "startSeconds": 1.23, "endSeconds": 1.5},
                {"text": "好", "startSeconds": 1.5, "endSeconds": 1.9},
            ]
        )
        self.assertEqual(result, "[00:01.23]你好\n")

    def test_builds_one_timed_display_line_per_chinese_clause(self):
        result = worker.build_lrc(
            [{
                "text": "那年相遇，那场烟雨，我一见倾心。",
                "startSeconds": 10.0,
                "endSeconds": 22.0,
            }]
        )
        lines = result.strip().splitlines()
        self.assertEqual([line.split("]", 1)[1] for line in lines], ["那年相遇", "那场烟雨", "我一见倾心"])
        self.assertTrue(lines[0].startswith("[00:10.00]"))

    def test_detects_and_expands_a_coarse_paragraph_timestamp(self):
        source = [{
            "text": "第一句应该单独显示，第二句也要跟着音乐。第三句不能挤在同一个画面里！",
            "startSeconds": 10.0,
            "endSeconds": 40.0,
        }]
        self.assertTrue(worker.timestamp_item_is_coarse(source[0]))
        expanded = worker.expand_coarse_timestamp_items(source)
        self.assertGreater(len(expanded), 1)
        self.assertEqual(expanded[0]["startSeconds"], 10.0)
        self.assertEqual(expanded[-1]["endSeconds"], 40.0)
        self.assertTrue(all(len(item["text"]) < len(source[0]["text"]) for item in expanded))

    def test_splits_a_long_korean_phrase_even_when_under_eighteen_seconds(self):
        source = [{
            "text": "너를 비참을 드는 향기 익숙함에 미참 몰랐지 뜨거운 여름의 끝자락 또다시 설렘 이 번져와 네 어깨 뒤로 일렁이는 추억들 무비다",
            "startSeconds": 27.688,
            "endSeconds": 44.882,
        }]
        expanded = worker.expand_coarse_timestamp_items(source)
        self.assertGreater(len(expanded), 1)
        self.assertEqual(expanded[0]["startSeconds"], 27.688)
        self.assertEqual(expanded[-1]["endSeconds"], 44.882)
        self.assertTrue(all(len(item["text"]) <= 28 for item in expanded))

    def test_does_not_join_complete_korean_phrases_into_one_lrc_row(self):
        result = worker.build_lrc([
            {"text": "무빛 따라 살랑이는 바람결", "startSeconds": 44.12, "endSeconds": 47.48},
            {"text": "사랑을 본 것만 같아 난", "startSeconds": 47.48, "endSeconds": 50.68},
        ])
        self.assertEqual(len(result.strip().splitlines()), 2)

    def test_discards_a_truncated_candidate_inside_a_complete_overlap(self):
        items = [
            {
                "text": "我最怕回忆，最怕想起你，最怕陷入挣扎泪如雨。",
                "startSeconds": 111.465,
                "endSeconds": 124.82,
            },
            {"text": "我最怕回", "startSeconds": 112.3, "endSeconds": 114.81},
        ]
        reconciled = worker.reconcile_overlapping_timestamp_items(items)
        self.assertEqual([item["text"] for item in reconciled], [items[0]["text"]])
        self.assertNotIn("我最怕回\n", worker.build_lrc(items))

    def test_reconciles_real_moss_overlap_without_collapsing_adjacent_lyrics(self):
        items = [
            {
                "text": "让了一圈那短暂快感之后",
                "startSeconds": 68.293,
                "endSeconds": 74.5,
            },
            {
                "text": "绕了一圈那短暂快感之后的空荡",
                "startSeconds": 71.46,
                "endSeconds": 77.62,
            },
            {
                "text": "痛苦不断不断的交替",
                "startSeconds": 117.83,
                "endSeconds": 121.638,
            },
            {
                "text": "不断不断的交替还有什么留情的余地",
                "startSeconds": 120.0,
                "endSeconds": 128.8,
            },
            {
                "text": "还有什么留情",
                "startSeconds": 121.638,
                "endSeconds": 124.56,
            },
        ]

        reconciled = worker.reconcile_overlapping_timestamp_items(items)

        self.assertEqual(
            [item["text"] for item in reconciled],
            [
                "绕了一圈那短暂快感之后的空荡",
                "痛苦不断不断的交替",
                "不断不断的交替还有什么留情的余地",
            ],
        )
        self.assertEqual(reconciled[0]["startSeconds"], 68.293)
        self.assertEqual(reconciled[1]["endSeconds"], 120.0)
        self.assertTrue(
            all(
                float(current["endSeconds"]) <= float(following["startSeconds"])
                for current, following in zip(reconciled, reconciled[1:])
            )
        )

    def test_only_reuses_lyrics_from_the_current_postprocess_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("lyrics.lrc", "lyrics.words.json", "lyrics.txt"):
                (root / name).write_text("ready", encoding="utf-8")
            pipeline = {"lyricsPostprocessVersion": "moss-native-monotonic-v2"}
            (root / "manifest.json").write_text(
                json.dumps({"lyricsPostprocessVersion": "moss-native-monotonic-v1"}),
                encoding="utf-8",
            )
            self.assertFalse(worker.lyrics_artifacts_are_current(root, pipeline))
            (root / "manifest.json").write_text(
                json.dumps({"lyricsPostprocessVersion": "moss-native-monotonic-v2"}),
                encoding="utf-8",
            )
            self.assertTrue(worker.lyrics_artifacts_are_current(root, pipeline))


if __name__ == "__main__":
    unittest.main()
