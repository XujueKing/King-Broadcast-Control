export const lightingAutomationPolicy = Object.freeze({
  rhythmSwitchMs: 2_400,
  videoHoldMs: 8_000,
  colorSwitchMs: 6_000,
});

const createLane = () => ({ lastPresetId: null, lastSource: null, lastAt: 0, holdUntil: 0 });

export const createLightingAutomationState = () => ({ scene: createLane(), accent: createLane() });

const normalizedSource = (source) => {
  if (source === "rhythm" || source === "video" || source === "video-color") return source;
  return "manual";
};

const laneForSource = (source) => (source === "rhythm" ? "accent" : "scene");

export const lightingCueIsAuthorized = ({
  source = "manual",
  presetId,
  titanId,
  effectRegistry,
}) => {
  if (source === "manual") return true;
  if (!["rhythm","video","video-color"].includes(source)) return false;
  const numericPresetId=Number(presetId);
  const numericTitanId=Number(titanId);
  const effect=(effectRegistry??[]).find((candidate)=>
    Number(candidate?.presetId)===numericPresetId
      || (Number.isSafeInteger(numericTitanId)
        && Number(candidate?.titanHandle)===numericTitanId),
  );
  return effect?.safeAuto===true && effect.layer!=="event";
};

export const planLightingCue = (
  currentState,
  { presetId, source = "manual" },
  now = Date.now(),
  policy = lightingAutomationPolicy,
) => {
  const state = currentState ?? createLightingAutomationState();
  const cueSource = normalizedSource(source);
  const lane = laneForSource(cueSource);
  const numericPresetId = Number(presetId);
  if (!Number.isInteger(numericPresetId) || numericPresetId < 0) {
    return { accepted: false, reason: "invalid-preset", lane, state };
  }

  if (cueSource === "manual") {
    const reset = createLightingAutomationState();
    reset.scene = { lastPresetId: numericPresetId, lastSource: cueSource, lastAt: now, holdUntil: 0 };
    return { accepted: true, reason: "manual", lane: "scene", state: reset };
  }

  const laneState = state[lane] ?? createLane();
  if (laneState.lastPresetId === numericPresetId) {
    return { accepted: false, reason: "duplicate", lane, state };
  }
  if (cueSource === "video-color" && now < laneState.holdUntil) {
    return { accepted: false, reason: "category-hold", lane, state };
  }
  const minimumSwitchMs = cueSource === "rhythm" ? policy.rhythmSwitchMs
    : cueSource === "video-color" ? policy.colorSwitchMs
      : 0;
  if (minimumSwitchMs > 0 && laneState.lastAt > 0 && now - laneState.lastAt < minimumSwitchMs) {
    return { accepted: false, reason: "cooldown", lane, state };
  }

  return {
    accepted: true,
    reason: cueSource,
    lane,
    state: {
      ...state,
      [lane]: {
        ...laneState,
        lastPresetId: numericPresetId,
        lastSource: cueSource,
        lastAt: now,
        holdUntil: cueSource === "video" ? now + policy.videoHoldMs : laneState.holdUntil,
      },
    },
  };
};
