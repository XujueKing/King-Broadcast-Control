import test from "node:test";
import assert from "node:assert/strict";
import { lyricAtTime, parseLrc, selectLyricsDeck } from "../src/lyrics-runtime.js";

test("parses multiple LRC timestamps and millisecond offset",()=>{
  const lines=parseLrc("[offset:100]\n[00:01.50][00:03.250]第一句\n[00:05]第二句");
  assert.deepEqual(lines.map((line)=>[line.atSeconds,line.text]),[[1.6,"第一句"],[3.35,"第一句"],[5.1,"第二句"]]);
});

test("selects the current lyric by real playback time",()=>{
  const lines=parseLrc("[00:01.00]A\n[00:02.00]B");
  assert.equal(lyricAtTime(lines,.9),null);
  assert.equal(lyricAtTime(lines,1.75).current.text,"A");
  assert.equal(lyricAtTime(lines,2).current.text,"B");
});

test("prefers a playing audible deck and falls back to a paused loaded deck",()=>{
  assert.equal(selectLyricsDeck({playingDecks:{1:true,2:true},enabledDecks:{1:true,2:true},availableDecks:{1:true,2:true},crossfade:70}),2);
  assert.equal(selectLyricsDeck({playingDecks:{1:false,2:true},enabledDecks:{1:true,2:true},availableDecks:{1:true,2:true},crossfade:10}),2);
  assert.equal(selectLyricsDeck({playingDecks:{1:false,2:false},enabledDecks:{1:true,2:false},availableDecks:{1:true,2:true},crossfade:80}),1);
});
