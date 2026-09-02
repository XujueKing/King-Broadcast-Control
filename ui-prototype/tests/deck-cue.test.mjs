import test from "node:test";
import assert from "node:assert/strict";
import {
  DECK_CUE_RECOVERY_STORAGE_KEY,
  clearDeckCueRecovery,
  deckCueMix,
  deckRescuePreviewPlans,
  loadDeckCueRecovery,
  normalizeDeckCueRecovery,
  persistDeckCueRecovery,
  qu16DeckCueWrites,
  qu16WritesConfirmed,
} from "../src/deck-cue.js";

function memoryStorage() {
  const values=new Map();
  return {
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key),
    values,
  };
}

test("Qu-16 CUE routes the complete ST3 Deck mix without changing either fader",()=>{
  assert.deepEqual(qu16DeckCueWrites(true),[
    {key:"assign:st-3:LR",value:0},
    {key:"pafl:st-3",value:1},
  ]);
  assert.deepEqual(qu16DeckCueWrites(false,1),[
    {key:"pafl:st-3",value:0},
    {key:"assign:st-3:LR",value:1},
  ]);
  assert.throws(()=>qu16DeckCueWrites(false),/LR Assign 真值/);
});

test("CUE waits for authoritative matching Qu-16 readback",()=>{
  const writes=qu16DeckCueWrites(true);
  const snapshot={
    connected:true,
    synced:true,
    parameters:{"assign:st-3:LR":0,"pafl:st-3":1},
    pendingDetails:{},
  };
  assert.equal(qu16WritesConfirmed(snapshot,writes),true);
  assert.equal(qu16WritesConfirmed({...snapshot,pendingDetails:{"pafl:st-3":{state:"awaiting-readback"}}},writes),false);
  assert.equal(qu16WritesConfirmed({...snapshot,parameters:{...snapshot.parameters,"pafl:st-3":0}},writes),false);
  assert.equal(qu16WritesConfirmed({...snapshot,connected:false},writes),false);
});

test("CUE is pre-crossfader and isolates the selected deck at headphone level",()=>{
  assert.deepEqual(deckCueMix(100,90,24,1),{
    deck1Gain:1,
    deck2Gain:0,
    outputVolume:24,
  });
  assert.deepEqual(deckCueMix(0,90,31,2),{
    deck1Gain:0,
    deck2Gain:1,
    outputVolume:31,
  });
});

test("normal playback still uses equal-power crossfade and master volume",()=>{
  const mix=deckCueMix(50,72,25,null);
  assert.ok(Math.abs(mix.deck1Gain-Math.SQRT1_2)<1e-12);
  assert.ok(Math.abs(mix.deck2Gain-Math.SQRT1_2)<1e-12);
  assert.equal(mix.outputVolume,72);
});

test("both ready Deck rescue layers survive a live crossfade",()=>{
  const plans=deckRescuePreviewPlans({
    crossfade:50,
    masterVolume:80,
    headphoneVolume:25,
    cueDeck:null,
    playingDecks:{1:true,2:true},
    vocalModes:{1:"accompaniment",2:"accompaniment"},
    rescueEnabled:{1:true,2:true},
    referenceStatus:{
      1:{ready:true,bound:true,referenceVocalPath:"deck-1.flac"},
      2:{ready:true,bound:false,referenceVocalPath:"deck-2.flac"},
    },
    physicalAudioStarted:false,
  });
  assert.deepEqual(plans.map(({deck,path,enabled,playing})=>({deck,path,enabled,playing})),[
    {deck:1,path:"deck-1.flac",enabled:true,playing:true},
    {deck:2,path:"deck-2.flac",enabled:true,playing:true},
  ]);
  assert.ok(plans[0].volume>0);
  assert.ok(plans[1].volume>0);
});

test("CUE carries the selected Deck's complete rescue layer and isolates the other",()=>{
  const plans=deckRescuePreviewPlans({
    crossfade:100,
    masterVolume:90,
    headphoneVolume:24,
    cueDeck:1,
    playingDecks:{1:true,2:true},
    vocalModes:{1:"accompaniment",2:"accompaniment"},
    rescueEnabled:{1:true,2:true},
    referenceStatus:{
      1:{ready:true,referenceVocalPath:"deck-1.flac"},
      2:{ready:true,referenceVocalPath:"deck-2.flac"},
    },
    physicalAudioStarted:false,
  });
  // CUE follows the selected Deck's headphone level exactly. Accompaniment and
  // rescue playback must not reintroduce the retired +4 dB mode boost.
  assert.equal(plans[0].volume,24);
  assert.equal(plans[1].volume,0);
  assert.equal(plans[0].playing,true);
});

test("physical Vocal Engine output disables duplicate local rescue players",()=>{
  const plans=deckRescuePreviewPlans({
    crossfade:50,
    masterVolume:100,
    headphoneVolume:50,
    cueDeck:null,
    playingDecks:{1:true,2:true},
    vocalModes:{1:"accompaniment",2:"accompaniment"},
    rescueEnabled:{1:true,2:true},
    referenceStatus:{
      1:{ready:true,referenceVocalPath:"deck-1.flac"},
      2:{ready:true,referenceVocalPath:"deck-2.flac"},
    },
    physicalAudioStarted:true,
  });
  assert.deepEqual(plans.map(({enabled,playing,volume})=>({enabled,playing,volume})),[
    {enabled:false,playing:false,volume:0},
    {enabled:false,playing:false,volume:0},
  ]);
});

test("CUE recovery survives a renderer restart until LR Assign is explicitly restored",()=>{
  const storage=memoryStorage();
  assert.equal(loadDeckCueRecovery(storage),null);
  assert.equal(persistDeckCueRecovery({deck:1,mainAssigned:1},storage),true);
  assert.deepEqual(loadDeckCueRecovery(storage),{deck:1,mainAssigned:1});

  assert.equal(persistDeckCueRecovery({deck:2,mainAssigned:1},storage),true);
  assert.deepEqual(loadDeckCueRecovery(storage),{deck:2,mainAssigned:1});
  assert.equal(clearDeckCueRecovery(storage),true);
  assert.equal(storage.values.has(DECK_CUE_RECOVERY_STORAGE_KEY),false);
  assert.equal(loadDeckCueRecovery(storage),null);
});

test("CUE recovery rejects malformed or unsafe persisted state",()=>{
  assert.equal(normalizeDeckCueRecovery({deck:3,mainAssigned:1}),null);
  assert.equal(normalizeDeckCueRecovery({deck:1,mainAssigned:true}),null);
  assert.equal(normalizeDeckCueRecovery({deck:1}),null);
  assert.equal(normalizeDeckCueRecovery({deck:"1",mainAssigned:1}),null);
  assert.equal(normalizeDeckCueRecovery({deck:1,mainAssigned:2}),null);
  assert.deepEqual(normalizeDeckCueRecovery({deck:1,mainAssigned:0}),{deck:1,mainAssigned:0});
});
