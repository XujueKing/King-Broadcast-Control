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

test("desktop startup always restores automatic PGM colour and beat lighting", () => {
  assert.match(
    appSource,
    /const \[light, setLight\] = useState\(null\)/,
  );
  assert.match(
    appSource,
    /const \[lightRhythmRule, setLightRhythmRule\] = useState\("beat"\)/,
  );
  assert.match(
    appSource,
    /const \[lightingEnabled, setLightingEnabled\] = useState\(true\)/,
  );
});

test("PGM colour sampling reacts quickly without accepting one-frame colour noise", () => {
  assert.match(appSource, /window\.setInterval\(sample,400\)/);
  assert.match(appSource, /tracker\.lastAppliedFamily===null\?1:2/);
});
