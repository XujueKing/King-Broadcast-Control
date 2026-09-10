import test from 'node:test';
import assert from 'node:assert/strict';
import {singerCompletionBookmark,SingerInterlude,singerPlaylistKey,singerPlaylistSource,singerReturnPlan} from '../src/singer-library.js';
import {executeSingerOperation} from '../src/singer-playback.js';

test('temporary replacements keep the first bookmark; EOF is claimed once',()=>{
 const session=new SingerInterlude(),original={songKey:'original',seconds:42,pitch:2,source:{kind:'playlist',libraryKey:'2',playlistId:'singer'}};
 session.begin(1,original,'extra-a');session.begin(1,null,'extra-b');
 assert.equal(session.claim(1,'extra-a'),null);
 const claimed=session.claim(1,'extra-b');assert.deepEqual(claimed.original,original);
 assert.equal(session.claim(1,'extra-b'),null);
 assert.equal(session.complete(1,claimed),true);assert.equal(session.complete(1,claimed),false);
 assert.equal(session.revisions[1],1);assert.equal(session.entries[1],undefined);
});
test('operator cancellation and deck isolation reject late EOF completion',()=>{
 const session=new SingerInterlude();session.begin(1,{songKey:'a'},'b');session.begin(2,{songKey:'c'},'d');
 const entry=session.claim(1,'b');session.cancel(1);assert.equal(session.complete(1,entry),false);
 assert.equal(session.revisions[1],0);assert.ok(session.claim(2,'d'));
});
test('playlist selection checks stable identity and membership, preserving order',()=>{
 const libraries={libraries:{'2':{playlists:[{id:'singer',trackPaths:['b','a']}]}}};
 const source=singerPlaylistSource(libraries,'2:singer','a');assert.equal(singerPlaylistKey(source),'2:singer');
 assert.throws(()=>singerPlaylistSource(libraries,'2:singer','unknown'),/song_not_in_playlist/);
 assert.throws(()=>singerPlaylistSource(libraries,'1:singer','a'),/playlist_not_found/);
});
test('pitch bounds and actual completion are enforced before acknowledging control',async()=>{
 const calls=[];const context={ready:()=>true,cueActive:()=>false,transitionBusy:()=>false,otherPlaying:()=>false,hasTrack:()=>true,setPitch:async(...v)=>calls.push(v)};
const work=semitones=>({deck:1,command:{operation:{type:'pitch',semitones}}});
 for(const invalid of [-7,7,1.1,NaN])await assert.rejects(executeSingerOperation(work(invalid),context),/invalid_pitch/);
 assert.deepEqual(calls,[]);await executeSingerOperation(work(-2),context);assert.deepEqual(calls,[[1,-2]]);
 context.setPitch=async()=>{throw Error('pitch_readback_failed')};await assert.rejects(executeSingerOperation(work(2),context),/pitch_readback_failed/);
});

test('automatic return chooses the next available song in the bookmarked playlist only',()=>{
 const original={songKey:'a',seconds:42,pitch:2,vocalMode:'accompaniment',source:{kind:'playlist',libraryKey:'2',playlistId:'singer'}};
 const libraries={libraries:{'2':{playlists:[{id:'singer',trackPaths:['a','missing','b','c']}]}}};
 const tracks=[{path:'c'},{path:'a'},{path:'b'}];
 assert.deepEqual(singerReturnPlan(original,libraries,tracks,true),{index:2,seconds:0,autoplay:true,vocalMode:'original',pitch:0});
 assert.deepEqual(singerReturnPlan(original,libraries,tracks,false),{index:1,seconds:42,autoplay:false,vocalMode:'accompaniment',pitch:2});
 assert.equal(singerReturnPlan({...original,songKey:'c'},libraries,tracks,true).autoplay,false);
 assert.throws(()=>singerReturnPlan(original,{libraries:{}},tracks,true),/return_playlist_unavailable/);
});

test('auto return switch confirms persistence without starting playback',async()=>{
 const calls=[];
 const context={ready:()=>true,cueActive:()=>false,setAutoReturnNext:async v=>calls.push(v)};
 await executeSingerOperation({deck:1,command:{operation:{type:'auto_return_next',enabled:true}}},context);
 assert.deepEqual(calls,[true]);
 await assert.rejects(executeSingerOperation({deck:1,command:{operation:{type:'auto_return_next',enabled:1}}},context),/invalid_auto_return/);
});


test('direct playlist singer EOF continues the source playlist when enabled',()=>{
 const input={enabled:true,deck:1,singerDeck:1,mode:'single',songKey:'a',source:{kind:'playlist',libraryKey:'2',playlistId:'singer'},seconds:251,vocalMode:'accompaniment',pitch:2};
 const bookmark=singerCompletionBookmark(input);
 const libraries={libraries:{'2':{playlists:[{id:'singer',trackPaths:['a','b']}]}}};
 assert.deepEqual(singerReturnPlan(bookmark,libraries,[{path:'a'},{path:'b'}],true),{index:1,seconds:0,autoplay:true,vocalMode:'original',pitch:0});
 for(const override of [{enabled:false},{deck:2},{mode:'sequence'},{mode:'repeat-one'},{source:null}])assert.equal(singerCompletionBookmark({...input,...override}),null);
});
