export const MEDIA_SCAN_INTERVAL_MS = 30_000;
export const VIDEO_GRID_INITIAL_LIMIT = 48;
export const VIDEO_GRID_BATCH_SIZE = 48;

export function shouldQueueAudioAiAnalysis(processingAvailable, runtimeEnabled) {
  return processingAvailable === true && runtimeEnabled === true;
}

export function nextVideoRenderLimit(currentLimit, totalItems, batchSize = VIDEO_GRID_BATCH_SIZE) {
  const current = Math.max(0, Number(currentLimit) || 0);
  const total = Math.max(0, Number(totalItems) || 0);
  const batch = Math.max(1, Number(batchSize) || VIDEO_GRID_BATCH_SIZE);
  return Math.min(total, current + batch);
}

export function shouldExtendVideoGrid(metrics, threshold = 160) {
  const scrollTop = Math.max(0, Number(metrics?.scrollTop) || 0);
  const clientHeight = Math.max(0, Number(metrics?.clientHeight) || 0);
  const scrollHeight = Math.max(0, Number(metrics?.scrollHeight) || 0);
  return scrollTop + clientHeight >= Math.max(0, scrollHeight - threshold);
}
