import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("PGM video opts into anonymous CORS so live frames can be sampled", () => {
  assert.match(
    appSource,
    /<video\b[^>]*ref=\{videoRef\}[^>]*crossOrigin="anonymous"/,
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
  assert.match(appSource, /const \[beamShowArmed,setBeamShowArmed\]=useState\(false\)/);
  assert.match(appSource, /beamShowArmed\?beamShowControllerRef\.current\.next\(rhythmEvent\):null/);
  assert.match(appSource, /光束点缀未布防/);
  assert.match(appSource, /invoke\("titan_update_beam"/);
  assert.match(appSource, /invoke\("titan_run_beam_show"/);
  assert.match(appSource, /shutterOpen:false/);
  assert.match(appSource, /source:"safety-off"/);
  assert.match(appSource, /rhythmEnergyAt\(analysis,rhythmEvent\.atSeconds\)/);
  assert.match(appSource, /beamShowControllerRef\.current\.next\(rhythmEvent\)/);
  assert.match(appSource, /panValue:kingclubBeamProfile\.fixedPanValue/);
  assert.match(appSource, /tiltValue:kingclubBeamProfile\.fixedTiltValue/);
  assert.match(appSource, /new CustomEvent\("king:beam-cue"/);
});

test("PGM colour sampling reacts quickly without accepting one-frame colour noise", () => {
  assert.match(appSource, /window\.setInterval\(sample,400\)/);
  assert.match(appSource, /tracker\.sample\(event\.detail\.family\)/);
  assert.match(appSource, /tracker\.complete\(ticket,triggered\)/);
});
