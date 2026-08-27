import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOMPANIMENT_GAIN_DB,
  deckOutputVolumePercent,
  deckOutputVolumeScalar,
  equalPowerGains,
  formatDuration,
  getAdjacentPlayableTrack,
  getNextPlayableTrack,
  isPlayableVideoSource,
  mediaAssetFingerprint,
  parseDuration,
} from "../src/media-runtime.js";

test("duration formatting supports long club sets",()=>{
  assert.equal(parseDuration("01:02:03"),3723);
  assert.equal(formatDuration(3723),"01:02:03");
  assert.equal(formatDuration(222),"03:42");
});

test("only WebView2-compatible first-phase video containers enter the player",()=>{
  assert.equal(isPlayableVideoSource("asset://localhost/media/show.MP4"),true);
  assert.equal(isPlayableVideoSource("asset://localhost/media/show.webm?rev=2"),true);
  assert.equal(isPlayableVideoSource("asset://localhost/media/show.png"),false);
  assert.equal(isPlayableVideoSource("asset://localhost/media/show.avi"),false);
});

test("crossfader uses equal-power gains",()=>{
  assert.deepEqual(equalPowerGains(0),{deck1:1,deck2:0});
  const middle=equalPowerGains(50);
  assert.ok(Math.abs(middle.deck1-Math.SQRT1_2)<1e-12);
  assert.ok(Math.abs(middle.deck2-Math.SQRT1_2)<1e-12);
  assert.ok(Math.abs(equalPowerGains(100).deck2-1)<1e-12);
});

test("accompaniment mode applies a capped per-deck gain without changing original mode",()=>{
  assert.equal(ACCOMPANIMENT_GAIN_DB,4);
  assert.equal(deckOutputVolumePercent(0.5,80,"original"),40);
  assert.ok(Math.abs(deckOutputVolumePercent(0.5,80,"accompaniment")-63.39572769844454)<1e-9);
  assert.equal(deckOutputVolumePercent(1,100,"accompaniment"),100);
  assert.equal(deckOutputVolumeScalar(1,100,"accompaniment"),1);
});

test("sequence and shuffle never select the other loaded Deck",()=>{
  assert.equal(getNextPlayableTrack(4,0,1,false),2);
  assert.equal(getNextPlayableTrack(1,0,0,false),null);
  assert.equal(getNextPlayableTrack(4,0,1,true,()=>0),2);
});

test("manual previous and next loading skips the song in the other Deck",()=>{
  assert.equal(getAdjacentPlayableTrack(5,2,3,1),4);
  assert.equal(getAdjacentPlayableTrack(5,2,1,-1),0);
  assert.equal(getAdjacentPlayableTrack(1,0,0,1),null);
});

test("media fingerprint changes when metadata changes",()=>{
  const initial=[{path:"song.mp3",modifiedUnixMs:1,sizeBytes:10,durationMs:1000,title:"A"}];
  const changed=[{...initial[0],title:"B"}];
  assert.notEqual(mediaAssetFingerprint(initial),mediaAssetFingerprint(changed));
});
