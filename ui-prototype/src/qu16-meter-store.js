const listeners = new Set();

let currentSnapshot = null;
let pendingSnapshot = null;
let flushTimer = null;
let lastFlushAt = 0;

// The Qu-16 transport can publish about 20 meter frames per second.  Keeping
// those frames outside App prevents the complete library/video workspace from
// re-rendering for every meter packet.  The console receives a coalesced 12.5
// FPS stream, which is responsive enough for its LEDs while leaving pointer
// interaction and media rendering time on the UI thread.
const FRAME_INTERVAL_MS = 80;

function notify() {
  for (const listener of listeners) listener();
}

function flush() {
  flushTimer = null;
  if (pendingSnapshot === null) return;
  currentSnapshot = pendingSnapshot;
  pendingSnapshot = null;
  lastFlushAt = Date.now();
  notify();
}

export function publishQu16MeterSnapshot(snapshot) {
  pendingSnapshot = snapshot;
  const elapsed = Date.now() - lastFlushAt;
  if (elapsed >= FRAME_INTERVAL_MS) {
    if (flushTimer !== null) globalThis.clearTimeout(flushTimer);
    flush();
    return;
  }
  if (flushTimer === null) flushTimer = globalThis.setTimeout(flush, FRAME_INTERVAL_MS - elapsed);
}

export function clearQu16MeterSnapshot() {
  pendingSnapshot = null;
  if (flushTimer !== null) globalThis.clearTimeout(flushTimer);
  flushTimer = null;
  if (currentSnapshot === null) return;
  currentSnapshot = null;
  notify();
}

export function subscribeQu16MeterSnapshot(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQu16MeterSnapshot() {
  return currentSnapshot;
}
