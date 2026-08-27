const freezeTarget = (target) => Object.freeze({
  ...target,
  aliases:Object.freeze([...(target.aliases ?? [])]),
});

const sourceTargets = [
  ...Array.from({ length:16 },(_,index)=>freezeTarget({
    id:`ch-${index+1}`,
    kind:"source",
    label:`CH${index+1}`,
    aliases:[`CH ${index+1}`],
  })),
  ...Array.from({ length:3 },(_,index)=>freezeTarget({
    id:`st-${index+1}`,
    kind:"source",
    label:`ST${index+1}`,
    aliases:[`ST ${index+1}`],
  })),
  ...Array.from({ length:4 },(_,index)=>freezeTarget({
    id:`fx-${index+1}-ret`,
    kind:"source",
    label:`FX Return${index+1}`,
    aliases:[`FX Return ${index+1}`,`FX${index+1} Return`,`FX${index+1} Ret`],
  })),
];

const masterTargets = [
  freezeTarget({ id:"lr-master",kind:"master",label:"LR",aliases:["L/R"] }),
  ...Array.from({ length:2 },(_,index)=>freezeTarget({
    id:`fx-${index+1}-send`,
    kind:"master",
    label:`FX ${index+1}`,
    aliases:[`FX Send${index+1}`,`FX Send ${index+1}`,`FX${index+1} Send`],
  })),
  ...["1","2","3","4","5-6","7-8","9-10"].map(suffix=>freezeTarget({
    id:`mix-${suffix}-master`,
    kind:"master",
    label:`Mix ${suffix}`,
    aliases:[`Mix${suffix}`],
  })),
];

export const QU16_SOURCE_TARGETS = Object.freeze(sourceTargets);
export const QU16_MASTER_TARGETS = Object.freeze(masterTargets);
export const QU16_TARGETS = Object.freeze([...sourceTargets,...masterTargets]);
export const QU16_MIX_LABELS = Object.freeze(masterTargets.map(target=>target.label));
export const QU16_SEND_MIX_LABELS = Object.freeze(QU16_MIX_LABELS.filter(label=>label!=="LR"));

const targetById = new Map(QU16_TARGETS.map(target=>[target.id,target]));
const targetIdByAlias = new Map();
for (const target of QU16_TARGETS) {
  for (const alias of [target.id,target.label,...target.aliases]) {
    const previous=targetIdByAlias.get(alias);
    if (previous&&previous!==target.id) throw new Error(`Duplicate Qu-16 target alias: ${alias}`);
    targetIdByAlias.set(alias,target.id);
  }
}

const supportedKinds = new Set(["fader","send","mute","pafl","pan","assign","pre","process"]);
// Mute Group masters are emitted by Get System State, but are intentionally
// read-only here. The documented protocol does not expose SoftKey assignment,
// so they must never enter the writable control-intent path.
const snapshotKinds = new Set([...supportedKinds,"mute-group"]);
const binaryProcessingParameters = new Set([
  "usb-source","preamp-source","polarity","hpf-in","peq-in","gate-in","comp-in",
]);
const processingParameters = new Set([
  ...binaryProcessingParameters,
  "preamp-gain","digital-trim","stereo-trim","hpf-frequency",
  ...["lf","lm","hm","hf"].flatMap(band=>[`peq-${band}-gain`,`peq-${band}-frequency`,`peq-${band}-width`]),
  ...["attack","release","hold","threshold","depth"].map(parameter=>`gate-${parameter}`),
  ...["attack","release","ratio","threshold","gain"].map(parameter=>`comp-${parameter}`),
]);

function assertFiniteNumber(value,name) {
  if (typeof value!=="number"||!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertUiValue(value,name="UI value") {
  assertFiniteNumber(value,name);
  if (value<0||value>100) throw new RangeError(`${name} must be between 0 and 100`);
}

function assertMidiValue(value,name="MIDI value") {
  assertFiniteNumber(value,name);
  if (!Number.isInteger(value)||value<0||value>127) {
    throw new RangeError(`${name} must be an integer between 0 and 127`);
  }
}

function assertBinaryValue(value,name="binary parameter value") {
  assertFiniteNumber(value,name);
  if (!Number.isInteger(value)||(value!==0&&value!==1)) {
    throw new RangeError(`${name} must be 0 or 1`);
  }
}

function targetDefinition(target) {
  if (typeof target!=="string") throw new TypeError("Qu-16 target must be a string");
  const id=targetIdByAlias.get(target);
  if (!id) throw new RangeError(`Unknown Qu-16 target: ${target}`);
  return targetById.get(id);
}

function canonicalTargetDefinition(target) {
  if (typeof target!=="string") throw new TypeError("Qu-16 target must be a string");
  const definition=targetById.get(target);
  if (!definition) throw new RangeError(`Unknown Qu-16 target id: ${target}`);
  return definition;
}

function mixDefinition(mix,{ allowLr = true }={}) {
  const definition=targetDefinition(mix);
  if (definition.kind!=="master") throw new RangeError(`Unknown Qu-16 mix: ${mix}`);
  if (!allowLr&&definition.label==="LR") throw new RangeError("LR uses fader parameters, not send parameters");
  return definition;
}

function canonicalMixDefinition(mix,{ allowLr = true }={}) {
  if (typeof mix!=="string") throw new TypeError("Qu-16 mix must be a string");
  const definition=masterTargets.find(target=>target.label===mix);
  if (!definition) throw new RangeError(`Unknown Qu-16 mix: ${mix}`);
  if (!allowLr&&definition.label==="LR") throw new RangeError("LR uses fader parameters, not send parameters");
  return definition;
}

/** Convert a desktop UI fader value to the Qu MIDI 7-bit domain. */
export function uiToMidiValue(value) {
  assertUiValue(value);
  return Math.round(value*127/100);
}

/** Convert a Qu MIDI 7-bit value to the integer 0..100 UI domain. */
export function midiToUiValue(value) {
  assertMidiValue(value);
  return Math.round(value*100/127);
}

/** Qu pan uses 00..4A rather than the full 7-bit range. */
export function uiToPanValue(value) {
  assertUiValue(value,"pan value");
  return Math.round(value*0x4A/100);
}

export function panToUiValue(value) {
  assertMidiValue(value,"pan value");
  if(value>0x4A)throw new RangeError("pan value must be between 0 and 74");
  return Math.round(value*100/0x4A);
}

/** Resolve a Qu master display label (for example `Mix 5-6`) to its stable id. */
export function qu16MasterTargetId(label) {
  if (typeof label!=="string") throw new TypeError("Qu-16 master target label must be a string");
  const definition=masterTargets.find(target=>target.label===label||target.aliases.includes(label));
  if (!definition) throw new RangeError(`Unknown Qu-16 master target label: ${label}`);
  return definition.id;
}

/** Resolve either a supported UI label or an already-stable id to a stable id. */
export function qu16TargetId(target) {
  return targetDefinition(target).id;
}

/** Resolve a supported mix label/id/alias to the model's display label. */
export function qu16MixLabel(mix) {
  return mixDefinition(mix).label;
}

/**
 * Produce the key used to coalesce rapid control writes. The value is validated
 * but deliberately omitted from the key, so the newest value wins.
 */
export function qu16ControlCoalesceKey(intent) {
  if (!intent||typeof intent!=="object"||Array.isArray(intent)) {
    throw new TypeError("Qu-16 control intent must be an object");
  }
  const { kind,target,mix,value }=intent;
  if (!supportedKinds.has(kind)) throw new RangeError(`Unknown Qu-16 control kind: ${kind}`);
  const definition=targetDefinition(target);

  if (kind==="fader"||kind==="send"||kind==="pan") assertUiValue(value,`${kind} value`);
  else if(kind==="process"){
    if(typeof intent.parameter!=="string"||!processingParameters.has(intent.parameter))throw new RangeError(`Unknown Qu-16 processing parameter: ${intent.parameter}`);
    if(binaryProcessingParameters.has(intent.parameter)){
      if(typeof value!=="boolean")throw new TypeError(`${intent.parameter} value must be boolean`);
    }else assertUiValue(value,`${intent.parameter} value`);
  }else if (typeof value!=="boolean") throw new TypeError(`${kind} value must be boolean`);

  if (kind==="send") {
    if (definition.kind!=="source") throw new RangeError("Qu-16 send target must be an input source");
    if (mix===undefined) throw new TypeError("Qu-16 send control requires a mix");
    const mixTarget=mixDefinition(mix,{ allowLr:false });
    return `send:${definition.id}:${mixTarget.label}`;
  }

  if(kind==="pan"){
    const mixTarget=mixDefinition(mix);
    if(!["LR","Mix 5-6","Mix 7-8","Mix 9-10"].includes(mixTarget.label))throw new RangeError(`Qu-16 pan is unavailable on ${mixTarget.label}`);
    return `pan:${definition.id}:${mixTarget.label}`;
  }

  if(kind==="assign"||kind==="pre"){
    if(definition.kind!=="source")throw new RangeError(`Qu-16 ${kind} target must be an input source`);
    const mixTarget=mixDefinition(mix,{allowLr:kind!=="pre"});
    return `${kind}:${definition.id}:${mixTarget.label}`;
  }

  if(kind==="process")return `process:${definition.id}:${intent.parameter}`;

  // A caller may include its current bank on non-send intents. Validate it so
  // a misspelled mix can never silently enter the coalescing layer.
  if (mix!==undefined&&mix!==null) mixDefinition(mix);
  return `${kind}:${definition.id}`;
}

function parameterEntries(parameters) {
  if (parameters instanceof Map) return [...parameters.entries()];
  if (!parameters||typeof parameters!=="object"||Array.isArray(parameters)) {
    throw new TypeError("Qu-16 snapshot parameters must be a Map or plain object");
  }
  const prototype=Object.getPrototypeOf(parameters);
  if (prototype!==Object.prototype&&prototype!==null) {
    throw new TypeError("Qu-16 snapshot parameters must be a Map or plain object");
  }
  return Object.entries(parameters);
}

function ensureLevelMix(levels,mix) {
  if (!levels[mix]) levels[mix]={};
  return levels[mix];
}

function ensureMaster(master,mix) {
  if (!master[mix]) master[mix]={};
  return master[mix];
}

/**
 * Decode a complete normalized Qu parameter snapshot into the shape consumed
 * by the React digital twin. Faders/sends are MIDI 0..127; Mute/PAFL are 0/1.
 */
export function decodeQu16ParameterSnapshot(snapshot) {
  if (!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)) {
    throw new TypeError("Qu-16 parameter snapshot must be an object");
  }

  const levels={};
  const master={};
  const mute={};
  const activePaflIds=new Set();
  const pan={};
  const assign={};
  const pre={};
  const processing={};
  const muteGroups=Array(4).fill(false);

  for (const [parameterKey,rawValue] of parameterEntries(snapshot.parameters)) {
    if (typeof parameterKey!=="string") throw new TypeError("Qu-16 parameter key must be a string");
    const parts=parameterKey.split(":");
    const kind=parts[0];
    if (!snapshotKinds.has(kind)) throw new RangeError(`Unknown Qu-16 parameter kind: ${kind}`);

    if(kind==="mute-group"){
      if(parts.length!==2||!/^[1-4]$/.test(parts[1]))throw new RangeError(`Malformed Qu-16 parameter key: ${parameterKey}`);
      assertBinaryValue(rawValue,parameterKey);
      muteGroups[Number(parts[1])-1]=Boolean(rawValue);
      continue;
    }

    const expectedParts=["send","pan","assign","pre","process"].includes(kind)?3:2;
    if (parts.length!==expectedParts||!parts[1]||(expectedParts===3&&!parts[2])) {
      throw new RangeError(`Malformed Qu-16 parameter key: ${parameterKey}`);
    }

    // Snapshots cross the process boundary, so they must contain canonical ids
    // rather than UI aliases. This prevents two spellings from addressing the
    // same control in a single snapshot.
    const target=canonicalTargetDefinition(parts[1]);

    if (kind==="fader") {
      assertMidiValue(rawValue,parameterKey);
      const level=midiToUiValue(rawValue);
      if (target.kind==="master") ensureMaster(master,target.label).level=level;
      else ensureLevelMix(levels,"LR")[target.id]=level;
      continue;
    }

    if (kind==="send") {
      if (target.kind!=="source") throw new RangeError(`Qu-16 send target must be an input source: ${target.id}`);
      const mix=canonicalMixDefinition(parts[2],{ allowLr:false }).label;
      assertMidiValue(rawValue,parameterKey);
      ensureLevelMix(levels,mix)[target.id]=midiToUiValue(rawValue);
      continue;
    }

    if(kind==="pan"){
      const mix=canonicalMixDefinition(parts[2]).label;
      if(!["LR","Mix 5-6","Mix 7-8","Mix 9-10"].includes(mix))throw new RangeError(`Qu-16 pan is unavailable on ${mix}`);
      if(target.kind!=="source")throw new RangeError(`Qu-16 pan target must be an input source: ${target.id}`);
      if(!pan[mix])pan[mix]={};
      pan[mix][target.id]=panToUiValue(rawValue);
      continue;
    }

    if(kind==="assign"||kind==="pre"){
      if(target.kind!=="source")throw new RangeError(`Qu-16 ${kind} target must be an input source: ${target.id}`);
      const mix=canonicalMixDefinition(parts[2],{allowLr:kind!=="pre"}).label;
      assertBinaryValue(rawValue,parameterKey);
      const destination=kind==="assign"?assign:pre;
      if(!destination[mix])destination[mix]={};
      destination[mix][target.id]=Boolean(rawValue);
      continue;
    }

    if(kind==="process"){
      const parameter=parts[2];
      if(!processingParameters.has(parameter))throw new RangeError(`Unknown Qu-16 processing parameter: ${parameter}`);
      const binary=binaryProcessingParameters.has(parameter);
      binary?assertBinaryValue(rawValue,parameterKey):assertMidiValue(rawValue,parameterKey);
      if(!processing[target.id])processing[target.id]={};
      processing[target.id][parameter]=binary?Boolean(rawValue):midiToUiValue(rawValue);
      continue;
    }

    assertBinaryValue(rawValue,parameterKey);
    const active=Number(rawValue)!==0;
    if (kind==="mute") {
      if (target.kind==="master") ensureMaster(master,target.label).muted=active;
      else mute[target.id]=active;
      continue;
    }

    if (active) activePaflIds.add(target.id);
  }

  const paflTargets=QU16_TARGETS
    .filter(target=>activePaflIds.has(target.id))
    .map(target=>({ kind:target.kind,id:target.id }));

  return { levels,master,mute,paflTargets,pan,assign,pre,processing,muteGroups };
}

export function qu16IntentToWrite(intent){
  const key=qu16ControlCoalesceKey(intent);
  if(intent.kind==="fader"||intent.kind==="send"||intent.kind==="process"&&!binaryProcessingParameters.has(intent.parameter))return {key,value:uiToMidiValue(intent.value)};
  if(intent.kind==="pan")return {key,value:uiToPanValue(intent.value)};
  return {key,value:intent.value?1:0};
}
