import { test } from "node:test";
import assert from "node:assert/strict";
import { captureVideoQueue, nextProgramVideo } from "../src/video-playback.js";

const videos = [
  { id:"a", category:"舞台", src:"a.mp4" },
  { id:"b", category:"舞台", src:"b.mp4" },
  { id:"c", category:"氛围", src:"c.mp4" },
];
const state = { mode:"sequence", mediaId:"a", token:1, queueIds:captureVideoQueue(videos,"舞台","a") };
const ended = { mediaId:"a", token:1 };
test("defaults to folder sequence and wraps the last item", () => {
  assert.deepEqual(state.queueIds,["a","b"]);
  assert.equal(nextProgramVideo(state,ended,videos).id,"b");
  assert.equal(nextProgramVideo({...state,mediaId:"b"},{...ended,mediaId:"b"},videos).id,"a");
});
test("browsing another folder and rescanning never add to a captured queue", () => {
  assert.equal(nextProgramVideo(state,ended,[...videos,{id:"d",src:"d.mp4",category:"舞台"}]).id,"b");
  assert.deepEqual(captureVideoQueue(videos,"氛围","a"),["a","b"]);
});
test("late or duplicate EOF and single-clip loop do not advance", () => {
  assert.equal(nextProgramVideo({...state,token:2},ended,videos),null);
  assert.equal(nextProgramVideo({...state,mediaId:"b"},ended,videos),null);
  assert.equal(nextProgramVideo({...state,mode:"single"},ended,videos),null);
});
test("deleted files are skipped; one remaining item repeats; an empty queue stops", () => {
  assert.equal(nextProgramVideo(state,ended,[videos[0]]).id,"a");
  assert.equal(nextProgramVideo(state,ended,[videos[1]]).id,"b");
  assert.equal(nextProgramVideo(state,ended,[]),null);
});
test("all videos follows catalog order, without duplicates", () => {
  assert.deepEqual(captureVideoQueue([...videos,videos[0]],"全部","a"),["a","b","c"]);
});
