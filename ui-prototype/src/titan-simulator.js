const emptyActive = () => ({ scene: null, accent: null });

export const createTitanSimulatorState = () => ({
  active: emptyActive(),
  revision: 0,
  history: [],
});

export const simulateTitanCue = (
  currentState,
  { presetId, lane = "scene", source = "manual" },
  at = Date.now(),
) => {
  const numericPresetId = Number(presetId);
  if (!Number.isInteger(numericPresetId) || numericPresetId < 0 || numericPresetId > 9) {
    return { accepted: false, state: currentState ?? createTitanSimulatorState() };
  }
  const current = currentState ?? createTitanSimulatorState();
  const targetLane = lane === "accent" ? "accent" : "scene";
  const active = source === "manual" ? emptyActive() : { ...current.active };
  active[targetLane] = numericPresetId;
  const event = { presetId: numericPresetId, lane: targetLane, source, at };
  return {
    accepted: true,
    event,
    state: {
      active,
      revision: current.revision + 1,
      history: [...current.history, event].slice(-100),
    },
  };
};

export const clearTitanSimulator = (currentState, at = Date.now()) => {
  const current = currentState ?? createTitanSimulatorState();
  const event = { presetId: null, lane: "all", source: "pause", at };
  return {
    active: emptyActive(),
    revision: current.revision + 1,
    history: [...current.history, event].slice(-100),
  };
};

export const isTitanPresetSimulated = (state, presetId) => (
  Object.values(state?.active ?? {}).includes(Number(presetId))
);
