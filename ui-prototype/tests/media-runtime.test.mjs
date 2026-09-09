import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOMPANIMENT_GAIN_DB,
  AUTO_DJ_CROSSFADE_SECONDS,
  AUTO_DJ_PRELOAD_SECONDS,
  deckOutputVolumePercent,
  deckOutputVolumeScalar,
  describeReadyStemProgress,
  equalPowerGains,
  formatDuration,
  getAdjacentPlayableTrack,
  getAdjacentPlayableTrackInQueue,
  getNextPlayableTrack,
  getNextPlayableTrackInQueue,
  isPlayableVideoSource,
  mediaAssetFingerprint,
  parseDuration,
  planDeckAutoTransition,
  planDeckOperatorArbitration,
  resolvePlaybackChainForDeck,
  resetDeckVocalModeForTrackChange,
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

test("accompaniment switching is level-neutral",()=>{
  assert.equal(ACCOMPANIMENT_GAIN_DB,0);
  assert.equal(deckOutputVolumePercent(0.5,80,"original"),40);
  assert.equal(deckOutputVolumePercent(0.5,80,"accompaniment"),40);
  assert.equal(deckOutputVolumePercent(1,100,"accompaniment"),100);
  assert.equal(deckOutputVolumeScalar(1,100,"accompaniment"),1);
});

test("loading another track resets only that Deck to original",()=>{
  const modes={1:"accompaniment",2:"accompaniment"};
  assert.deepEqual(resetDeckVocalModeForTrackChange(modes,1),{1:"original",2:"accompaniment"});
  assert.deepEqual(resetDeckVocalModeForTrackChange(modes,2),{1:"accompaniment",2:"original"});
  const original={1:"original",2:"accompaniment"};
  assert.equal(resetDeckVocalModeForTrackChange(original,1),original);
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

test("playlist playback follows L-region order instead of complete-library indexes",()=>{
  const queue=[126,169,729];
  assert.equal(getNextPlayableTrackInQueue(queue,126,-1,false),169);
  assert.equal(getNextPlayableTrackInQueue(queue,126,169,false),729);
  assert.equal(getNextPlayableTrackInQueue(queue,729,-1,false),126);
  assert.equal(getNextPlayableTrackInQueue([126],126,-1,false),null);
  assert.equal(getAdjacentPlayableTrackInQueue(queue,169,-1,-1),126);
  assert.equal(getAdjacentPlayableTrackInQueue(queue,169,126,1),729);
});

test("deleting an on-air playlist item captures its successor before removal",()=>{
  const queueBeforeRemoval=[126,169,729];
  assert.equal(getNextPlayableTrackInQueue(queueBeforeRemoval,169,-1,false),729);
  assert.equal(getNextPlayableTrackInQueue(queueBeforeRemoval,729,-1,false),126);
  assert.equal(getNextPlayableTrackInQueue([169],169,-1,false),null);
});

test("automatic DJ transition preloads and crossfades the next source-playlist song",()=>{
  const queue=[126,169,729];
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:126,mode:"sequence",remainingSeconds:AUTO_DJ_PRELOAD_SECONDS+1}),{action:"wait",nextIndex:169});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:126,mode:"sequence",remainingSeconds:AUTO_DJ_PRELOAD_SECONDS}),{action:"preload",nextIndex:169});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:126,mode:"sequence",remainingSeconds:AUTO_DJ_CROSSFADE_SECONDS,preparedTargetIndex:169}),{action:"crossfade",nextIndex:169});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:729,mode:"sequence",remainingSeconds:AUTO_DJ_PRELOAD_SECONDS}),{action:"preload",nextIndex:126});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:729,mode:"sequence",remainingSeconds:AUTO_DJ_CROSSFADE_SECONDS,preparedTargetIndex:126}),{action:"crossfade",nextIndex:126});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:126,mode:"repeat-one",remainingSeconds:1}),{action:"none",nextIndex:null});
  assert.deepEqual(planDeckAutoTransition({queue,currentIndex:126,mode:"sequence",remainingSeconds:1,otherDeckPlaying:true}),{action:"none",nextIndex:null});
});

test("automatic DJ keeps the chain that owns the playing track when Deck queue state diverges",()=>{
  const afro={kind:"playlist",libraryKey:"2",playlistId:"playlist:七夕"};
  const weekday={kind:"playlist",libraryKey:"2",playlistId:"playlist:周四"};
  const resolved=resolvePlaybackChainForDeck({
    deckNumber:2,
    currentIndex:487,
    queueSources:{1:afro,2:weekday},
    queueIndexes:{1:[486,487,488],2:[0,1,2]},
  });
  assert.deepEqual(resolved,{ownerDeck:1,source:afro,queue:[486,487,488]});
  assert.deepEqual(
    planDeckAutoTransition({
      queue:resolved.queue,
      currentIndex:487,
      mode:"sequence",
      remainingSeconds:AUTO_DJ_PRELOAD_SECONDS,
    }),
    {action:"preload",nextIndex:488},
  );
});

test("automatic DJ fails closed instead of jumping to an unrelated list",()=>{
  assert.deepEqual(resolvePlaybackChainForDeck({
    deckNumber:2,
    currentIndex:99,
    queueSources:{1:{kind:"playlist"},2:{kind:"playlist"}},
    queueIndexes:{1:[1,2],2:[3,4]},
  }),{ownerDeck:null,source:null,queue:[]});
});

test("operator arbitration keeps playing or target-CUE Decks independent",()=>{
  assert.deepEqual(
    planDeckOperatorArbitration({mode:"sequence",targetDeck:2}),
    {automationAllowed:true,eofAction:"continue-source",reason:"automatic"},
  );
  assert.deepEqual(
    planDeckOperatorArbitration({mode:"sequence",targetDeck:2,cueDeck:1}),
    {automationAllowed:true,eofAction:"continue-source",reason:"automatic"},
  );
  assert.deepEqual(
    planDeckOperatorArbitration({mode:"sequence",targetDeck:2,targetPlaying:true,cueDeck:2}),
    {automationAllowed:false,eofAction:"continue-source",reason:"cue-occupied"},
  );
  assert.deepEqual(
    planDeckOperatorArbitration({mode:"sequence",targetDeck:2,targetPlaying:true,cueDeck:null}),
    {automationAllowed:false,eofAction:"continue-source",reason:"operator-independent-playback"},
  );
});

test("completed stems become usable before reference analysis finishes",()=>{
  assert.deepEqual(
    describeReadyStemProgress(true,{status:"running",stage:"analyzing-reference"}),
    {label:"伴奏可用 · 缺少歌词",taskLabel:"AI 补音参考制作中",actionLabel:"伴奏可用"},
  );
  assert.deepEqual(
    describeReadyStemProgress(true,{status:"running",stage:"transcribing"}),
    {label:"伴奏可用 · 缺少歌词",taskLabel:"AI 歌词分析中",actionLabel:"伴奏可用"},
  );
  assert.deepEqual(
    describeReadyStemProgress(true,{status:"ready",stage:"complete"}),
    {label:"伴奏可用 · 缺少歌词",taskLabel:"AI 分析已完成",actionLabel:"已完成"},
  );
  assert.equal(describeReadyStemProgress(false,{status:"running",stage:"separating-high-quality"}),null);
});

test("imported lyrics and backing remain available after an earlier AI transcript failure",()=>{
  const job={status:"failed",errorMessage:"MOSS-Music did not return the requested JSON transcript"};
  assert.deepEqual(describeReadyStemProgress(true,job,{lyricsAvailable:true,workerEnabled:false}),{
    label:"伴奏、歌词可用",taskLabel:"上次 AI 分析：歌词识别失败",actionLabel:null,
  });
  assert.equal(job.status,"failed");
  assert.equal(describeReadyStemProgress(true,job,{lyricsAvailable:false}).label,"伴奏可用 · 缺少歌词");
  assert.equal(describeReadyStemProgress(false,job,{lyricsAvailable:true}),null);
  assert.equal(describeReadyStemProgress(true,{status:"queued"},{lyricsAvailable:true,workerEnabled:false}).taskLabel,"AI 制作已关闭，排队任务未执行");
});
