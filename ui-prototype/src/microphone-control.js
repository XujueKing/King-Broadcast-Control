import { midiToUiValue, qu16IntentToWrite, qu16TargetId } from "./qu16-control.js";

export function homeMicrophoneBindings(model) {
  const bindings = model?.ui?.homeMicrophones;
  if (!Array.isArray(bindings)) return [];
  return bindings.map((binding) => ({
    ...binding,
    targets: [...new Set((binding.targets ?? []).map(qu16TargetId))],
  })).filter((binding) => binding.id && binding.label && binding.targets.length > 0);
}

export function microphoneFaderReadback(snapshot, binding) {
  const targets = binding?.targets ?? [];
  const rawValues = targets.map((target) => snapshot?.parameters?.[`fader:${target}`]);
  const available = targets.length > 0
    && rawValues.every((value) => Number.isInteger(value) && value >= 0 && value <= 127);
  if (!available) {
    return { available:false, value:null, synchronized:false, pending:false, rawValues:[] };
  }
  const values = rawValues.map(midiToUiValue);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    available:true,
    value:Math.round(values.reduce((total, value) => total + value, 0) / values.length),
    synchronized:maximum - minimum <= 1,
    pending:targets.some((target) => Boolean(snapshot?.pendingDetails?.[`fader:${target}`])),
    rawValues,
  };
}

export function microphoneFaderWrites(binding, value) {
  if (!binding?.targets?.length) throw new RangeError("Microphone binding has no Qu-16 target");
  return binding.targets.map((target) => qu16IntentToWrite({ kind:"fader", target, value }));
}
