// PGM owns a frozen queue. Browsing PVW or another folder must not reroute it.
export function captureVideoQueue(videos, category, firstId) {
  const selected = videos.find((video) => video.id === firstId);
  const folder = category === "全部" || videos.some((video) => video.id === firstId && video.category === category)
    ? category : selected?.category;
  const ids = [...new Set(videos.filter((video) => video.src && (folder === "全部" || video.category === folder)).map((video) => video.id))];
  return ids.includes(firstId) ? ids : selected?.src ? [firstId] : [];
}

export function nextProgramVideo(playback, ended, videos) {
  if (playback.mode !== "sequence" || ended?.token !== playback.token || ended?.mediaId !== playback.mediaId) return null;
  const assets = new Map(videos.filter((video) => video.src).map((video) => [video.id, video]));
  const position = playback.queueIds.indexOf(playback.mediaId);
  // Use the captured positions even if the current file has since disappeared.
  for (let step = 1; step <= playback.queueIds.length; step += 1) {
    const id = playback.queueIds[(position + step) % playback.queueIds.length];
    if (assets.has(id)) return assets.get(id);
  }
  return null;
}
