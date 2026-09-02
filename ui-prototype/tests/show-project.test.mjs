import test from "node:test";
import assert from "node:assert/strict";
import {
  SHOW_PROJECT_FORMAT,
  addAssetToShowTrack,
  createDefaultShowProject,
  findShowClip,
  moveShowClip,
  normalizeShowProject,
  removeShowClip,
  showProjectStorageKey,
  updateShowClip,
} from "../src/show-project.js";

test("default show project owns seven typed tracks",()=>{
  const project=createDefaultShowProject("song-a",300);
  assert.equal(project.format,SHOW_PROJECT_FORMAT);
  assert.deepEqual(project.tracks.map(track=>track.id),["markers","audio","v1","v2","image","text","light"]);
  assert.equal(project.tracks.find(track=>track.id==="audio").locked,true);
});

test("song storage key is stable and isolated",()=>{
  assert.equal(showProjectStorageKey({path:"A:/music/song.mp3"}),showProjectStorageKey({path:"A:/music/song.mp3"}));
  assert.notEqual(showProjectStorageKey({path:"A:/music/song.mp3"}),showProjectStorageKey({path:"A:/music/other.mp3"}));
});

test("clip trim is clamped to legal source and project duration",()=>{
  const project=createDefaultShowProject("song-a",120);
  const original=project.tracks.find(track=>track.id==="v1").clips[0];
  const updated=updateShowClip(project,"v1",original.id,{sourceIn:40,sourceOut:20,timelineDuration:999});
  const clip=findShowClip(updated,"v1",original.id).clip;
  assert.ok(clip.sourceOut>clip.sourceIn);
  assert.equal(clip.timelineDuration,120);
});

test("video clips can move between V1 and V2 but not into text",()=>{
  const project=createDefaultShowProject("song-a",300);
  const clip=project.tracks.find(track=>track.id==="v1").clips[0];
  const moved=moveShowClip(project,"v1","v2",clip.id,1);
  assert.equal(findShowClip(moved,"v2",clip.id).clip.id,clip.id);
  assert.equal(moveShowClip(moved,"v2","text",clip.id,0),moved);
});

test("assets append only to compatible tracks and receive stable ids",()=>{
  const project=createDefaultShowProject("song-a",300);
  const added=addAssetToShowTrack(project,"v1",{id:"video-1",type:"VIDEO",name:"开场视频",durationSeconds:12});
  assert.equal(added.nextClipId,101);
  assert.equal(added.tracks.find(track=>track.id==="v1").clips.at(-1).assetId,"video-1");
  assert.equal(addAssetToShowTrack(added,"text",{id:"video-2",type:"VIDEO",name:"错误轨道"}),added);
});

test("locked audio clip cannot move or be removed",()=>{
  const project=createDefaultShowProject("song-a",300);
  const clip=project.tracks.find(track=>track.id==="audio").clips[0];
  assert.equal(moveShowClip(project,"audio","audio",clip.id,0),project);
  assert.equal(removeShowClip(project,"audio",clip.id),project);
});

test("malformed persisted projects fall back safely",()=>{
  const fallback=normalizeShowProject({format:"wrong",version:99},"song-b",240);
  assert.equal(fallback.songKey,"song-b");
  assert.equal(fallback.durationSeconds,240);
  assert.equal(fallback.tracks.length,7);
});
