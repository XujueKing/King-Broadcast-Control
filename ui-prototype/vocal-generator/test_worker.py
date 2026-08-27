import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from worker import (
    REFERENCE_GAP_SECONDS,
    REFERENCE_PIECE_SECONDS,
    build_voice_reference,
    seed_vc_entrypoint,
)


class VoiceReferenceTests(unittest.TestCase):
    def test_builds_derived_reference_without_changing_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            samples = []
            for index in range(2):
                path = root / f"sample-{index}.wav"
                audio = np.sin(np.arange(48_000, dtype=np.float32) * 0.03) * 0.1
                sf.write(path, audio, 48_000)
                samples.append(path)
            before = [path.read_bytes() for path in samples]
            output = root / "reference.wav"

            build_voice_reference([str(path) for path in samples], output)

            self.assertTrue(output.is_file())
            self.assertEqual(before, [path.read_bytes() for path in samples])
            audio, rate = sf.read(output)
            self.assertEqual(rate, 48_000)
            self.assertGreater(audio.size, 48_000)

    def test_balances_all_six_prompts_inside_seed_vc_prompt_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            samples = []
            for index in range(6):
                path = root / f"sample-{index}.wav"
                audio = np.zeros(48_000 * 5, dtype=np.float32)
                audio[48_000 : 48_000 * 4] = (
                    np.sin(np.arange(48_000 * 3, dtype=np.float32) * (0.02 + index * 0.001))
                    * (0.04 + index * 0.01)
                )
                sf.write(path, audio, 48_000)
                samples.append(path)
            output = root / "reference.wav"

            build_voice_reference([str(path) for path in samples], output)

            audio, rate = sf.read(output)
            expected = (
                REFERENCE_PIECE_SECONDS * 6 + REFERENCE_GAP_SECONDS * 5
            )
            self.assertAlmostEqual(audio.size / rate, expected, places=2)
            self.assertLess(audio.size / rate, 25.0)
            for index in range(6):
                start = int(index * (REFERENCE_PIECE_SECONDS + REFERENCE_GAP_SECONDS) * rate)
                stop = start + int(REFERENCE_PIECE_SECONDS * rate)
                self.assertGreater(np.sqrt(np.mean(audio[start:stop] ** 2)), 0.01)

    def test_patches_seed_vc_writer_without_touching_upstream_file(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            source = runtime / "inference.py"
            original = (
                "import torchaudio\n"
                "torchaudio.save(os.path.join(args.output, "
                "f\"vc_{source_name}_{target_name}_{length_adjust}_{diffusion_steps}_{inference_cfg_rate}.wav\"), "
                "vc_wave.cpu(), sr)\n"
            )
            source.write_text(original, encoding="utf-8")

            patched = seed_vc_entrypoint(runtime)

            self.assertEqual(source.read_text(encoding="utf-8"), original)
            result = patched.read_text(encoding="utf-8")
            self.assertIn("import soundfile as sf", result)
            self.assertIn("vc_wave.squeeze(0).cpu().numpy()", result)
            self.assertNotIn("torchaudio.save", result)


if __name__ == "__main__":
    unittest.main()
