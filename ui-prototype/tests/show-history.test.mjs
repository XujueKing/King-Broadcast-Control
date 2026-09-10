import test from 'node:test';
import assert from 'node:assert/strict';
import {recordShowHistory,stepShowHistory} from '../src/show-editor-runtime.js';
test('undo and redo preserve projects; a new edit invalidates the redo stack',()=>{
 const a={clips:[]},b={clips:['video']},c={clips:['text']};
 let history=recordShowHistory({past:[],future:[]},a);
 const undo=stepShowHistory(history,b,'undo');assert.equal(undo.project,a);
 const redo=stepShowHistory(undo.history,a,'redo');assert.equal(redo.project,b);
 history=recordShowHistory(undo.history,a);
 assert.equal(stepShowHistory(history,c,'redo'),null);
 assert.equal(stepShowHistory(history,c,'undo').project,a);
 for(let i=0;i<120;i++)history=recordShowHistory(history,{i});
 assert.equal(history.past.length,100);
});
