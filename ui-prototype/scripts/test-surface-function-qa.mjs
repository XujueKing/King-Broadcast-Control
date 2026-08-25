const endpoint = process.env.KING_WEBVIEW_DEBUG_URL ?? "http://127.0.0.1:9229";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const main = targets.find(
  (target) => !target.url.includes("output.html") && /localhost:1420|tauri\.localhost/.test(target.url),
);

if (!main) throw new Error("Main Tauri WebView target not found");

const socket = new WebSocket(main.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const handler = pending.get(message.id);
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const pause = (milliseconds = 55) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function evaluate(expression) {
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, observed ${actualJson}`);
  }
}

async function clickSelector(selector) {
  const clicked = await evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node||node.disabled) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Enabled control not found: ${selector}`);
  await pause();
}

async function movePointerTo(selector) {
  const point = await evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node||node.disabled) return null;
    const rect=node.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  if (!point) throw new Error(`Enabled pointer target not found: ${selector}`);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await pause();
  return point;
}

async function pointerDown(selector) {
  const point = await movePointerTo(selector);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await pause();
  return point;
}

async function pointerUp(point) {
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await pause();
}

async function movePointerAway() {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await pause();
}

async function enterMixer() {
  const ready = await evaluate(`(async()=>{
    const workspace=document.querySelector(".workspace");
    if(!workspace?.classList.contains("mixer-layout")){
      [...document.querySelectorAll(".bottom-nav button")]
        .find((button)=>button.textContent.includes("调音台"))?.click();
      await new Promise((resolve)=>setTimeout(resolve,380));
    }
    return Boolean(document.querySelector(".workspace.mixer-layout .qu-surface"));
  })()`);
  if (!ready) throw new Error("Unable to enter the mixer workspace");
}

async function dispatchMeterFrame({ levelDbfs = -120, peakDbfs = levelDbfs, connected = true, rtaDbfs = null } = {}) {
  const rta=Array.isArray(rtaDbfs)?rtaDbfs:Array(31).fill(-120);
  await evaluate(`(()=>{
    const level=${Number(levelDbfs)};
    const peak=${Number(peakDbfs)};
    window.dispatchEvent(new CustomEvent("king:qu16-meter-frame",{detail:{
      source:"qa-meter-frame",
      connected:${Boolean(connected)},
      updatedAtMs:Date.now(),
      channels:{"ch-1":{levelDbfs:level,peakDbfs:peak,leftDbfs:level,rightDbfs:level}},
      masters:{LR:{levelDbfs:level,peakDbfs:peak,leftDbfs:level,rightDbfs:level}},
      monitor:{leftDbfs:level,rightDbfs:level,mainLeftDbfs:level,mainRightDbfs:level},
      rtaDbfs:${JSON.stringify(rta)}
    }}));
    return true;
  })()`);
  await pause();
}

async function setFader(selector, value) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  const found = await evaluate(`(()=>{
    const fader=document.querySelector(${JSON.stringify(selector)});
    if(!fader||fader.disabled) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
    setter.call(fader,String(${normalized}));
    fader.dispatchEvent(new Event("input",{bubbles:true}));
    fader.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);
  if (!found) throw new Error(`Enabled fader not found: ${selector}`);
  await pause();
  const observed = await evaluate(`Number(document.querySelector(${JSON.stringify(selector)})?.value)`);
  assertEqual(observed, normalized, `Fader ${selector}`);
}

async function pressControlKey(selector, key) {
  const accepted = await evaluate(`(()=>{
    const control=document.querySelector(${JSON.stringify(selector)});
    if(!control||control.disabled) return false;
    control.dispatchEvent(new KeyboardEvent("keydown",{
      key:${JSON.stringify(key)},bubbles:true,cancelable:true
    }));
    return true;
  })()`);
  if (!accepted) throw new Error(`Enabled keyboard control not found: ${selector}`);
  await pause();
}

async function selectLayer(layer) {
  const current = await evaluate(`document.querySelector(".qu-surface")?.dataset.layer??null`);
  if (current !== layer) await clickSelector(`[data-layer-select="${layer}"]`);
  const observed = await evaluate(`document.querySelector(".qu-surface")?.dataset.layer??null`);
  assertEqual(observed, layer, `Layer ${layer}`);
}

function mixButtonSelector(mix) {
  const value = JSON.stringify(mix);
  return `.qu-mix-select button[data-mix-select=${value}],.qu-mix-select .qu-mix-group[data-mix-select=${value}] button`;
}

function lrButtonSelector() {
  return '.qu-master-strip button[data-mix-select="LR"],.qu-master-strip [data-mix-select="LR"] button';
}

async function selectMix(mix) {
  const current = await evaluate(`document.querySelector(".qu-surface")?.dataset.activeMix??null`);
  if (current !== mix) await clickSelector(mix === "LR" ? lrButtonSelector() : mixButtonSelector(mix));
  const observed = await evaluate(`document.querySelector(".qu-surface")?.dataset.activeMix??null`);
  assertEqual(observed, mix, `Mix ${mix}`);
}

async function setSurfaceMode(mode) {
  const current = await evaluate(`document.querySelector(".qu-surface")?.dataset.surfaceMode??null`);
  if (current === mode) return;
  if (current !== "select") {
    const activeModifier = current === "preFade" ? "pre-fade" : current;
    await clickSelector(`[data-surface-modifier="${activeModifier}"]`);
  }
  if (mode !== "select") {
    const modifier = mode === "preFade" ? "pre-fade" : mode;
    await clickSelector(`[data-surface-modifier="${modifier}"]`);
  }
  const observed = await evaluate(`document.querySelector(".qu-surface")?.dataset.surfaceMode??null`);
  assertEqual(observed, mode, `Surface mode ${mode}`);
}

async function setGeqMode(targetMode) {
  for (let index = 0; index < 4; index += 1) {
    const mode = await evaluate(`document.querySelector(".qu-hardware-block.geq")?.dataset.geqRange??null`);
    if (mode === targetMode) return;
    await clickSelector('[data-panel-key="geq-fader-flip"]');
  }
  const observed = await evaluate(`document.querySelector(".qu-hardware-block.geq")?.dataset.geqRange??null`);
  throw new Error(`Unable to set GEQ Fader Flip to ${targetMode}; observed ${observed}`);
}

async function inspectSurface() {
  return evaluate(`(()=>{
    const surface=document.querySelector(".qu-surface");
    const strips=[...document.querySelectorAll(".qu-channel")];
    const master=document.querySelector(".qu-master-strip");
    const mixButtons=[...document.querySelectorAll(".qu-mix-select button")].filter((button)=>
      Boolean(button.dataset.mixSelect||button.closest(".qu-mix-group[data-mix-select]"))
    );
    const mixId=(button)=>button?.dataset.mixSelect??button?.closest(".qu-mix-group[data-mix-select]")?.dataset.mixSelect??null;
    const mixFamily=(button)=>button?.dataset.mixFamily??button?.closest("[data-mix-group]")?.dataset.mixGroup??null;
    const buttonState=(node)=>node?{
      pressed:node.getAttribute("aria-pressed"),
      disabled:Boolean(node.disabled),
      text:node.textContent.trim()
    }:null;
    return {
      layer:surface?.dataset.layer??null,
      mode:surface?.dataset.surfaceMode??null,
      mix:surface?.dataset.activeMix??null,
      stripCount:strips.length,
      slots:strips.map((strip)=>Number(strip.dataset.slot)),
      sourceIds:strips.map((strip)=>strip.dataset.sourceId),
      stripLayers:strips.map((strip)=>strip.dataset.layer),
      first:{
        sourceId:strips[0]?.dataset.sourceId??null,
        fader:Number(strips[0]?.querySelector(".qu-vertical-fader")?.value),
        mute:buttonState(strips[0]?.querySelector(".qu-key.mute")),
        sel:buttonState(strips[0]?.querySelector(".qu-key.select")),
        pafl:buttonState(strips[0]?.querySelector(".qu-pafl")),
        rtaMode:strips[0]?.querySelector(".qu-signal")?.dataset.rtaMode??null,
        rtaActive:strips[0]?.querySelector(".qu-signal")?.dataset.rtaActive??null,
        meter:[...strips[0]?.querySelectorAll(".qu-signal [data-meter-band]")??[]].map(lamp=>({
          band:lamp.dataset.meterBand,
          lit:lamp.dataset.lit,
          background:getComputedStyle(lamp).backgroundColor,
          shadow:getComputedStyle(lamp).boxShadow
        }))
      },
      second:{
        sourceId:strips[1]?.dataset.sourceId??null,
        mute:buttonState(strips[1]?.querySelector(".qu-key.mute")),
        sel:buttonState(strips[1]?.querySelector(".qu-key.select")),
        pafl:buttonState(strips[1]?.querySelector(".qu-pafl"))
      },
      rtaStates:strips.map((strip)=>({
        mode:strip.querySelector(".qu-signal")?.dataset.rtaMode??null,
        active:strip.querySelector(".qu-signal")?.dataset.rtaActive??null,
        role:strip.querySelector(".qu-signal")?.dataset.meterRole??null,
        level:Number(strip.querySelector(".qu-signal")?.dataset.levelDbfs),
        lit:[...strip.querySelectorAll(".qu-signal [data-meter-band]")].map((lamp)=>lamp.dataset.lit)
      })),
      master:{
        mix:master?.dataset.masterMix??null,
        fader:Number(master?.querySelector(".qu-vertical-fader")?.value),
        mute:buttonState(master?.querySelector(".qu-key.mute")),
        sel:buttonState(master?.querySelector(".qu-key.select")),
        pafl:buttonState(master?.querySelector(".qu-pafl"))
      },
      mixButtons:mixButtons.map((button)=>({
        id:mixId(button),
        family:mixFamily(button),
        pressed:button.getAttribute("aria-pressed"),
        faceBackground:getComputedStyle(button.querySelector(":scope>i,.qu-surface-key-face")).backgroundColor
      })),
      lr:buttonState(document.querySelector('.qu-master-strip button[data-mix-select="LR"],.qu-master-strip [data-mix-select="LR"] button')),
      layers:[...document.querySelectorAll("[data-layer-select]")].map((button)=>({
        id:button.dataset.layerSelect,
        pressed:button.getAttribute("aria-pressed"),
        hasKeycap:Boolean(button.matches(".qu-layer-key")&&button.querySelector(":scope>i")),
        hasIndependentLamp:Boolean(button.querySelector(":scope>b")&&!button.querySelector(":scope>i")?.contains(button.querySelector(":scope>b")))
      })),
      modifiers:[...document.querySelectorAll("[data-surface-modifier]")].map((button)=>({
        id:button.dataset.surfaceModifier,
        pressed:button.getAttribute("aria-pressed"),
        disabled:Boolean(button.disabled)
      })),
      softkeys:[...document.querySelectorAll("[data-softkey]")].map((button)=>({
        key:Number(button.dataset.softkey),
        assignment:button.dataset.assignment,
        pressed:button.getAttribute("aria-pressed")
      })),
      geq:{
        range:document.querySelector(".qu-hardware-block.geq")?.dataset.geqRange??null,
        frequency:strips[0]?.dataset.geqFrequency??"",
        applicable:document.querySelector(".qu-hardware-block.geq")?.dataset.applicable??null,
        flipDisabled:Boolean(document.querySelector('[data-panel-key="geq-fader-flip"]')?.disabled)
      },
      meterSource:document.querySelector(".qu-meter-bank")?.dataset.meterSource??null,
      meterTransport:document.querySelector(".qu-meter-bank")?.dataset.meterTransport??null,
      lcd:{
        syncMode:document.querySelector(".qu-lcd-panel")?.dataset.syncMode??null,
        syncSource:document.querySelector(".qu-lcd-panel")?.dataset.syncSource??null,
        syncTarget:document.querySelector(".qu-lcd-panel")?.dataset.syncTarget??null
      }
    };
  })()`);
}

async function inspectGeometry() {
  return evaluate(`(()=>{
    const rect=(node)=>{const value=node?.getBoundingClientRect();return value?{
      x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom
    }:null};
    const font=(node)=>node?Number.parseFloat(getComputedStyle(node).fontSize):null;
    const overflow=(node)=>node?{
      x:Math.max(0,node.scrollWidth-node.clientWidth),
      y:Math.max(0,node.scrollHeight-node.clientHeight)
    }:null;
    const consolePanel=document.querySelector(".qu-console");
    const brandbar=document.querySelector(".qu-console-brandbar");
    const brandArt=document.querySelector(".qu-brandbar-art");
    const superstrip=document.querySelector(".qu-superstrip");
    const surface=document.querySelector(".qu-surface");
    const channels=document.querySelector(".qu-channels");
    const layerRail=document.querySelector(".qu-layer-rail");
    const master=document.querySelector(".qu-master-strip");
    const mixSelect=document.querySelector(".qu-mix-select");
    const strips=[...document.querySelectorAll(".qu-channel")];
    const firstStripScreen=document.querySelector('.qu-channel .qu-strip-screen');
    const firstMixButton=[...document.querySelectorAll('.qu-mix-select button')].find((button)=>
      Boolean(button.dataset.mixSelect||button.closest('.qu-mix-group[data-mix-select]'))
    );
    const dotNodes={
      channel:document.querySelector('.qu-channel .qu-surface-key-face>b'),
      soft:document.querySelector('.qu-softkeys>button>i>b'),
      mix:firstMixButton?.querySelector(':scope>i>b,.qu-surface-key-face>b')
    };
    const brandAsset=(()=>{
      if(!brandArt?.complete||!brandArt.naturalWidth||!brandArt.naturalHeight)return null;
      const canvas=document.createElement('canvas');
      canvas.width=brandArt.naturalWidth;
      canvas.height=brandArt.naturalHeight;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(brandArt,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      let edgeNeutralLeft=0;
      let edgeNeutralRight=0;
      let cyanMinX=canvas.width;
      let cyanMaxX=-1;
      const pixel=(x,y)=>{
        const offset=(y*canvas.width+x)*4;
        return [pixels[offset],pixels[offset+1],pixels[offset+2]];
      };
      const brightNeutral=([r,g,b])=>{
        const luminance=(r+g+b)/3;
        const spread=Math.max(r,g,b)-Math.min(r,g,b);
        return luminance>80&&spread<35;
      };
      for(let y=0;y<canvas.height;y+=1){
        for(let x=0;x<canvas.width;x+=1){
          const [r,g,b]=pixel(x,y);
          if(b>80&&g>60&&b-r>35){
            cyanMinX=Math.min(cyanMinX,x);
            cyanMaxX=Math.max(cyanMaxX,x);
          }
        }
        for(let x=0;x<4;x+=1){
          if(brightNeutral(pixel(x,y)))edgeNeutralLeft+=1;
          if(brightNeutral(pixel(canvas.width-1-x,y)))edgeNeutralRight+=1;
        }
      }
      return {
        naturalWidth:brandArt.naturalWidth,
        naturalHeight:brandArt.naturalHeight,
        edgeNeutralLeft,
        edgeNeutralRight,
        cyanLeftInset:cyanMinX,
        cyanRightInset:cyanMaxX>=0?canvas.width-1-cyanMaxX:null
      };
    })();
    const brandStyle=brandArt?getComputedStyle(brandArt):null;
    return {
      viewport:{width:innerWidth,height:innerHeight},
      rects:{
        console:rect(consolePanel),brandbar:rect(brandbar),brandArt:rect(brandArt),superstrip:rect(superstrip),surface:rect(surface),channels:rect(channels),
        layerRail:rect(layerRail),master:rect(master),mixSelect:rect(mixSelect)
      },
      overflow:{
        console:overflow(consolePanel),brandbar:overflow(brandbar),brandArt:overflow(brandArt),superstrip:overflow(superstrip),surface:overflow(surface),channels:overflow(channels),
        layerRail:overflow(layerRail),master:overflow(master),mixSelect:overflow(mixSelect)
      },
      brand:{asset:brandAsset,objectFit:brandStyle?.objectFit??null,objectPosition:brandStyle?.objectPosition??null},
      stripWidths:strips.map((strip)=>strip.getBoundingClientRect().width),
      bottomInset:surface&&channels?surface.getBoundingClientRect().bottom-channels.getBoundingClientRect().bottom:null,
      surfacePaddingBottom:surface?Number.parseFloat(getComputedStyle(surface).paddingBottom):null,
      controls:{
        upperOval:rect(document.querySelector('[data-panel-key="gate-in"]')),
        channelMute:rect(document.querySelector('.qu-channel .qu-key.mute .qu-surface-key-face')),
        channelSel:rect(document.querySelector('.qu-channel .qu-key.select .qu-surface-key-face')),
        channelPafl:rect(document.querySelector('.qu-channel .qu-pafl .qu-surface-key-face')),
        masterMute:rect(document.querySelector('.qu-master-strip .qu-key.mute .qu-surface-key-face')),
        masterSel:rect(document.querySelector('.qu-master-strip .qu-key.select .qu-surface-key-face')),
        masterPafl:rect(document.querySelector('.qu-master-strip .qu-pafl .qu-surface-key-face')),
        softKey:rect(document.querySelector('.qu-softkeys>button>i')),
        mixKey:rect(firstMixButton?.querySelector(':scope>i,.qu-surface-key-face')),
        channelLabel:rect(document.querySelector('.qu-channel .qu-key.mute>span')),
        softLabel:rect(document.querySelector('.qu-softkeys>button>span')),
        mixLabel:rect(firstMixButton?.querySelector(':scope>span'))
      },
      dots:Object.fromEntries(Object.entries(dotNodes).map(([name,node])=>[name,rect(node)])),
      typography:{
        channelLabel:font(document.querySelector('.qu-channel .qu-key.mute>span')),
        signalLabel:font(document.querySelector('.qu-channel .qu-signal b')),
        stripLabel:font(document.querySelector('.qu-channel .qu-strip-screen b')),
        stripSecondary:font(document.querySelector('.qu-channel .qu-strip-screen small')),
        scaleLabel:font(document.querySelector('.qu-channel .qu-db-scale .major b')),
        channelIndex:font(document.querySelector('.qu-channel .qu-strip-index>b')),
        softLabel:font(document.querySelector('.qu-softkeys>button>span')),
        mixLabel:font(firstMixButton?.querySelector(':scope>span'))
      }
    };
  })()`);
}

async function inspectLampKey(selector) {
  return evaluate(`(()=>{
    const button=document.querySelector(${JSON.stringify(selector)});
    const face=button?.querySelector(":scope>.qu-surface-key-face,:scope>i");
    const directLamp=button?.querySelector(":scope>b");
    const lamp=directLamp??face?.querySelector(":scope>b");
    const style=(node)=>node?{
      background:getComputedStyle(node).backgroundColor,
      backgroundImage:getComputedStyle(node).backgroundImage,
      border:getComputedStyle(node).borderColor,
      shadow:getComputedStyle(node).boxShadow,
      filter:getComputedStyle(node).filter,
      opacity:getComputedStyle(node).opacity,
      transform:getComputedStyle(node).transform,
      outline:getComputedStyle(node).outlineStyle
    }:null;
    return {
      pressed:button?.getAttribute("aria-pressed")??null,
      hasKeycap:Boolean(face),
      hasLamp:Boolean(lamp),
      independentLamp:Boolean(lamp&&face&&!face.contains(lamp)),
      outer:style(button),face:style(face),lamp:style(lamp)
    };
  })()`);
}

function assertLampKeyShellStable(actual, expected, label) {
  for (const property of ["background", "backgroundImage", "border", "shadow", "filter", "opacity", "transform"]) {
    assertEqual(actual.outer[property], expected.outer[property], `${label} outer ${property}`);
    assertEqual(actual.face[property], expected.face[property], `${label} keycap ${property}`);
  }
}

function assertNear(actual, expected, label, tolerance = 0.55) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} ± ${tolerance}, observed ${actual}`);
  }
}

function assertMinimum(actual, minimum, label) {
  if (!Number.isFinite(actual) || actual < minimum) {
    throw new Error(`${label}: expected at least ${minimum}, observed ${actual}`);
  }
}

function assertLampColor(value, expected, label) {
  const channels = String(value).match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`${label}: unable to parse lamp color ${JSON.stringify(value)}`);
  }
  const [red, green, blue] = channels;
  const matches = {
    off: Math.max(red, green, blue) <= 90,
    red: red >= green + 70 && red >= blue + 60,
    amber: red >= green + 20 && green >= blue + 35,
    green: green >= red + 45 && green >= blue + 55,
  }[expected];
  if (!matches) {
    throw new Error(`${label}: expected ${expected} lamp, observed ${value}`);
  }
}

async function testToggleLampLifecycle(selector, label) {
  if ((await inspectLampKey(selector)).pressed === "true") await clickSelector(selector);
  await movePointerAway();
  const off=await inspectLampKey(selector);
  assertEqual(off.pressed,"false",`${label} starts inactive`);
  assertEqual(off.hasKeycap&&off.hasLamp,true,`${label} has a keycap and centre lamp`);
  assertEqual(off.independentLamp,false,`${label} lamp remains inside the keycap`);

  await movePointerTo(selector);
  const hover=await inspectLampKey(selector);
  assertLampKeyShellStable(hover,off,`${label} hover`);
  assertEqual(hover.lamp.background,off.lamp.background,`${label} hover keeps the lamp off`);

  const pointer=await pointerDown(selector);
  const pressed=await inspectLampKey(selector);
  assertLampKeyShellStable(pressed,off,`${label} pointer-down`);
  assertEqual(pressed.lamp.background,off.lamp.background,`${label} pointer-down keeps the lamp off`);
  await pointerUp(pointer);

  const on=await inspectLampKey(selector);
  assertEqual(on.pressed,"true",`${label} active state`);
  assertLampKeyShellStable(on,off,`${label} active`);
  assertLampColor(on.lamp.background,"red",`${label} active centre lamp`);

  await movePointerTo(selector);
  const activeHover=await inspectLampKey(selector);
  assertLampKeyShellStable(activeHover,off,`${label} active hover`);
  assertLampColor(activeHover.lamp.background,"red",`${label} active hover centre lamp`);

  const activePointer=await pointerDown(selector);
  const activePressed=await inspectLampKey(selector);
  assertLampKeyShellStable(activePressed,off,`${label} active pointer-down`);
  assertLampColor(activePressed.lamp.background,"red",`${label} active pointer-down centre lamp`);
  await pointerUp(activePointer);
  await movePointerAway();

  const restored=await inspectLampKey(selector);
  assertEqual(restored.pressed,"false",`${label} restores inactive state`);
  assertLampKeyShellStable(restored,off,`${label} restored`);
  assertEqual(restored.lamp.background,off.lamp.background,`${label} restored lamp`);
  return {off,on};
}

async function testExclusiveLampLifecycle(selector, restoreSelector, label) {
  await movePointerAway();
  const off=await inspectLampKey(selector);
  assertEqual(off.pressed,"false",`${label} starts inactive`);
  assertEqual(off.hasKeycap&&off.hasLamp,true,`${label} has a keycap and centre lamp`);
  assertEqual(off.independentLamp,false,`${label} lamp remains inside the keycap`);

  await movePointerTo(selector);
  const hover=await inspectLampKey(selector);
  assertLampKeyShellStable(hover,off,`${label} hover`);
  assertEqual(hover.lamp.background,off.lamp.background,`${label} hover keeps the lamp off`);

  const pointer=await pointerDown(selector);
  const pressed=await inspectLampKey(selector);
  assertLampKeyShellStable(pressed,off,`${label} pointer-down`);
  assertEqual(pressed.lamp.background,off.lamp.background,`${label} pointer-down keeps the lamp off`);
  await pointerUp(pointer);

  const on=await inspectLampKey(selector);
  assertEqual(on.pressed,"true",`${label} active state`);
  assertLampKeyShellStable(on,off,`${label} active`);
  assertLampColor(on.lamp.background,"red",`${label} active centre lamp`);

  await movePointerTo(selector);
  const activeHover=await inspectLampKey(selector);
  assertLampKeyShellStable(activeHover,off,`${label} active hover`);
  assertLampColor(activeHover.lamp.background,"red",`${label} active hover centre lamp`);

  const activePointer=await pointerDown(selector);
  const activePressed=await inspectLampKey(selector);
  assertLampKeyShellStable(activePressed,off,`${label} active pointer-down`);
  assertLampColor(activePressed.lamp.background,"red",`${label} active pointer-down centre lamp`);
  await pointerUp(activePointer);

  await clickSelector(restoreSelector);
  await movePointerAway();
  const restored=await inspectLampKey(selector);
  assertEqual(restored.pressed,"false",`${label} restores inactive state`);
  assertLampKeyShellStable(restored,off,`${label} restored`);
  assertEqual(restored.lamp.background,off.lamp.background,`${label} restored lamp`);
  return {off,on};
}

function assertGeometry(report, label) {
  const required = ["console", "brandbar", "brandArt", "surface", "channels", "layerRail", "master", "mixSelect"];
  for (const name of required) {
    if (!report.rects[name] || !report.overflow[name]) {
      throw new Error(`${label}: missing ${name} geometry: ${JSON.stringify(report)}`);
    }
    if (report.overflow[name].x > 1 || report.overflow[name].y > 1) {
      throw new Error(`${label}: ${name} overflows: ${JSON.stringify({
        viewport: report.viewport,
        overflow: report.overflow,
        rects: report.rects,
      })}`);
    }
  }
  if(!report.rects.superstrip)throw new Error(`${label}: missing SuperStrip geometry`);
  const {console:consolePanel,brandbar,brandArt,superstrip}=report.rects;
  const brandAsset=report.brand?.asset;
  if(!brandAsset)throw new Error(`${label}: brand asset did not load`);
  assertEqual(report.brand.objectFit,"contain",`${label} brandbar fit`);
  assertEqual(brandAsset.naturalWidth,1407,`${label} brandbar natural width`);
  assertEqual(brandAsset.naturalHeight,70,`${label} brandbar natural height`);
  assertNear(brandbar.height,brandbar.width/(brandAsset.naturalWidth/brandAsset.naturalHeight),`${label} brandbar aspect height`,1.5);
  assertNear(brandArt.width,brandbar.width,`${label} brand artwork width`,0.5);
  assertNear(brandArt.height,brandbar.height,`${label} brand artwork height`,0.5);
  assertNear(brandbar.x-consolePanel.x,consolePanel.right-brandbar.right,`${label} brandbar symmetric panel inset`,1);
  if(superstrip.y<brandbar.bottom-.5)throw new Error(`${label}: upper controls overlap brandbar: ${JSON.stringify({brandbar,superstrip})}`);
  if(superstrip.y-consolePanel.y<brandbar.height+4)throw new Error(`${label}: control panel did not follow the full brandbar height: ${JSON.stringify({consolePanel,brandbar,superstrip})}`);
  if(brandAsset.edgeNeutralLeft!==0||brandAsset.edgeNeutralRight!==0)throw new Error(`${label}: clipped screw chrome remains at a brandbar edge: ${JSON.stringify(brandAsset)}`);
  if(brandAsset.cyanLeftInset<2||brandAsset.cyanLeftInset>12||brandAsset.cyanRightInset<2||brandAsset.cyanRightInset>12||Math.abs(brandAsset.cyanLeftInset-brandAsset.cyanRightInset)>2)throw new Error(`${label}: brand plaques are not balanced at both ends: ${JSON.stringify(brandAsset)}`);
  if (report.stripWidths.length !== 16) {
    throw new Error(`${label}: expected 16 strip widths, observed ${report.stripWidths.length}`);
  }
  const widthSpread = Math.max(...report.stripWidths) - Math.min(...report.stripWidths);
  if (widthSpread > 0.75) {
    throw new Error(`${label}: channel widths are uneven: ${JSON.stringify(report.stripWidths)}`);
  }
  const surface = report.rects.surface;
  for (const name of ["layerRail", "channels", "master", "mixSelect"]) {
    const child = report.rects[name];
    if (child.x < surface.x - 1 || child.right > surface.right + 1 || child.y < surface.y - 1 || child.bottom > surface.bottom + 1) {
      throw new Error(`${label}: ${name} escapes surface bounds: ${JSON.stringify({ surface, child })}`);
    }
  }

  const controls = report.controls;
  for (const name of ["upperOval", "channelMute", "channelSel", "channelPafl", "masterMute", "masterSel", "masterPafl", "softKey", "mixKey"]) {
    if (!controls?.[name]) throw new Error(`${label}: missing ${name} geometry`);
  }
  assertNear(controls.upperOval.width, 29, `${label} upper oval width`);
  assertNear(controls.upperOval.height, 20, `${label} upper oval height`);
  for (const name of ["channelMute", "masterMute", "softKey"]) {
    assertNear(controls[name].width, 31, `${label} ${name} width`);
    assertNear(controls[name].height, 22, `${label} ${name} height`);
  }
  for (const name of ["channelSel", "masterSel", "mixKey"]) {
    assertNear(controls[name].width, 29, `${label} ${name} width`);
    assertNear(controls[name].height, 20, `${label} ${name} height`);
  }
  for (const name of ["channelPafl", "masterPafl"]) {
    const expectedPaflSize=report.viewport.height<=1040?23:24;
    assertNear(controls[name].width, expectedPaflSize, `${label} ${name} width`);
    assertNear(controls[name].height, expectedPaflSize, `${label} ${name} height`);
  }

  for (const name of ["channel","soft","mix"]) {
    if (!report.dots?.[name]) throw new Error(`${label}: missing ${name} key centre dot`);
    assertNear(report.dots[name].width,4,`${label} ${name} key centre dot width`);
    assertNear(report.dots[name].height,4,`${label} ${name} key centre dot height`);
  }

  const expectedBottomInset=report.viewport.height<=820?2:report.viewport.height<=1040?4:Math.min(26,Math.max(18,report.viewport.height*.022));
  assertNear(report.surfacePaddingBottom,expectedBottomInset,`${label} lower metal edge padding`);
  assertNear(report.bottomInset,expectedBottomInset,`${label} lower metal edge visual inset`,1.75);

  const compact = report.viewport.height <= 1040;
  const minimumFonts = compact
    ? { channelLabel: 7, signalLabel: 6, stripLabel: 8, stripSecondary: 6.75, scaleLabel: 6.5, channelIndex: 7, softLabel: 6.5, mixLabel: 6.5 }
    : { channelLabel: 7.5, signalLabel: 6.5, stripLabel: 8.5, stripSecondary: 7, scaleLabel: 7, channelIndex: 8, softLabel: 7, mixLabel: 7 };
  for (const [name, minimum] of Object.entries(minimumFonts)) {
    assertMinimum(report.typography?.[name], minimum, `${label} ${name} font`);
  }
  if (!compact) {
    if (controls.channelLabel.bottom > controls.channelMute.y + 0.5) {
      throw new Error(`${label}: channel label overlaps Mute face`);
    }
    if (controls.softLabel.bottom > controls.softKey.y + 0.5 || controls.mixLabel.bottom > controls.mixKey.y + 0.5) {
      throw new Error(`${label}: right-bank label overlaps its button face`);
    }
  }
}

async function testModifierIsolation({ modifier, mode, mixA = "Mix 1", mixB = "Mix 2" }) {
  const firstSel = '.qu-channel[data-slot="1"] .qu-key.select';
  const masterSel = ".qu-master-strip .qu-key.select";
  const pressed = () => evaluate(`document.querySelector(${JSON.stringify(firstSel)})?.getAttribute("aria-pressed")`);
  const masterPressed = () => evaluate(`document.querySelector(${JSON.stringify(masterSel)})?.getAttribute("aria-pressed")`);

  await selectMix(mixA);
  await setSurfaceMode(mode);
  const baselineA = await pressed();
  await setSurfaceMode("select");

  await selectMix(mixB);
  await setSurfaceMode(mode);
  const baselineB = await pressed();
  await setSurfaceMode("select");

  await selectMix(mixA);
  await setSurfaceMode(mode);
  await clickSelector(firstSel);
  assertEqual(await pressed(), baselineA === "true" ? "false" : "true", `${modifier} toggles current source`);

  await selectMix(mixB);
  await setSurfaceMode(mode);
  assertEqual(await pressed(), baselineB, `${modifier} is isolated per Mix`);

  await selectMix(mixA);
  await setSurfaceMode(mode);
  assertEqual(await pressed(), baselineA === "true" ? "false" : "true", `${modifier} state is remembered`);
  await clickSelector(firstSel);
  assertEqual(await pressed(), baselineA, `${modifier} source state restored`);

  const masterBaseline = await masterPressed();
  await clickSelector(masterSel);
  assertEqual(await masterPressed(), masterBaseline === "true" ? "false" : "true", `${modifier} Master bulk toggle`);
  await clickSelector(masterSel);
  assertEqual(await masterPressed(), masterBaseline, `${modifier} Master bulk restore`);
  await setSurfaceMode("select");
}

const mixTargets = ["LR", "FX 1", "FX 2", "Mix 1", "Mix 2", "Mix 3", "Mix 4", "Mix 5-6", "Mix 7-8", "Mix 9-10"];
const rightMixTargets = mixTargets.filter((mix) => mix !== "LR");
const expectedMixFamilies = [
  { id: "fx", targets: ["FX 1", "FX 2"] },
  { id: "mono", targets: ["Mix 1", "Mix 2", "Mix 3", "Mix 4"] },
  { id: "stereo", targets: ["Mix 5-6", "Mix 7-8", "Mix 9-10"] },
];
const expectedLayerSources = {
  lower: Array.from({ length: 16 }, (_, index) => `ch-${index + 1}`),
  upper: [
    "st-1", "st-2", "st-3", "fx-1-ret", "fx-2-ret", "fx-3-ret", "fx-4-ret", "fx-1-send",
    "fx-2-send", "mix-1-master", "mix-2-master", "mix-3-master", "mix-4-master", "mix-5-6-master",
    "mix-7-8-master", "mix-9-10-master",
  ],
  // The initial Custom Layer is a mapping to existing CH1-16 entities. It must
  // not create sixteen duplicate audio sources with independent state.
  custom: Array.from({ length: 16 }, (_, index) => `ch-${index + 1}`),
};

let failure;
let metricsOverridden = false;
const observations = {
  layers: {},
  faderMemory: {},
  geometry: {},
};

try {
  // A full reload is intentional: Vite HMR preserves hook state, so a newly-added
  // model bus could otherwise be absent from pre-existing per-Mix state maps.
  await call("Page.enable");
  await call("Page.reload", { ignoreCache: true });
  await pause(1200);
  await enterMixer();

  await setGeqMode("off");
  await selectLayer("lower");
  await setSurfaceMode("select");
  await selectMix("LR");

  let state = await inspectSurface();
  assertEqual(state.lcd.syncMode, "local-ui-only", "Local-only sync boundary");
  assertEqual(state.meterTransport, "disconnected", "No hardware must not fabricate live metering");
  assertArrayEqual(state.first.meter.map((lamp)=>lamp.band), ["peak","nominal","signal"], "Channel meter band order");
  assertEqual(state.first.meter.every((lamp)=>lamp.lit==="false"), true, "Disconnected channel meter lamps remain off");
  assertEqual(state.first.meter.every((lamp)=>!lamp.shadow.includes("0px 0px 3px")), true, "Disconnected channel meter lamps do not glow");
  for (const lamp of state.first.meter) assertLampColor(lamp.background, "off", `Disconnected ${lamp.band} lamp color`);

  const meterCases=[
    {levelDbfs:-60,peakDbfs:-60,lit:["false","false","false"]},
    {levelDbfs:-48,peakDbfs:-48,lit:["false","false","true"]},
    {levelDbfs:-18,peakDbfs:-18,lit:["false","true","true"]},
    {levelDbfs:-18,peakDbfs:-3,lit:["true","true","true"]}
  ];
  for(const meterCase of meterCases){
    await dispatchMeterFrame(meterCase);
    state=await inspectSurface();
    assertEqual(state.meterTransport,"qa-meter-frame",`Meter transport at ${meterCase.levelDbfs} dBFS`);
    assertArrayEqual(state.first.meter.map((lamp)=>lamp.lit),meterCase.lit,`Cumulative meter lamps at ${meterCase.levelDbfs}/${meterCase.peakDbfs} dBFS`);
  }
  for (const [index, expectedColor] of ["red", "amber", "green"].entries()) {
    assertLampColor(state.first.meter[index].background, expectedColor, `${state.first.meter[index].band} active lamp color`);
  }
  await dispatchMeterFrame({connected:false});
  state=await inspectSurface();
  assertEqual(state.meterTransport,"disconnected","Disconnected frame clears meter transport");
  assertEqual(state.first.meter.every((lamp)=>lamp.lit==="false"),true,"Disconnected frame clears channel lamps");
  assertArrayEqual(state.mixButtons.map((button) => button.id), rightMixTargets, "Right Mix Select order");
  assertEqual(state.mixButtons.some((button) => button.id === "LR"), false, "LR excluded from right Mix Select");
  for (const family of expectedMixFamilies) {
    const buttons=state.mixButtons.filter((button)=>button.family===family.id);
    assertArrayEqual(buttons.map((button)=>button.id),family.targets,`${family.id} Mix Select family order`);
    assertEqual(new Set(buttons.map((button)=>button.faceBackground)).size,1,`${family.id} Mix Select family keycap color`);
  }
  assertEqual(new Set(expectedMixFamilies.map((family)=>state.mixButtons.find((button)=>button.family===family.id)?.faceBackground)).size,3,"FX, mono and stereo Mix Select keycap families are visually distinct");
  if (!state.lr) throw new Error("Independent LR Master control is missing");
  assertEqual(state.modifiers.find((modifier) => modifier.id === "pre-fade")?.disabled, true, "Pre Fade unavailable in LR");
  assertEqual(state.modifiers.find((modifier) => modifier.id === "assign")?.disabled, false, "Assign available in LR");

  const lrKeySelector=lrButtonSelector();
  const lrKeyOn=await inspectLampKey(lrKeySelector);
  assertEqual(lrKeyOn.pressed,"true","Independent LR key active state");
  assertEqual(lrKeyOn.hasKeycap&&lrKeyOn.hasLamp,true,"Independent LR key has a keycap and centre lamp");
  assertLampColor(lrKeyOn.lamp.background,"red","Independent LR active centre lamp");

  const mixKeySelector=mixButtonSelector("Mix 1");
  await testToggleLampLifecycle(mixKeySelector,"Mix Select Mix 1");
  await selectMix("Mix 1");
  const lrKeyOff=await inspectLampKey(lrKeySelector);
  assertEqual(lrKeyOff.pressed,"false","Independent LR key clears when a Mix is selected");
  assertLampKeyShellStable(lrKeyOff,lrKeyOn,"Independent LR inactive");
  if(lrKeyOn.lamp.background===lrKeyOff.lamp.background||lrKeyOn.lamp.shadow===lrKeyOff.lamp.shadow){
    throw new Error(`Independent LR feedback must change only its centre lamp: ${JSON.stringify({lrKeyOn,lrKeyOff})}`);
  }
  await clickSelector(mixKeySelector);
  assertEqual((await inspectSurface()).mix,"LR","Mix Select lamp QA restores LR");

  await testToggleLampLifecycle('.qu-channel[data-slot="1"] .qu-key.mute',"CH1 Mute");
  await testToggleLampLifecycle('.qu-channel[data-slot="1"] .qu-pafl',"CH1 PAFL");
  assertEqual((await inspectSurface()).meterSource,"lr","PAFL lamp QA restores LR meter");

  await testExclusiveLampLifecycle(
    '.qu-channel[data-slot="2"] .qu-key.select',
    '.qu-channel[data-slot="1"] .qu-key.select',
    "CH2 Sel",
  );
  await testToggleLampLifecycle('.qu-master-strip .qu-key.mute',"Master Mute");
  await testToggleLampLifecycle('.qu-master-strip .qu-pafl',"Master PAFL");
  assertEqual((await inspectSurface()).meterSource,"lr","Master PAFL lamp QA restores LR meter");
  await testExclusiveLampLifecycle(
    '.qu-master-strip .qu-key.select',
    '.qu-channel[data-slot="1"] .qu-key.select',
    "Master Sel",
  );

  const lowerLayerSelector='button.qu-layer-key[data-layer-select="lower"]';
  const upperLayerSelector='button.qu-layer-key[data-layer-select="upper"]';
  await selectLayer("lower");
  const lowerLayerOn=await inspectLampKey(lowerLayerSelector);
  const upperLayerOff=await inspectLampKey(upperLayerSelector);
  for (const [label, key] of [["Lower", lowerLayerOn], ["Upper", upperLayerOff]]) {
    assertEqual(key.hasKeycap,true,`${label} Layer has a physical keycap`);
    assertEqual(key.hasLamp,true,`${label} Layer has an indicator lamp`);
    assertEqual(key.independentLamp,true,`${label} Layer indicator lamp is independent from its keycap`);
  }
  await selectLayer("upper");
  const lowerLayerOff=await inspectLampKey(lowerLayerSelector);
  const upperLayerOn=await inspectLampKey(upperLayerSelector);
  assertLampKeyShellStable(lowerLayerOff,lowerLayerOn,"Lower Layer active state");
  assertLampKeyShellStable(upperLayerOn,upperLayerOff,"Upper Layer active state");
  if(lowerLayerOn.lamp.background===lowerLayerOff.lamp.background||upperLayerOn.lamp.background===upperLayerOff.lamp.background){
    throw new Error(`Layer selection must change the independent lamps, not the keycaps: ${JSON.stringify({lowerLayerOn,lowerLayerOff,upperLayerOn,upperLayerOff})}`);
  }

  for (const layer of ["lower", "upper", "custom"]) {
    await selectLayer(layer);
    state = await inspectSurface();
    observations.layers[layer] = state.sourceIds;
    assertEqual(state.stripCount, 16, `${layer} physical strip count`);
    assertArrayEqual(state.slots, Array.from({ length: 16 }, (_, index) => index + 1), `${layer} physical slots`);
    assertArrayEqual(state.sourceIds, expectedLayerSources[layer], `${layer} logical sources`);
    assertEqual(new Set(state.sourceIds).size, 16, `${layer} source uniqueness`);
    assertEqual(state.stripLayers.every((stripLayer) => stripLayer === layer), true, `${layer} strip data-layer`);
    assertEqual(state.layers.find((item) => item.id === layer)?.pressed, "true", `${layer} key lamp`);
  }
  await selectLayer("lower");

  const rightMixKeyBaselines={};
  for (const target of rightMixTargets) rightMixKeyBaselines[target]=await inspectLampKey(mixButtonSelector(target));
  for (const [index, target] of mixTargets.entries()) {
    await selectMix(target);
    const activeMixKey=await inspectLampKey(target==="LR"?lrButtonSelector():mixButtonSelector(target));
    assertLampColor(activeMixKey.lamp.background,"red",`${target} active centre lamp`);
    if(target!=="LR")assertLampKeyShellStable(activeMixKey,rightMixKeyBaselines[target],`${target} active keycap`);
    state = await inspectSurface();
    const channelValue = 20 + index * 7;
    const masterValue = 83 - index * 6;
    observations.faderMemory[target] = {
      baselineChannel: state.first.fader,
      baselineMaster: state.master.fader,
      channelValue,
      masterValue,
    };
    assertEqual(state.master.mix, target, `${target} Master identity`);
    assertEqual(state.first.sourceId, "ch-1", `${target} lower strip source`);
    await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', channelValue);
    await setFader(".qu-master-strip .qu-vertical-fader", masterValue);
  }

  for (const target of mixTargets) {
    await selectMix(target);
    state = await inspectSurface();
    assertEqual(state.first.fader, observations.faderMemory[target].channelValue, `${target} send/LR fader memory`);
    assertEqual(state.master.fader, observations.faderMemory[target].masterValue, `${target} Master fader memory`);
    assertEqual(state.master.mix, target, `${target} Master follows Mix Select`);
  }

  // The upper layer exposes the same Mix master entities as the dedicated
  // Master strip. Verify the two physical control paths do not regress into
  // independent copies of level, mute, PAFL or Processing state.
  const upperMix1 = '.qu-channel[data-source-id="mix-1-master"]';
  const upperMix1Fader = `${upperMix1} .qu-vertical-fader`;
  await selectMix("Mix 1");
  await selectLayer("upper");
  let masterMirror = await evaluate(`(()=>{
    const upper=document.querySelector(${JSON.stringify(upperMix1)});
    const master=document.querySelector(".qu-master-strip");
    return {
      upperLevel:Number(upper?.querySelector(".qu-vertical-fader")?.value),
      masterLevel:Number(master?.querySelector(".qu-vertical-fader")?.value),
      upperMute:upper?.querySelector(".qu-key.mute")?.getAttribute("aria-pressed"),
      masterMute:master?.querySelector(".qu-key.mute")?.getAttribute("aria-pressed")
    };
  })()`);
  assertEqual(masterMirror.upperLevel, masterMirror.masterLevel, "Upper Mix 1 Master starts with dedicated Master level");
  assertEqual(masterMirror.upperMute, masterMirror.masterMute, "Upper Mix 1 Master starts with dedicated Master mute");
  const mix1OriginalLevel = masterMirror.masterLevel;
  const mix1OriginalMute = masterMirror.masterMute;

  await setFader(upperMix1Fader, 47);
  assertEqual((await inspectSurface()).master.fader, 47, "Upper Mix 1 fader updates dedicated Master");
  await setFader(".qu-master-strip .qu-vertical-fader", 62);
  assertEqual(await evaluate(`Number(document.querySelector(${JSON.stringify(upperMix1Fader)})?.value)`), 62, "Dedicated Master fader updates upper Mix 1");

  await clickSelector(`${upperMix1} .qu-key.mute`);
  masterMirror = await evaluate(`({
    upper:document.querySelector(${JSON.stringify(`${upperMix1} .qu-key.mute`)})?.getAttribute("aria-pressed"),
    master:document.querySelector(".qu-master-strip .qu-key.mute")?.getAttribute("aria-pressed")
  })`);
  assertEqual(masterMirror.upper, masterMirror.master, "Upper Mix 1 Mute updates dedicated Master");
  assertEqual(masterMirror.master, mix1OriginalMute === "true" ? "false" : "true", "Upper Mix 1 Mute changes shared state");
  await clickSelector(".qu-master-strip .qu-key.mute");
  assertEqual(await evaluate(`document.querySelector(${JSON.stringify(`${upperMix1} .qu-key.mute`)})?.getAttribute("aria-pressed")`), mix1OriginalMute, "Dedicated Master Mute updates upper Mix 1");

  await clickSelector(`${upperMix1} .qu-pafl`);
  state = await inspectSurface();
  assertEqual(state.master.pafl.pressed, "true", "Upper Mix 1 PAFL updates dedicated Master PAFL");
  assertEqual(state.meterSource, "master:Mix 1", "Upper Mix 1 PAFL owns main meter as Master");
  await clickSelector(".qu-master-strip .qu-pafl");
  assertEqual(await evaluate(`document.querySelector(${JSON.stringify(`${upperMix1} .qu-pafl`)})?.getAttribute("aria-pressed")`), "false", "Dedicated Master PAFL clears upper Mix 1 PAFL");

  await clickSelector(`${upperMix1} .qu-key.select`);
  state = await inspectSurface();
  assertEqual(state.master.sel.pressed, "true", "Upper Mix 1 Processing selection lights dedicated Master Sel");
  assertEqual(state.lcd.syncTarget, "master", "Upper Mix 1 Processing uses Master target");
  assertEqual(state.lcd.syncSource, "master:Mix 1", "Upper Mix 1 Processing uses shared Master identity");
  const mix1PeqSelector = '[aria-label="LF Width 360度旋钮"]';
  const mix1PeqBefore = await evaluate(`Number(document.querySelector(${JSON.stringify(mix1PeqSelector)})?.dataset.value)`);
  await pressControlKey(mix1PeqSelector, mix1PeqBefore === 0 ? "End" : "Home");
  const mix1PeqChanged = await evaluate(`Number(document.querySelector(${JSON.stringify(mix1PeqSelector)})?.dataset.value)`);
  if (mix1PeqChanged === mix1PeqBefore) throw new Error("Upper Mix 1 Processing control did not change");
  await selectLayer("lower");
  await clickSelector(".qu-master-strip .qu-key.select");
  state = await inspectSurface();
  assertEqual(state.lcd.syncSource, "master:Mix 1", "Dedicated Master selects the same Mix 1 Processing entity");
  assertEqual(await evaluate(`Number(document.querySelector(${JSON.stringify(mix1PeqSelector)})?.dataset.value)`), mix1PeqChanged, "Mix 1 Processing persists between upper and dedicated Master paths");
  await setFader(".qu-master-strip .qu-vertical-fader", mix1OriginalLevel);
  await selectLayer("lower");

  await selectMix("FX 1");
  await clickSelector(mixButtonSelector("FX 1"));
  state = await inspectSurface();
  assertEqual(state.mix, "LR", "Pressing active Mix returns to LR");
  assertEqual(state.lr?.pressed, "true", "Independent LR control active after Mix return");

  await selectMix("FX 1");
  state = await inspectSurface();
  const fxMasterMuteBaseline = state.master.mute.pressed;
  await clickSelector(".qu-master-strip .qu-key.mute");
  const fxMasterMuteChanged = (await inspectSurface()).master.mute.pressed;
  assertEqual(fxMasterMuteChanged, fxMasterMuteBaseline === "true" ? "false" : "true", "FX 1 Master Mute toggles");
  await selectMix("LR");
  const lrMasterMute = (await inspectSurface()).master.mute.pressed;
  assertEqual(lrMasterMute, "false", "LR Master Mute remains independent");
  await selectMix("FX 1");
  assertEqual((await inspectSurface()).master.mute.pressed, fxMasterMuteChanged, "FX 1 Master Mute remembered");
  await clickSelector(".qu-master-strip .qu-key.mute");
  assertEqual((await inspectSurface()).master.mute.pressed, fxMasterMuteBaseline, "FX 1 Master Mute restored");

  await clickSelector(".qu-master-strip .qu-key.select");
  state = await inspectSurface();
  assertEqual(state.master.sel.pressed, "true", "Master Sel active");
  assertEqual(state.lcd.syncTarget, "master", "Touch Screen follows Master Sel");
  assertEqual(state.lcd.syncSource, "master:FX 1", "Touch Screen Master source identity");

  await selectMix("LR");
  await selectLayer("lower");
  await clickSelector('.qu-channel[data-slot="1"] .qu-key.select');
  state = await inspectSurface();
  assertEqual(state.lcd.syncTarget, "source", "Touch Screen returns to source Sel");
  assertEqual(state.lcd.syncSource, "ch-1", "Touch Screen lower source identity");

  const sourceMuteBaseline = state.first.mute.pressed;
  await clickSelector('.qu-channel[data-slot="1"] .qu-key.mute');
  const sourceMuteChanged = (await inspectSurface()).first.mute.pressed;
  assertEqual(sourceMuteChanged, sourceMuteBaseline === "true" ? "false" : "true", "Source Mute toggles globally");
  await selectMix("Mix 1");
  assertEqual((await inspectSurface()).first.mute.pressed, sourceMuteChanged, "Source Mute persists across Mixes");
  await selectLayer("upper");
  assertEqual((await inspectSurface()).first.sourceId, "st-1", "Layer changes logical source, not physical slot");
  await selectLayer("lower");
  assertEqual((await inspectSurface()).first.mute.pressed, sourceMuteChanged, "Source Mute survives layer round-trip");
  await clickSelector('.qu-channel[data-slot="1"] .qu-key.mute');
  assertEqual((await inspectSurface()).first.mute.pressed, sourceMuteBaseline, "Source Mute restored");

  await clickSelector('.qu-channel[data-slot="1"] .qu-pafl');
  state = await inspectSurface();
  assertEqual(state.first.pafl.pressed, "true", "CH1 PAFL active");
  assertEqual(state.meterSource, "source:ch-1", "CH1 PAFL owns main meter");
  await clickSelector('.qu-channel[data-slot="2"] .qu-pafl');
  state = await inspectSurface();
  assertEqual(state.first.pafl.pressed, "true", "CH2 PAFL keeps CH1 active for additive PAFL");
  assertEqual(state.second.pafl.pressed, "true", "CH2 PAFL active");
  assertEqual(state.meterSource, "source:ch-2", "CH2 PAFL owns main meter");
  await selectMix("Mix 2");
  assertEqual((await inspectSurface()).second.pafl.pressed, "true", "Source PAFL persists across Mixes");
  await clickSelector(".qu-master-strip .qu-pafl");
  state = await inspectSurface();
  assertEqual(state.second.pafl.pressed, "true", "Master PAFL keeps source PAFL targets active");
  assertEqual(state.master.pafl.pressed, "true", "Master PAFL active");
  assertEqual(state.meterSource, "master:Mix 2", "Master AFL owns main meter");
  await clickSelector(".qu-master-strip .qu-pafl");
  assertEqual((await inspectSurface()).meterSource, "source:ch-2", "Clearing Master PAFL restores the latest source PAFL meter");
  await clickSelector('.qu-channel[data-slot="2"] .qu-pafl');
  assertEqual((await inspectSurface()).meterSource, "source:ch-1", "Clearing CH2 PAFL restores CH1 meter");
  await clickSelector('.qu-channel[data-slot="1"] .qu-pafl');
  assertEqual((await inspectSurface()).meterSource, "lr", "Clearing all PAFL targets restores LR meter");

  await testModifierIsolation({ modifier: "Assign", mode: "assign" });
  await testModifierIsolation({ modifier: "Pre Fade", mode: "preFade" });

  await selectMix("LR");
  await selectLayer("lower");
  await setSurfaceMode("select");
  const normalFader = (await inspectSurface()).first.fader;
  await setGeqMode("low");
  state = await inspectSurface();
  const lrGeqBaseline = state.first.fader;
  assertEqual(state.geq.frequency, "31.5", "GEQ lower range first frequency");
  assertEqual(state.first.mute.disabled, false, "Source Mute remains available in GEQ Fader Flip");
  assertEqual(state.first.pafl.disabled, false, "Source PAFL remains available in GEQ Fader Flip");
  assertEqual(state.master.mute.disabled, false, "Master Mute remains available in GEQ Fader Flip");
  assertEqual(state.master.pafl.disabled, false, "Master PAFL remains available in GEQ Fader Flip");
  assertEqual(state.modifiers.every((modifier) => modifier.disabled), true, "Assign/Pre Fade disabled in GEQ Fader Flip");
  const lowRta=Array(31).fill(-120);
  lowRta[0]=-1; // 20 Hz is outside the 31.5 Hz–16 kHz GEQ surface.
  lowRta[2]=-36;
  await dispatchMeterFrame({levelDbfs:-3,peakDbfs:-3,rtaDbfs:lowRta});
  state=await inspectSurface();
  assertEqual(state.rtaStates[0].mode,"true","GEQ lower strip uses RTA mode");
  assertEqual(state.rtaStates[0].active,"true","RTA bin 2 maps to the 31.5 Hz strip");
  assertEqual(state.rtaStates[0].role,"rta-band","GEQ meter role overrides the source meter role");
  assertEqual(state.rtaStates[0].level,-36,"GEQ accessibility value uses the current RTA band");
  assertArrayEqual(state.rtaStates[0].lit,["true","false","false"],"Dominant RTA strip lights only red Pk");
  assertArrayEqual(state.rtaStates[1].lit,["false","false","false"],"Non-dominant GEQ strip does not fall back to channel meter lamps");
  await setGeqMode("high");
  const highRta=Array(31).fill(-120);
  highRta[29]=-42;
  highRta[30]=-1; // 20 kHz is outside the 28-band GEQ.
  await dispatchMeterFrame({levelDbfs:-3,peakDbfs:-3,rtaDbfs:highRta});
  state=await inspectSurface();
  assertEqual(state.rtaStates[15].active,"true","RTA bin 29 maps to the 16 kHz strip");
  assertEqual(state.rtaStates.filter((item)=>item.active==="true").length,1,"GEQ RTA selects one dominant band");
  await dispatchMeterFrame({connected:false});
  await setGeqMode("low");
  await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', 74);
  await clickSelector('.qu-channel[data-slot="1"] .qu-key.select');
  assertEqual((await inspectSurface()).first.fader, 50, "GEQ Sel resets band to 0dB");
  await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', 74);
  await setGeqMode("off");
  assertEqual((await inspectSurface()).first.fader, normalFader, "GEQ does not overwrite LR fader");

  await selectMix("Mix 1");
  await setGeqMode("low");
  const mix1GeqBaseline = (await inspectSurface()).first.fader;
  await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', 29);
  await setGeqMode("off");
  await selectMix("LR");
  await setGeqMode("low");
  assertEqual((await inspectSurface()).first.fader, 74, "GEQ band memory isolated per Mix");
  await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', lrGeqBaseline);
  await setGeqMode("off");
  await selectMix("Mix 1");
  await setGeqMode("low");
  await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', mix1GeqBaseline);
  await setGeqMode("off");

  await selectMix("FX 1");
  state = await inspectSurface();
  assertEqual(state.geq.applicable, "false", "FX 1 has no GEQ Fader Flip");
  assertEqual(state.geq.flipDisabled, true, "FX 1 GEQ Fader Flip key disabled");
  assertEqual(state.geq.range, "off", "Selecting FX 1 leaves GEQ Fader Flip off");
  await selectMix("FX 2");
  state = await inspectSurface();
  assertEqual(state.geq.applicable, "false", "FX 2 has no GEQ Fader Flip");
  assertEqual(state.geq.flipDisabled, true, "FX 2 GEQ Fader Flip key disabled");

  await selectMix("LR");
  await selectLayer("lower");
  state = await inspectSurface();
  assertArrayEqual(state.softkeys.map((softkey) => softkey.assignment), [
    "mute-group-1", "mute-group-2", "mute-group-3", "mute-group-4",
  ], "SoftKey default assignments");
  const softKeyBaseline = state.softkeys.map((softkey) => softkey.pressed);
  for (const key of [1, 2, 3, 4]) await clickSelector(`[data-softkey="${key}"]`);
  state = await inspectSurface();
  assertArrayEqual(
    state.softkeys.map((softkey) => softkey.pressed),
    softKeyBaseline.map((pressed) => (pressed === "true" ? "false" : "true")),
    "SoftKey lamps toggle independently",
  );
  await selectMix("FX 2");
  await selectLayer("upper");
  assertArrayEqual(
    (await inspectSurface()).softkeys.map((softkey) => softkey.pressed),
    softKeyBaseline.map((pressed) => (pressed === "true" ? "false" : "true")),
    "SoftKey state survives Mix and layer changes",
  );
  for (const key of [1, 2, 3, 4]) await clickSelector(`[data-softkey="${key}"]`);

  await selectMix("LR");
  await selectLayer("lower");
  for (const target of mixTargets) {
    await selectMix(target);
    await setFader('.qu-channel[data-slot="1"] .qu-vertical-fader', observations.faderMemory[target].baselineChannel);
    await setFader(".qu-master-strip .qu-vertical-fader", observations.faderMemory[target].baselineMaster);
  }
  await selectMix("LR");

  await enterMixer();
  observations.geometry.default = await inspectGeometry();
  assertGeometry(observations.geometry.default, "Default viewport");
  const viewport = observations.geometry.default.viewport;
  const compactWidth = Math.max(1067, Math.min(Math.round(viewport.width), 1366));
  for (const height of [1041, 1040, 980, 900, 841, 840, 821, 820, 800]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width: compactWidth,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    metricsOverridden = true;
    await pause(140);
    const report = await inspectGeometry();
    observations.geometry[`height${height}`] = report;
    assertGeometry(report, `${compactWidth}x${height}`);
  }
} catch (error) {
  failure = error;
} finally {
  if (metricsOverridden) await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  socket.close();
}

if (failure) throw failure;

console.log(JSON.stringify({
  layers: Object.fromEntries(Object.entries(observations.layers).map(([layer, sources]) => [layer, {
    stripCount: sources.length,
    first: sources[0],
    last: sources.at(-1),
  }])),
  mixTargets,
  faderMemory: "LR, FX 1/2 and all Mix sends plus their Master faders retain independent values",
  master: "per-Mix level/mute/Sel/PAFL verified",
  routing: "Assign and Pre Fade source state, per-Mix isolation and Master bulk toggle verified",
  geq: "Fader Flip safety, reset, normal-fader isolation and per-Mix memory verified",
  softkeys: "four factory mute-group assignments and persistent lamp state verified",
  geometry: Object.fromEntries(Object.entries(observations.geometry).map(([key, report]) => [key, report.viewport])),
}, null, 2));
