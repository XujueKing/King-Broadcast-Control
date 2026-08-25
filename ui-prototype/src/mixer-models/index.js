import qu16 from "./allen-heath-qu16/model.json";

export const mixerModels = [qu16];
export const defaultMixerModelId = qu16.id;

export function mixerModelById(id) {
  return mixerModels.find((model) => model.id === id) ?? qu16;
}
