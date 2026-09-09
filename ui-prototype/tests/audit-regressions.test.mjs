import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLightingSession,rhythmPulsePayload,createVideoColorTracker} from '../src/lighting-session.js';
import {createLatestOnlyAsyncQueue,gatlingPulseForRhythm,kingclubGatlingProfile} from '../src/gatling-runtime.js';
import {createDefaultShowProject,updateShowClip,findShowClip,addAssetToShowTrack} from '../src/show-project.js';
import {saveShowProject,clipAtTime,clipSourceTime,advancePreviewClock,readProgramClockSnapshot} from '../src/show-editor-runtime.js';

test('paused, resumed and replaced lighting sessions reject old queued work',async()=>{
  const session=createLightingSession(1);session.update('auto',true);
  const queue=createLatestOnlyAsyncQueue();let release;let sends=0;
  const blocked=new Promise(resolve=>{release=resolve;});
  const old=session.capture();
  const work=queue.push(async()=>{await blocked;if(!session.isCurrent(old))return false;sends++;return true;});
  const pending=queue.push(async()=>{if(!session.isCurrent(old))return false;sends++;return true;});
  session.update('auto',false);queue.cancelPending();session.update('auto',true);
  release();assert.equal(await work,false);assert.equal(await pending,false);assert.equal(sends,0);
  const fresh=session.capture();assert.equal(session.isCurrent(fresh),true);
  session.update('manual',true);assert.equal(session.isCurrent(fresh),false);
});

test('80 BPM speed survives into the actual pulse invocation arguments',()=>{
  const pulse=gatlingPulseForRhythm({bpm:80,beatIndex:0,isBar:true,energy:.5});
  const payload=rhythmPulsePayload({host:'mock',expectedShowName:kingclubGatlingProfile.showName,dimmerPercent:pulse.peakDimmerPercent,speedValue:pulse.speedValue,baseDimmerPercent:4,generation:1});
  assert.equal(payload.speedValue,.18);assert.equal(payload.pulseMillis,70);
});

test('failed or superseded colour updates retry and cannot publish stale success',()=>{
  const tracker=createVideoColorTracker();const blue=tracker.sample('blue');
  assert.equal(tracker.sample('blue'),null);
  assert.equal(tracker.complete(blue,false),false);
  const retry=tracker.sample('blue');assert.ok(retry);
  const red=tracker.sample('red');assert.ok(red);
  assert.equal(tracker.complete(retry,true),false);assert.equal(tracker.complete(red,true),true);
  assert.equal(tracker.sample('red'),null);
  tracker.reset();assert.ok(tracker.sample('red'));
});

test('failed storage writes remain unsaved and a later successful retry is persisted',()=>{
  const project=createDefaultShowProject('a',342);
  const failed=saveShowProject({setItem(){throw new Error('QuotaExceededError');}},'a',project);
  assert.equal(failed.ok,false);assert.equal(failed.project,project);assert.match(failed.error,/QuotaExceededError/);
  let stored;
  const success=saveShowProject({setItem(key,value){stored=JSON.parse(value);}},'a',project,123);
  assert.equal(success.ok,true);assert.equal(stored.updatedAt,123);
});

test('source endpoints remain valid at the end of a shorter asset and after duration correction',()=>{
  const project=addAssetToShowTrack(createDefaultShowProject('a',342),'v1',{id:'local',type:'VIDEO',durationSeconds:12,path:'C:/video.mp4'});
  const id=project.tracks.find(lane=>lane.id==='v1').clips.at(-1).id;
  const result=updateShowClip(project,'v1',id,{sourceIn:342,sourceOut:342});
  const {clip}=findShowClip(result,'v1',id);
  assert.equal(clip.sourceOut,12);assert.ok(clip.sourceIn<clip.sourceOut);
  assert.equal(clip.sourcePath,'C:/video.mp4');
  const corrected=findShowClip(updateShowClip(result,'v1',id,{sourceDuration:3}),'v1',id).clip;
  assert.equal(corrected.sourceOut,3);assert.ok(corrected.sourceIn<3);
});

test('preview advances, loops inside the source range and stops at project end',()=>{
  const clip={sourceIn:2,sourceOut:5,loopMode:'循环到歌曲结束',timelineDuration:10,repeatCount:1};
  assert.deepEqual(advancePreviewClock(10,2,30),{seconds:12,playing:true});
  assert.deepEqual(advancePreviewClock(29,3,30),{seconds:30,playing:false});
  assert.equal(clipSourceTime(clip,4),3);
  assert.equal(clipSourceTime({...clip,loopMode:'精确裁切'},4),null);
  assert.equal(clipAtTime({clips:[clip]},11,30),null);
});

test('program monitor follows the output clock and rejects stale media or seek generations',()=>{
  const snapshot={mediaId:'v1',token:2,seconds:50,playing:true,receivedAt:1000};
  assert.deepEqual(readProgramClockSnapshot(snapshot,{mediaId:'v1',token:2},1250),{seconds:50.25,playing:true});
  assert.equal(readProgramClockSnapshot(snapshot,{mediaId:'v2',token:2},1250),null);
  assert.equal(readProgramClockSnapshot(snapshot,{mediaId:'v1',token:3},1250),null);
  assert.equal(readProgramClockSnapshot(snapshot,{mediaId:'v1',token:2},3000),null);
  assert.deepEqual(readProgramClockSnapshot({...snapshot,playing:false},{mediaId:'v1',token:2},1250),{seconds:50,playing:false});
});

test('production callbacks check render-current generation before an actual Titan invoke',()=>{
  const app=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
  for(const name of ['triggerTitanPlayback','updateGatling','runBeamShow','updateBeam']){
    const start=app.indexOf(`const ${name}=useCallback(`);
    const end=app.indexOf('\n  },[',start);
    const body=app.slice(start,end);
    const queued=body.indexOf('.then(async()=>{');
    const check=body.indexOf('lightingSessionRef.current.isCurrent(generation',queued);
    const send=body.indexOf('await invoke(',queued);
    assert.ok(queued>=0&&check>queued&&check<send,name);
  }
});
