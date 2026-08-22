const assetSignature = (item) => [
  item?.path,
  Number(item?.sizeBytes) || 0,
  Number(item?.modifiedUnixMs) || 0,
].join(":");

/**
 * Keeps files that are still being copied out of the live library.
 * Existing assets retain their previous metadata until the scan is stable, so
 * a growing download cannot reload an active Deck.
 */
export const reconcileStableAssets = (current, scanned, tracker, options = {}) => {
  const requiredUnchangedScans = Math.max(1, Number(options.requiredUnchangedScans) || 1);
  const minimumAgeMs = Math.max(0, Number(options.minimumAgeMs) || 10_000);
  const nowMs = Number(options.nowMs) || Date.now();
  const preservePaths = new Set(options.preservePaths ?? []);
  const currentByPath = new Map((current ?? []).map((item)=>[item.path,item]));
  const scannedPaths = new Set();
  const accepted = [];

  for (const item of scanned ?? []) {
    if (!item?.path) continue;
    scannedPaths.add(item.path);
    const signature = assetSignature(item);
    const previous = tracker.get(item.path);
    const unchangedScans = previous?.signature === signature ? previous.unchangedScans + 1 : 0;
    tracker.set(item.path, { signature, unchangedScans });
    const ageMs = nowMs - (Number(item.modifiedUnixMs) || nowMs);
    const stable = unchangedScans >= requiredUnchangedScans || ageMs >= minimumAgeMs;
    const existing = currentByPath.get(item.path);
    if (stable) accepted.push(item);
    else if (existing) accepted.push(existing);
  }

  for (const item of current ?? []) {
    if (!scannedPaths.has(item.path) && preservePaths.has(item.path)) accepted.push(item);
  }
  for (const path of [...tracker.keys()]) {
    if (!scannedPaths.has(path) && !preservePaths.has(path)) tracker.delete(path);
  }
  return accepted;
};
