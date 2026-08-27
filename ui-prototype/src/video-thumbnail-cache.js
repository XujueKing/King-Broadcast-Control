import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const thumbnailUrls = new Map();
const pendingByKey = new Map();
const workQueue = [];
let activeJobs = 0;

export const videoThumbnailCacheKey = (item) => [
  item?.path ?? item?.src ?? item?.id ?? "unknown-video",
  Number(item?.sizeBytes ?? 0),
  Number(item?.modifiedUnixMs ?? 0),
].join("|");

const drainQueue = () => {
  if (activeJobs >= 1) return;
  const next = workQueue.shift();
  if (!next) return;
  activeJobs += 1;
  invoke("ensure_video_thumbnail", { path:next.path })
    .then((thumbnailPath) => convertFileSrc(thumbnailPath))
    .then(next.resolve, next.reject)
    .finally(() => {
      activeJobs -= 1;
      drainQueue();
    });
};

const queuePersistentThumbnail = (path) => new Promise((resolve, reject) => {
  workQueue.push({ path, resolve, reject });
  drainQueue();
});

export async function getPersistentVideoThumbnail(item) {
  if (!item?.path) return item?.src ?? "";
  const key = videoThumbnailCacheKey(item);
  const cachedUrl = thumbnailUrls.get(key);
  if (cachedUrl) return cachedUrl;

  let pending = pendingByKey.get(key);
  if (!pending) {
    pending = queuePersistentThumbnail(item.path)
      .then((url) => {
        thumbnailUrls.set(key, url);
        return url;
      })
      .finally(() => pendingByKey.delete(key));
    pendingByKey.set(key, pending);
  }
  return pending;
}

export function prewarmPersistentVideoThumbnails(items) {
  for (const item of items) {
    if (!item?.path || item.thumbnailSrc) continue;
    void getPersistentVideoThumbnail(item).catch((error) => {
      console.warn(`视频缩略图预生成失败：${item.name ?? item.path}`, error);
    });
  }
}
