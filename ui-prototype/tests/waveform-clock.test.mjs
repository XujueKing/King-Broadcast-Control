import test from 'node:test';
import assert from 'node:assert/strict';
import {createWaveformClock} from '../src/waveform-clock.js';
test('waveform continues moving between 480ms player updates without the old 240ms stop',()=>{
 const c=createWaveformClock();c.update({seconds:10,playing:true,duration:300},0);
 assert.equal(c.read(240),10.24);assert.equal(c.read(400),10.4);
 c.update({seconds:10.48,playing:true,duration:300},480);
 assert.equal(c.read(800),10.8);
});
test('pause and seek snap to truth; missing updates freeze after one second',()=>{
 const c=createWaveformClock();c.update({seconds:10,playing:true,duration:300},0);
 assert.equal(c.read(2000),11);assert.equal(c.read(5000),11);
 c.update({seconds:10.5,playing:false,duration:300},5100);assert.equal(c.read(9000),10.5);
 c.update({seconds:100,playing:true,duration:300,seeking:true},9100);assert.equal(c.read(9500),100);
 c.update({seconds:299.9,playing:true,duration:300},9600);assert.equal(c.read(10000),300);
});
