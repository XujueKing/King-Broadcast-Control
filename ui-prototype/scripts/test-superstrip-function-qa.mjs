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

const pause = (milliseconds = 45) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function clickSelector(selector) {
  const clicked = await evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Control not found: ${selector}`);
  await pause();
}

async function clickText(selector, text) {
  const clicked = await evaluate(`(()=>{
    const node=[...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate)=>candidate.textContent.trim()===${JSON.stringify(text)});
    if(!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Control not found: ${selector} with text ${text}`);
  await pause();
}

async function selectMix(mix) {
  const clicked = await evaluate(`(()=>{
    const wanted=${JSON.stringify(mix)};
    const mixId=(button)=>button?.dataset.mixSelect??button?.closest('.qu-mix-group[data-mix-select]')?.dataset.mixSelect??null;
    const buttons=wanted==="LR"
      ? [...document.querySelectorAll('.qu-master-strip button')]
      : [...document.querySelectorAll('.qu-mix-select button')];
    const node=buttons.find((button)=>mixId(button)===wanted);
    if(!node) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Mix control not found: ${mix}`);
  await pause();
}

async function setKnob(selector, value) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  const committed = await evaluate(`(()=>{
    const knob=document.querySelector(${JSON.stringify(selector)});
    if(!knob || knob.disabled) return null;
    const send=(key)=>knob.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
    send("Home");
    for(let index=0;index<${Math.floor(normalized / 5)};index+=1) send("PageUp");
    for(let index=0;index<${normalized % 5};index+=1) send("ArrowUp");
    return Number(knob.dataset.value);
  })()`);
  if (committed !== normalized) {
    throw new Error(`Unable to set ${selector} to ${normalized}; observed ${committed}`);
  }
  await pause();
}

async function setPanelKey(controlId, active) {
  const changed = await evaluate(`(()=>{
    const button=document.querySelector('[data-panel-key=${JSON.stringify(controlId)}]');
    if(!button) return null;
    const wanted=${Boolean(active)};
    if((button.getAttribute("aria-pressed")==="true")!==wanted) button.click();
    return true;
  })()`);
  if (!changed) throw new Error(`Panel key not found: ${controlId}`);
  await pause();
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

async function setFader(selector, value) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  const observed = await evaluate(`(()=>{
    const fader=document.querySelector(${JSON.stringify(selector)});
    if(!fader) return null;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
    setter.call(fader,String(${normalized}));
    fader.dispatchEvent(new Event("input",{bubbles:true}));
    return Number(fader.value);
  })()`);
  if (observed !== normalized) throw new Error(`Unable to set ${selector} to ${normalized}; observed ${observed}`);
  await pause();
}

async function selectChannel(channel) {
  await clickSelector(`.qu-channel[data-channel="${channel}"] .qu-key.select`);
}

async function selectBlock(block) {
  const selector = {
    PREAMP: ".qu-lcd-channel",
    GATE: ".qu-lcd-gate",
    PEQ: ".qu-lcd-chart",
    COMP: ".qu-lcd-comp",
  }[block];
  if (!selector) throw new Error(`Unknown block: ${block}`);
  await clickSelector(selector);
}

async function inspect() {
  return evaluate(`(()=>{
    const text=(selector)=>document.querySelector(selector)?.textContent.trim()??null;
    const value=(selector)=>Number(document.querySelector(selector)?.dataset.value);
    const pressed=(selector)=>document.querySelector(selector)?.getAttribute("aria-pressed");
    const disabled=(selector)=>Boolean(document.querySelector(selector)?.disabled);
    const parameter=(key)=>{
      const node=document.querySelector('[data-screen-parameter="'+key+'"]');
      return node?{
        value:node.querySelector("strong")?.textContent.trim()??null,
        meta:node.querySelector("span")?.textContent.trim()??null,
        note:node.querySelector("small")?.textContent.trim()??null
      }:null;
    };
    const bands=[...document.querySelectorAll(".qu-peq-band")];
    const lmKnobs=bands[1]?[...bands[1].querySelectorAll(".qu-rotary-control")]:[];
    const pan=document.querySelector(".qu-hardware-block.pan");
    const panKnob=pan?.querySelector(".qu-rotary-control");
    const lcd=document.querySelector(".qu-lcd-panel");
    const geqChannels=[...document.querySelectorAll(".qu-channel.geq-flip")];
    const consolePanel=document.querySelector(".qu-console");
    const channelBank=document.querySelector(".qu-channels");
    return {
      syncMode:lcd?.dataset.syncMode??null,
      syncChannel:Number(lcd?.dataset.syncChannel),
      screenBlock:lcd?.dataset.screenBlock??null,
      status:lcd?.querySelector(".qu-lcd-status")?.dataset.localStatus??null,
      overview:{
        channel:text(".qu-lcd-channel strong"),
        gain:text(".qu-lcd-channel>span"),
        source:text(".qu-lcd-channel>b"),
        hpf:text(".qu-lcd-channel>em"),
        gate:text(".qu-lcd-gate>small"),
        peq:text(".qu-lcd-chart>small"),
        comp:text(".qu-lcd-comp>small")
      },
      parameters:{
        gain:parameter("gain"),
        hpf:parameter("hpf"),
        lm:parameter("lm"),
        threshold:parameter("threshold")
      },
      layout:{
        consoleWidth:consolePanel?.getBoundingClientRect().width??0,
        consoleOverflow:(consolePanel?.scrollWidth??0)-(consolePanel?.clientWidth??0),
        channelOverflow:(channelBank?.scrollWidth??0)-(channelBank?.clientWidth??0)
      },
      hardware:{
        usb:pressed('.qu-hardware-block.preamp [aria-label="USB Select"]'),
        preampGain:value('.qu-hardware-block.preamp .qu-rotary-control'),
        hpfIn:pressed('[data-panel-key="hpf-in"]'),
        hpfFreq:value('.qu-hardware-block.hpf .qu-rotary-control'),
        peqLm:{
          width:Number(lmKnobs[0]?.dataset.value),
          freq:Number(lmKnobs[1]?.dataset.value),
          gain:Number(lmKnobs[2]?.dataset.value)
        },
        gateThreshold:value('.qu-hardware-block.gate .qu-rotary-control'),
        gateIn:pressed('[data-panel-key="gate-in"]'),
        compThreshold:value('.qu-hardware-block.comp .qu-rotary-control'),
        compIn:pressed('[data-panel-key="comp-in"]'),
        compGr:document.querySelector(".qu-comp-gr")?.dataset.compGr??null,
        geqFlip:pressed('[data-panel-key="geq-fader-flip"]'),
        geqLamp:document.querySelector('[data-panel-key="geq-fader-flip"]')?.dataset.lampState??null,
        geqRange:document.querySelector(".qu-hardware-block.geq")?.dataset.geqRange??null,
        geqFaders:geqChannels.map((channel)=>({
          frequency:channel.dataset.geqFrequency,
          value:Number(channel.querySelector(".qu-vertical-fader")?.value),
          flat:channel.querySelector(".qu-key.select")?.getAttribute("aria-pressed"),
          label:channel.querySelector(".qu-vertical-fader")?.getAttribute("aria-label")??null
        })),
        panEnabled:pan?.dataset.panEnabled??null,
        panDisabled:disabled(".qu-hardware-block.pan .qu-rotary-control"),
        panValue:Number(panKnob?.dataset.value),
        panLabel:panKnob?.getAttribute("aria-label")??null
      }
    };
  })()`);
}

const formatPreampGain = (value) => `${(-5 + (65 * value) / 100).toFixed(1)}dB`;
const formatFrequency = (value) => {
  const hz = 20 * Math.pow(1000, value / 100);
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)}kHz` : `${hz.toFixed(hz >= 100 ? 1 : 2)}Hz`;
};
const formatHpfFrequency = (value) => {
  const hz = 20 * Math.pow(100, value / 100);
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)}kHz` : `${hz.toFixed(hz >= 100 ? 1 : 2)}Hz`;
};
const formatGateThreshold = (value) => `${(-72 + (90 * value) / 100).toFixed(1)}dB`;
const formatCompThreshold = (value) => `${(-46 + (64 * value) / 100).toFixed(1)}dB`;
const formatPeqWidth = (value) => (1.5 - (1.5 - 1 / 9) * value / 100).toFixed(2);
const formatPeqGain = (value) => {
  const gain = -15 + (30 * value) / 100;
  return `${gain >= 0 ? "+" : ""}${gain.toFixed(1)}dB`;
};

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

async function resetBlock(block) {
  await selectBlock(block);
  await clickSelector(".qu-screen-edit-keys label:nth-child(3) button");
}

async function restoreDefaults() {
  const processing = await evaluate(`(()=>{
    const label=[...document.querySelectorAll(".qu-processing label")].find((item)=>item.querySelector("span")?.textContent.trim()==="Processing");
    label?.querySelector("button")?.click();
    return Boolean(label);
  })()`);
  if (processing) await pause();

  for (const channel of [1, 2]) {
    await selectChannel(channel);
    for (const block of ["PREAMP", "GATE", "PEQ", "COMP"]) await resetBlock(block);
  }

  await selectChannel(1);
  for (const mix of ["LR", "Mix 5-6", "Mix 7-8", "Mix 9-10"]) {
    await selectMix(mix);
    await setKnob(".qu-hardware-block.pan .qu-rotary-control", 50);
  }
  await selectMix("LR");
  await setGeqMode("off");
  await selectBlock("PEQ");
}

let failure;
const observations = {};

try {
  await evaluate(`(async()=>{
    [...document.querySelectorAll(".bottom-nav button")]
      .find((button)=>button.textContent.includes("调音台"))?.click();
    await new Promise((resolve)=>setTimeout(resolve,380));
    const processing=[...document.querySelectorAll(".qu-processing label")]
      .find((label)=>label.querySelector("span")?.textContent.trim()==="Processing");
    processing?.querySelector("button")?.click();
    await new Promise((resolve)=>setTimeout(resolve,80));
    return true;
  })()`);

  await selectChannel(1);
  await selectBlock("PREAMP");
  const initial = await inspect();
  assertEqual(initial.syncMode, "local-ui-only", "LCD sync boundary");
  assertEqual(initial.syncChannel, 1, "Initial selected channel");

  await setKnob(".qu-hardware-block.preamp .qu-rotary-control", 64);
  await setKnob(".qu-hardware-block.hpf .qu-rotary-control", 37);
  await setPanelKey("hpf-in", false);
  const sourceWasUsb = (await inspect()).hardware.usb === "true";
  if (sourceWasUsb) await clickSelector('.qu-hardware-block.preamp [aria-label="USB Select"]');
  await clickSelector('.qu-hardware-block.preamp [aria-label="USB Select"]');

  let state = await inspect();
  assertEqual(state.hardware.usb, "true", "Preamp USB Select");
  assertEqual(state.hardware.preampGain, 64, "Preamp Gain hardware value");
  assertEqual(state.hardware.hpfFreq, 37, "HPF Frequency hardware value");
  assertEqual(state.hardware.hpfIn, "false", "HPF In hardware state");
  assertEqual(state.overview.gain, formatPreampGain(64), "LCD overview Preamp Gain sync");
  assertEqual(state.overview.source, "USB", "LCD overview source sync");
  assertEqual(state.overview.hpf, "OUT", "LCD overview HPF In sync");
  assertEqual(state.parameters.gain?.value, formatPreampGain(64), "LCD Preamp Gain parameter sync");
  assertEqual(state.parameters.hpf?.value, formatHpfFrequency(37), "LCD HPF parameter sync");

  const lmSelectors = [
    ".qu-peq-band:nth-of-type(2)>.qu-hardware-knob:nth-of-type(1) .qu-rotary-control",
    ".qu-peq-band:nth-of-type(2)>.qu-hardware-knob:nth-of-type(2) .qu-rotary-control",
    ".qu-peq-band:nth-of-type(2)>.qu-hardware-knob:nth-of-type(3) .qu-rotary-control",
  ];
  await setKnob(lmSelectors[0], 31);
  await setKnob(lmSelectors[1], 63);
  await setKnob(lmSelectors[2], 72);
  await selectBlock("PEQ");
  state = await inspect();
  assertEqual(state.hardware.peqLm.width, 31, "PEQ LM Width hardware value");
  assertEqual(state.hardware.peqLm.freq, 63, "PEQ LM Frequency hardware value");
  assertEqual(state.hardware.peqLm.gain, 72, "PEQ LM Gain hardware value");
  assertEqual(state.parameters.hpf?.value, formatHpfFrequency(37), "PEQ LCD linked HPF sync");
  assertEqual(state.parameters.lm?.value, formatFrequency(63), "PEQ LCD LM Frequency sync");
  assertEqual(state.parameters.lm?.meta, `W ${formatPeqWidth(31)}`, "PEQ LCD LM Width sync");
  assertEqual(state.parameters.lm?.note, `G ${formatPeqGain(72)}`, "PEQ LCD LM Gain sync");

  await setKnob(".qu-hardware-block.gate .qu-rotary-control", 41);
  await setPanelKey("gate-in", true);
  await selectBlock("GATE");
  state = await inspect();
  assertEqual(state.hardware.gateThreshold, 41, "Gate Threshold hardware value");
  assertEqual(state.hardware.gateIn, "true", "Gate In hardware state");
  assertEqual(state.overview.gate, "IN", "LCD Gate In sync");
  assertEqual(state.parameters.threshold?.value, formatGateThreshold(41), "LCD Gate Threshold sync");

  await setKnob(".qu-hardware-block.comp .qu-rotary-control", 77);
  await setPanelKey("comp-in", true);
  await selectBlock("COMP");
  state = await inspect();
  assertEqual(state.hardware.compThreshold, 77, "Comp Threshold hardware value");
  assertEqual(state.hardware.compIn, "true", "Comp In hardware state");
  assertEqual(state.hardware.compGr, "on", "Comp local GR state");
  assertEqual(state.overview.comp, "IN", "LCD Comp In sync");
  assertEqual(state.parameters.threshold?.value, formatCompThreshold(77), "LCD Comp Threshold sync");

  await selectChannel(2);
  state = await inspect();
  observations.channel2BeforeEdit = state;
  assertEqual(state.syncChannel, 2, "CH2 selected channel");
  assertEqual(state.hardware.preampGain, 54, "CH2 isolated Preamp Gain default");
  assertEqual(state.hardware.hpfFreq, 42, "CH2 isolated HPF default");
  assertEqual(state.hardware.usb, "false", "CH2 isolated source default");
  assertEqual(state.hardware.gateThreshold, 58, "CH2 isolated Gate default");
  assertEqual(state.hardware.gateIn, "false", "CH2 isolated Gate In default");
  assertEqual(state.hardware.compThreshold, 58, "CH2 isolated Comp default");
  await setKnob(".qu-hardware-block.preamp .qu-rotary-control", 23);

  await selectChannel(1);
  state = await inspect();
  observations.channel1Restored = state;
  assertEqual(state.hardware.preampGain, 64, "CH1 Preamp Gain restored after CH2 edit");
  assertEqual(state.hardware.hpfFreq, 37, "CH1 HPF restored after CH2 edit");
  assertEqual(state.hardware.peqLm.width, 31, "CH1 PEQ Width restored after CH2 edit");
  assertEqual(state.hardware.peqLm.freq, 63, "CH1 PEQ Frequency restored after CH2 edit");
  assertEqual(state.hardware.peqLm.gain, 72, "CH1 PEQ Gain restored after CH2 edit");
  assertEqual(state.hardware.gateThreshold, 41, "CH1 Gate restored after CH2 edit");
  assertEqual(state.hardware.compThreshold, 77, "CH1 Comp restored after CH2 edit");

  await selectMix("LR");
  state = await inspect();
  assertEqual(state.hardware.panEnabled, "true", "Pan enabled in LR");
  assertEqual(state.hardware.panDisabled, false, "Pan rotary enabled in LR");
  await setKnob(".qu-hardware-block.pan .qu-rotary-control", 67);

  await selectMix("Mix 5-6");
  state = await inspect();
  assertEqual(state.hardware.panEnabled, "true", "Pan enabled in stereo Mix 5-6");
  assertEqual(state.hardware.panDisabled, false, "Pan rotary enabled in stereo Mix 5-6");
  if (!state.hardware.panLabel?.includes("Mix 5-6")) throw new Error(`Stereo Pan label is incorrect: ${state.hardware.panLabel}`);

  for (const monoMix of ["Mix 1", "Mix 2", "Mix 3", "Mix 4"]) {
    await selectMix(monoMix);
    state = await inspect();
    assertEqual(state.hardware.panEnabled, "false", `Pan disabled marker in ${monoMix}`);
    assertEqual(state.hardware.panDisabled, true, `Pan rotary disabled in ${monoMix}`);
  }

  await selectMix("LR");
  await setGeqMode("off");
  state = await inspect();
  assertEqual(state.hardware.geqFlip, "false", "GEQ Fader Flip off state");
  assertEqual(state.hardware.geqLamp, "off", "GEQ Fader Flip lamp off state");
  assertEqual(state.hardware.geqRange, "off", "GEQ normal fader mode");
  const normalConsoleWidth = state.layout.consoleWidth;
  assertEqual(state.layout.consoleOverflow, 0, "Normal mixer console horizontal overflow");
  assertEqual(state.layout.channelOverflow, 0, "Normal channel bank horizontal overflow");
  await clickSelector('[data-panel-key="geq-fader-flip"]');
  state = await inspect();
  assertEqual(state.hardware.geqFlip, "true", "GEQ Fader Flip on state");
  assertEqual(state.hardware.geqLamp, "on", "GEQ Fader Flip lamp on state");
  assertEqual(state.hardware.geqRange, "low", "GEQ lower frequency range");
  assertEqual(state.hardware.geqFaders.length, 16, "GEQ lower range fader count");
  assertEqual(state.hardware.geqFaders[0]?.frequency, "31.5", "GEQ lower range first band");
  assertEqual(state.hardware.geqFaders[15]?.frequency, "1k", "GEQ lower range last band");
  assertEqual(state.hardware.geqFaders[0]?.flat, "true", "Flat GEQ band lights Sel");
  assertEqual(state.layout.consoleWidth, normalConsoleWidth, "GEQ lower range console width stability");
  assertEqual(state.layout.consoleOverflow, 0, "GEQ lower range mixer console horizontal overflow");
  assertEqual(state.layout.channelOverflow, 0, "GEQ lower range channel bank horizontal overflow");
  await setFader('.qu-channel[data-channel="1"] .qu-vertical-fader', 75);
  state = await inspect();
  assertEqual(state.hardware.geqFaders[0]?.value, 75, "GEQ fader controls band gain");
  assertEqual(state.hardware.geqFaders[0]?.flat, "false", "Non-flat GEQ band clears Sel");
  await clickSelector('.qu-channel[data-channel="1"] .qu-key.select');
  state = await inspect();
  assertEqual(state.hardware.geqFaders[0]?.value, 50, "GEQ Sel resets band to 0dB");
  assertEqual(state.hardware.geqFaders[0]?.flat, "true", "Reset GEQ band lights Sel");
  await clickSelector('[data-panel-key="geq-fader-flip"]');
  state = await inspect();
  assertEqual(state.hardware.geqRange, "high", "GEQ higher frequency range");
  assertEqual(state.hardware.geqFaders[0]?.frequency, "500", "GEQ higher range first band");
  assertEqual(state.hardware.geqFaders[15]?.frequency, "16k", "GEQ higher range last band");
  assertEqual(state.layout.consoleWidth, normalConsoleWidth, "GEQ higher range console width stability");
  assertEqual(state.layout.consoleOverflow, 0, "GEQ higher range mixer console horizontal overflow");
  assertEqual(state.layout.channelOverflow, 0, "GEQ higher range channel bank horizontal overflow");
  await clickSelector('[data-panel-key="geq-fader-flip"]');
  state = await inspect();
  assertEqual(state.hardware.geqRange, "off", "GEQ returns to normal mix mode");
  assertEqual(state.hardware.geqFaders.length, 0, "GEQ fader layer removed in normal mode");

  observations.final = state;
} catch (error) {
  failure = error;
} finally {
  try {
    await restoreDefaults();
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  socket.close();
}

if (failure) throw failure;

console.log(JSON.stringify({
  syncMode: "local-ui-only",
  channelIsolation: {
    channel2PreampGain: observations.channel2BeforeEdit.hardware.preampGain,
    channel1PreampGainAfterChannel2Edit: observations.channel1Restored.hardware.preampGain,
  },
  synchronizedControls: [
    "Preamp USB Select/Gain",
    "HPF In/Frequency",
    "PEQ LM Width/Frequency/Gain",
    "Gate Threshold/In",
    "Comp Threshold/In",
  ],
  panModes: { enabled: ["LR", "Mix 5-6"], disabled: ["Mix 1", "Mix 2", "Mix 3", "Mix 4"] },
  geqFaderFlip: "normal / lower 16 / upper 16 cycle, fader gain and Sel reset verified",
}, null, 2));
