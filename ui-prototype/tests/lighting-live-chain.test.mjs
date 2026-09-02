import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("PGM video opts into anonymous CORS so live frames can be sampled", () => {
  assert.match(
    appSource,
    /<video ref=\{videoRef\}[^>]*crossOrigin="anonymous"/,
  );
});

test("lighting rhythm defaults to every beat when no operator preference exists", () => {
  assert.match(
    appSource,
    /loadRhythmRule\("king\.rhythm\.lighting","beat"\)/,
  );
});
