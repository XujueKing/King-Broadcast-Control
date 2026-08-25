import test from "node:test";
import assert from "node:assert/strict";

const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";

const evaluate = (target, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error(`CDP evaluation timed out for ${target.url}`));
  }, 15000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result?.result?.value);
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error(`CDP connection failed for ${target.url}`));
  });
});

test("Tauri desktop keeps C1 active and the output WebView hidden on one display", async () => {
  const response = await fetch(`${endpoint}/json/list`);
  assert.equal(response.ok, true, `WebView debug endpoint unavailable: ${response.status}`);
  const targets = await response.json();
  const main = targets.find((target) => !/output\.html/.test(target.url) && /(?:localhost:1420\/|tauri\.localhost\/|index\.html(?:$|[?#]))/.test(target.url));
  const output = targets.find((target) => /output\.html/.test(target.url));
  assert.ok(main, "main Tauri WebView target not found");
  assert.ok(output, "output Tauri WebView target not found");

  const mainState = await evaluate(main, `(async () => ({
    visibility: document.visibilityState,
    status: document.querySelector('.system-status')?.innerText ?? '',
    footer: document.querySelector('.preview-footer')?.innerText ?? '',
    deckCount: document.querySelectorAll('.deck').length,
    mixerChannels: [...document.querySelectorAll('.mixer-channel input[type="range"]')].map((node) => node.getAttribute('aria-label')),
    mixerControlCount: document.querySelectorAll('.mixer-channel input[type="range"]').length,
    mixerStripHeight: document.querySelector('.mixer-channel-strip')?.getBoundingClientRect().height ?? 0,
    crossfaderHeight: document.querySelector('.crossfader')?.getBoundingClientRect().height ?? 0,
    microphoneColors: [1, 2].map((index) => getComputedStyle(document.querySelector('.microphone-channel-' + index + ' svg')).color),
    viewport: { width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height },
    audioEngineCount: document.querySelectorAll('.media-audio-engine audio').length,
    libraryHeader: document.querySelector('.library-panel .panel-title')?.innerText ?? '',
    bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
    viteError: document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.slice(0, 2000) ?? '',
    nativeOutputStatus: await window.__TAURI_INTERNALS__.invoke('output_window_status'),
    nativeMpvStatus: await window.__TAURI_INTERNALS__.invoke('mpv_runtime_status'),
    mixerDriverStatus: await window.__TAURI_INTERNALS__.invoke('mixer_driver_status', { modelId:'allen-heath-qu16' }),
    repeatedMixerDriverStatuses: await Promise.all(Array.from({length:8},()=>window.__TAURI_INTERNALS__.invoke('mixer_driver_status', { modelId:'allen-heath-qu16' }))),
    qu16MeterStatus: await window.__TAURI_INTERNALS__.invoke('qu16_meter_status'),
    qu16ParameterStatus: await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status'),
    qu16OfflineWriteError: await (async()=>{
      const parameters=await window.__TAURI_INTERNALS__.invoke('qu16_parameter_status');
      if(parameters.connected&&parameters.synced)return null;
      try{
        await window.__TAURI_INTERNALS__.invoke('qu16_write_parameters',{sessionId:parameters.sessionId,writes:[{key:'fader:ch-1',value:64}]});
        return 'unexpected-success';
      }catch(error){return String(error)}
    })(),
  }))()`);
  const outputState = await evaluate(output, `({
    visibility: document.visibilityState,
    hasOutputRoot: Boolean(document.querySelector('.output-window-root')),
  })`);

  if (!mainState.status) {
    console.error(JSON.stringify({ bodyText: mainState.bodyText, viteError: mainState.viteError }, null, 2));
  }

  assert.equal(mainState.visibility, "visible");
  assert.match(mainState.status, /单屏 · C1 预览/);
  assert.match(mainState.footer, /单屏模式 · C1 实时预览/);
  assert.equal(mainState.deckCount, 2);
  assert.deepEqual(mainState.mixerChannels, ["总声音大小", "耳机音量", "麦克风 1 音量", "麦克风 2 音量"]);
  assert.equal(mainState.mixerControlCount, 4);
  assert.equal(mainState.mixerStripHeight, mainState.crossfaderHeight);
  assert.notEqual(mainState.microphoneColors[0], mainState.microphoneColors[1]);
  assert.equal(mainState.viewport.width, mainState.viewport.screenWidth);
  assert.equal(mainState.viewport.height, mainState.viewport.screenHeight);
  const mixerTransition = await evaluate(main, `(async () => {
    const workspace = document.querySelector('.workspace');
    const library = document.querySelector('.library-panel');
    const center = document.querySelector('.center-column');
    const right = document.querySelector('.right-column');
    const mixer = document.querySelector('.mixer-workspace');
    const mixerButton = [...document.querySelectorAll('.bottom-nav button')].find((button) => button.textContent.includes('调音台'));
    const homeButton = [...document.querySelectorAll('.bottom-nav button')].find((button) => button.textContent.includes('首页'));
    const settingsButton = [...document.querySelectorAll('.bottom-nav button')].find((button) => button.textContent.includes('设置'));
    const rect = (node) => { const value = node.getBoundingClientRect(); return { left:value.left, right:value.right, width:value.width }; };
    const before = { center:rect(center) };
    mixerButton.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const during = { center:rect(center) };
    await new Promise((resolve) => setTimeout(resolve, 230));
    const channelFour = document.querySelectorAll('.qu-channel')[3];
    channelFour.querySelector('.qu-key.select').click();
    channelFour.querySelector('.qu-key.mute').click();
    const channelFourFader = channelFour.querySelector('.qu-vertical-fader');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(channelFourFader, '77');
    channelFourFader.dispatchEvent(new Event('change', { bubbles:true }));
    const firstKnob = document.querySelector('.qu-rotary-control');
    const knobBefore = Number(firstKnob.dataset.value);
    let wheelSeen = false;
    firstKnob.addEventListener('wheel', () => { wheelSeen = true; }, { once:true });
    const wheelAccepted = firstKnob.dispatchEvent(new WheelEvent('wheel', { deltaY:-100, bubbles:true, cancelable:true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mixButtons=[...document.querySelectorAll('.qu-mix-select button')].filter((button)=>
      Boolean(button.dataset.mixSelect||button.closest('.qu-mix-group[data-mix-select]'))
    );
    const mixId=(button)=>button?.dataset.mixSelect??button?.closest('.qu-mix-group[data-mix-select]')?.dataset.mixSelect??null;
    const mixFamily=(button)=>button?.dataset.mixFamily??button?.closest('[data-mix-group]')?.dataset.mixGroup??null;
    const lrButton=document.querySelector('.qu-master-strip button[data-mix-select="LR"],.qu-master-strip [data-mix-select="LR"] button');
    const layerKeys=[...document.querySelectorAll('button.qu-layer-key[data-layer-select]')];
    const after = {
      library:rect(library), center:rect(center), right:rect(right), mixer:rect(mixer), duration:getComputedStyle(workspace).transitionDuration,
      modelName:document.querySelector('.mixer-workspace>header b')?.textContent ?? '',
      channelCount:document.querySelectorAll('.qu-channel').length,
      faderCount:document.querySelectorAll('.qu-vertical-fader').length,
      mixCount:mixButtons.length,
      mixLabels:mixButtons.map(mixId),
      mixFamilies:mixButtons.map((button)=>mixFamily(button)),
      mixGroupShape:[...document.querySelectorAll('.qu-mix-groups > .qu-mix-group[data-mix-group]')].map((group)=>({
        id:group.dataset.mixGroup,
        targets:[...group.querySelectorAll('button')].map(mixId),
      })),
      hasIndependentLrControl:Boolean(lrButton),
      lrHasCentreLamp:Boolean(lrButton?.querySelector(':scope > i > b')),
      layerKeySemantics:layerKeys.map((button)=>({
        id:button.dataset.layerSelect,
        hasKeycap:Boolean(button.querySelector(':scope > i')),
        hasIndependentLamp:Boolean(button.querySelector(':scope > b')&&!button.querySelector(':scope > i')?.contains(button.querySelector(':scope > b'))),
      })),
      meterLampBands:[...document.querySelectorAll('.qu-channel:first-of-type .qu-signal [data-meter-band]')].map((lamp)=>lamp.dataset.meterBand),
      selectedChannel:document.querySelector('.qu-channel.selected')?.dataset.channel,
      channelFourMuted:channelFour.querySelector('.qu-key.mute').getAttribute('aria-pressed'),
      channelFourLevel:channelFourFader.value,
      knobBefore,
      knobAfter:Number(document.querySelector('.qu-rotary-control').dataset.value),
      rotaryMode:firstKnob.dataset.inputMode,
      disguisedRangeCount:document.querySelectorAll('.qu-hardware-knob input[type="range"]').length,
      wheelSeen,
      wheelAccepted,
      connectionLabel:document.querySelector('.mixer-workspace>header small')?.textContent,
    };
    homeButton.click();
    await new Promise((resolve) => setTimeout(resolve, 330));
    settingsButton.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const settings = {
      modelValue:document.querySelector('.settings-mixer-model select')?.value,
      driverState:document.querySelector('.settings-driver-state')?.className,
      actionLabel:document.querySelector('.settings-driver-action')?.textContent,
    };
    mixerButton.click();
    await new Promise((resolve) => setTimeout(resolve, 330));
    return { before, during, after, settings };
  })()`);
  assert.equal(mixerTransition.after.duration, "0.3s");
  assert.equal(Math.abs(mixerTransition.after.center.left) < 1, true);
  assert.equal(mixerTransition.after.library.width < 1, true);
  assert.equal(mixerTransition.after.right.width < 1, true);
  assert.equal(mixerTransition.after.mixer.width > 100, true);
  assert.equal(mixerTransition.after.modelName, "Allen & Heath Qu-16");
  assert.equal(mixerTransition.after.channelCount, 16);
  assert.equal(mixerTransition.after.faderCount, 17);
  assert.equal(mixerTransition.after.mixCount, 9);
  assert.deepEqual(mixerTransition.after.mixLabels, ['FX 1','FX 2','Mix 1','Mix 2','Mix 3','Mix 4','Mix 5-6','Mix 7-8','Mix 9-10']);
  assert.deepEqual(mixerTransition.after.mixFamilies, ['fx','fx','mono','mono','mono','mono','stereo','stereo','stereo']);
  assert.deepEqual(mixerTransition.after.mixGroupShape, [
    { id:'fx', targets:['FX 1','FX 2'] },
    { id:'mono', targets:['Mix 1','Mix 2','Mix 3','Mix 4'] },
    { id:'stereo', targets:['Mix 5-6','Mix 7-8','Mix 9-10'] },
  ]);
  assert.equal(mixerTransition.after.hasIndependentLrControl, true);
  assert.equal(mixerTransition.after.lrHasCentreLamp, true);
  assert.deepEqual(mixerTransition.after.layerKeySemantics, [
    { id:'upper', hasKeycap:true, hasIndependentLamp:true },
    { id:'lower', hasKeycap:true, hasIndependentLamp:true },
  ]);
  assert.deepEqual(mixerTransition.after.meterLampBands, ['peak','nominal','signal']);
  assert.equal(mixerTransition.after.selectedChannel, "4");
  assert.equal(mixerTransition.after.channelFourMuted, "true");
  assert.equal(mixerTransition.after.channelFourLevel, "77");
  assert.equal(mixerTransition.after.wheelSeen, true);
  assert.equal(mixerTransition.after.wheelAccepted, false);
  assert.equal(mixerTransition.after.knobAfter, mixerTransition.after.knobBefore + 1);
  assert.equal(mixerTransition.after.rotaryMode, "rotary-360");
  assert.equal(mixerTransition.after.disguisedRangeCount, 0);
  assert.match(mixerTransition.after.connectionLabel, /USB-B 24×22.*Ethernet TCP 51325/);
  assert.equal(mixerTransition.settings.modelValue, "allen-heath-qu16");
  assert.match(mixerTransition.settings.driverState, /ready|consent-required/);
  assert.equal(mixerTransition.settings.actionLabel, "安装驱动 / EULA");
  assert.equal(mainState.audioEngineCount, 2);
  assert.equal(mainState.nativeOutputStatus.previewMode, true);
  assert.equal(mainState.nativeOutputStatus.windowVisible, false);
  assert.equal(mainState.nativeOutputStatus.monitorIndex, null);
  assert.equal(mainState.mixerDriverStatus.modelId, "allen-heath-qu16");
  assert.match(mainState.mixerDriverStatus.state, /ready|consent-required/);
  assert.equal(mainState.repeatedMixerDriverStatuses.length, 8);
  assert.equal(mainState.repeatedMixerDriverStatuses.every((status)=>status.state===mainState.mixerDriverStatus.state), true);
  assert.equal(mainState.qu16MeterStatus.source, "qu16-tcp-midi");
  assert.equal(typeof mainState.qu16MeterStatus.sessionId, "number");
  assert.match(mainState.qu16MeterStatus.state, /stopped|connecting|syncing|metering|reconnecting|error/);
  assert.equal(typeof mainState.qu16MeterStatus.channels["ch-1"].levelDbfs, "number");
  assert.equal(typeof mainState.qu16MeterStatus.masters.LR.levelDbfs, "number");
  if (!mainState.qu16MeterStatus.connected) {
    assert.equal(mainState.qu16MeterStatus.channels["ch-1"].levelDbfs, -128);
    assert.equal(mainState.qu16MeterStatus.masters.LR.levelDbfs, -128);
  }
  assert.equal(typeof mainState.qu16ParameterStatus.sessionId, "number");
  assert.equal(typeof mainState.qu16ParameterStatus.connectionEpoch, "number");
  assert.equal(typeof mainState.qu16ParameterStatus.revision, "number");
  assert.equal(typeof mainState.qu16ParameterStatus.parameters, "object");
  assert.equal(typeof mainState.qu16ParameterStatus.pending, "number");
  assert.equal(typeof mainState.qu16ParameterStatus.pendingDetails, "object");
  if (!mainState.qu16ParameterStatus.connected || !mainState.qu16ParameterStatus.synced) {
    assert.match(mainState.qu16OfflineWriteError, /not live|not reached End Sync|stale Qu-16 session/);
  }
  assert.equal(outputState.hasOutputRoot, true);
  if (process.env.KING_EXPECT_MPV === "1") {
    assert.equal(mainState.nativeMpvStatus.available, true);
    assert.match(mainState.nativeMpvStatus.version ?? "", /^mpv v/i);
    assert.match(mainState.nativeMpvStatus.binaryPath ?? "", /mpv\.exe$/i);
  }
  if (process.env.KING_EXPECT_BUNDLED_MPV === "1") {
    assert.doesNotMatch(mainState.nativeMpvStatus.binaryPath ?? "", /\.local-tools/i);
  }
  if (process.env.KING_EXPECT_LOCAL_MEDIA === "1") {
    assert.match(mainState.libraryHeader, /mpv 播放引擎/);
  }
});
