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

test("turns a legacy paragraph timestamp into advancing display phrases",()=>{
  const paragraph="第一句应该单独显示，第二句也要跟着音乐。第三句不能挤在同一个画面里！还要继续显示下一句。";
  const lines=parseLrc(`[00:10.00]${paragraph}\n[00:50.00]正常下一句`);
  assert.ok(lines.length>2);
  assert.notEqual(lyricAtTime(lines,12).current.text,lyricAtTime(lines,35).current.text);
  assert.equal(lyricAtTime(lines,50).current.text,"正常下一句");
});

test("splits a long Korean phrase before it can wrap over adjacent lyric rows",()=>{
  const phrase="너를 비참을 드는 향기 익숙함에 미참 몰랐지 뜨거운 여름의 끝자락 또다시 설렘 이 번져와 네 어깨 뒤로 일렁이는 추억들 무비다";
  const lines=parseLrc(`[00:27.69]${phrase}\n[00:44.12]다음 가사`);
  assert.ok(lines.length>2);
  assert.ok(lines.slice(0,-1).every((line)=>line.text.length<=28));
  assert.notEqual(lyricAtTime(lines,29).current.text,lyricAtTime(lines,40).current.text);
});

test("prefers a playing audible deck and falls back to a paused loaded deck",()=>{
  assert.equal(selectLyricsDeck({playingDecks:{1:true,2:true},enabledDecks:{1:true,2:true},availableDecks:{1:true,2:true},crossfade:70}),2);
  assert.equal(selectLyricsDeck({playingDecks:{1:false,2:true},enabledDecks:{1:true,2:true},availableDecks:{1:true,2:true},crossfade:10}),2);
  assert.equal(selectLyricsDeck({playingDecks:{1:false,2:false},enabledDecks:{1:true,2:false},availableDecks:{1:true,2:true},crossfade:80}),1);
});

test("does not leak lyrics from the other deck when the playing deck lyrics are disabled",()=>{
  assert.equal(selectLyricsDeck({
    playingDecks:{1:false,2:true},
    enabledDecks:{1:true,2:false},
    availableDecks:{1:true,2:true},
    crossfade:100,
  }),null);
});
