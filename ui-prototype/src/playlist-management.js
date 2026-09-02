export const PLAYLIST_MANAGEMENT_STORAGE_KEY = "king.playlists.v1";

export const playlistWeekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const playlistSpecialDays = ["情人节", "七夕", "万圣节", "圣诞节", "跨年", "店庆", "活动"];

export function currentWeekdayPlaylistName(date = new Date()) {
  const day = date instanceof Date ? date.getDay() : Number.NaN;
  return Number.isInteger(day) ? playlistWeekdays[(day + 6) % 7] : playlistWeekdays[0];
}

const playlistId = (name) => `playlist:${name}`;

export function createDefaultPlaylistManagement() {
  const playlists = [
    ...playlistWeekdays.map((name) => ({ id: playlistId(name), name, kind: "weekday", trackPaths: [] })),
    ...playlistSpecialDays.map((name) => ({ id: playlistId(name), name, kind: "event", trackPaths: [] })),
  ];
  return {
    version: 1,
    seeded: false,
    playlists,
    dailySchedule: Object.fromEntries(playlistWeekdays.map((day) => [day, playlistId(day)])),
    trackBindings: {},
  };
}

const createEmptySecondaryLibrary = () => ({
  ...createDefaultPlaylistManagement(),
  seeded: true,
});

export function createDefaultPlaylistLibraries() {
  return {
    version: 2,
    libraries: {
      "1": createDefaultPlaylistManagement(),
      "2": createEmptySecondaryLibrary(),
    },
  };
}

export function normalizePlaylistManagement(value) {
  const fallback = createDefaultPlaylistManagement();
  if (!value || value.version !== 1 || !Array.isArray(value.playlists)) return fallback;
  const playlists = value.playlists
    .filter((playlist) => playlist && typeof playlist.id === "string" && typeof playlist.name === "string")
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name.trim() || "未命名歌单",
      kind: ["weekday", "event", "custom"].includes(playlist.kind) ? playlist.kind : "custom",
      trackPaths: [...new Set((playlist.trackPaths ?? []).filter((path) => typeof path === "string" && path))],
    }));
  if (!playlists.length) return fallback;
  return {
    version: 1,
    seeded: Boolean(value.seeded),
    playlists,
    dailySchedule: Object.fromEntries(playlistWeekdays.map((day) => {
      const requested = value.dailySchedule?.[day];
      const selected = playlists.some((playlist) => playlist.id === requested)
        ? requested
        : playlists.find((playlist) => playlist.name === day)?.id ?? playlists[0].id;
      return [day, selected];
    })),
    trackBindings: value.trackBindings && typeof value.trackBindings === "object" ? value.trackBindings : {},
  };
}

export function normalizePlaylistLibraries(value) {
  if (value?.version === 2 && value.libraries && typeof value.libraries === "object") {
    return {
      version: 2,
      libraries: {
        "1": normalizePlaylistManagement(value.libraries["1"]),
        "2": value.libraries["2"]
          ? normalizePlaylistManagement(value.libraries["2"])
          : createEmptySecondaryLibrary(),
      },
    };
  }
  if (value?.version === 1 && Array.isArray(value.playlists)) {
    return {
      version: 2,
      libraries: {
        "1": normalizePlaylistManagement(value),
        "2": createEmptySecondaryLibrary(),
      },
    };
  }
  return createDefaultPlaylistLibraries();
}

export function updatePlaylistLibrary(value, libraryNumber, updater) {
  const normalized = normalizePlaylistLibraries(value);
  const libraryKey = Number(libraryNumber) === 2 ? "2" : "1";
  const current = normalized.libraries[libraryKey];
  const requested = typeof updater === "function" ? updater(current) : updater;
  return {
    ...normalized,
    libraries: {
      ...normalized.libraries,
      [libraryKey]: normalizePlaylistManagement(requested),
    },
  };
}

export function createPlaylistPlaybackSource(libraryNumber, playlist) {
  if (!playlist?.id) return null;
  return {
    kind: "playlist",
    libraryKey: Number(libraryNumber) === 2 ? "2" : "1",
    playlistId: playlist.id,
  };
}

export function createWeekdayDeckPlaybackSources(value, weekdayName = currentWeekdayPlaylistName()) {
  const libraries = normalizePlaylistLibraries(value).libraries;
  return Object.fromEntries([1, 2].map((deckNumber) => {
    const libraryKey = String(deckNumber);
    const playlist = libraries[libraryKey].playlists.find((item) => item.name === weekdayName) ?? null;
    return [deckNumber, createPlaylistPlaybackSource(deckNumber, playlist)];
  }));
}

export function resolveWeekdayDeckStartupSelections(value, trackIndexByPath, weekdayName = currentWeekdayPlaylistName()) {
  const sources = createWeekdayDeckPlaybackSources(value, weekdayName);
  return Object.fromEntries([1, 2].map((deckNumber) => {
    const source = sources[deckNumber];
    const firstPath = resolvePlaybackQueuePaths(value, source)[0] ?? null;
    const resolvedIndex = firstPath ? trackIndexByPath.get(firstPath) : null;
    return [deckNumber, {
      source,
      firstPath,
      trackIndex:Number.isInteger(resolvedIndex) ? resolvedIndex : null,
    }];
  }));
}

export function resolvePlaybackQueuePaths(value, source) {
  if (source?.kind !== "playlist") return [];
  const libraries = normalizePlaylistLibraries(value).libraries;
  const management = libraries[source.libraryKey];
  const playlist = management?.playlists.find((item) => item.id === source.playlistId);
  return playlist ? [...playlist.trackPaths] : [];
}

export function seedPlaylistManagement(value, trackPaths, preferredName = "周六") {
  const normalized = normalizePlaylistManagement(value);
  if (normalized.seeded || !trackPaths.length) return normalized;
  const preferred = normalized.playlists.find((playlist) => playlist.name === preferredName) ?? normalized.playlists[0];
  return {
    ...normalized,
    seeded: true,
    playlists: normalized.playlists.map((playlist) => playlist.id === preferred.id
      ? { ...playlist, trackPaths: [...new Set(trackPaths)] }
      : playlist),
  };
}

export function updatePlaylistTracks(value, playlistIdValue, updater) {
  const normalized = normalizePlaylistManagement(value);
  return {
    ...normalized,
    playlists: normalized.playlists.map((playlist) => playlist.id === playlistIdValue
      ? { ...playlist, trackPaths: updater([...playlist.trackPaths]) }
      : playlist),
  };
}

export function movePlaylistTrack(paths, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= paths.length || toIndex >= paths.length) return paths;
  const next = [...paths];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function removePlaylistTrack(paths, trackPath) {
  if (typeof trackPath !== "string" || !trackPath) return paths;
  return paths.filter((path) => path !== trackPath);
}

export function movePlaylistWithinKind(value, playlistIdValue, direction) {
  const normalized = normalizePlaylistManagement(value);
  const sourceIndex = normalized.playlists.findIndex((playlist) => playlist.id === playlistIdValue);
  if (sourceIndex < 0 || ![-1, 1].includes(direction)) return normalized;
  const source = normalized.playlists[sourceIndex];
  const sameKindIndexes = normalized.playlists
    .map((playlist, index) => playlist.kind === source.kind ? index : -1)
    .filter((index) => index >= 0);
  const groupIndex = sameKindIndexes.indexOf(sourceIndex);
  const targetIndex = sameKindIndexes[groupIndex + direction];
  if (targetIndex === undefined) return normalized;
  const playlists = [...normalized.playlists];
  [playlists[sourceIndex], playlists[targetIndex]] = [playlists[targetIndex], playlists[sourceIndex]];
  return { ...normalized, playlists };
}

export function addPlaylistCategory(value, { id, name, kind } = {}) {
  const normalized = normalizePlaylistManagement(value);
  const safeName = String(name ?? "").trim();
  const safeKind = kind === "event" ? "event" : kind === "custom" ? "custom" : null;
  if (!safeName || !safeKind) return normalized;
  if (normalized.playlists.some((playlist) => playlist.name.toLocaleLowerCase() === safeName.toLocaleLowerCase())) return normalized;
  const safeId = typeof id === "string" && id ? id : `playlist:${safeKind}:${Date.now()}`;
  if (normalized.playlists.some((playlist) => playlist.id === safeId)) return normalized;
  return {
    ...normalized,
    playlists: [...normalized.playlists, { id:safeId, name:safeName, kind:safeKind, trackPaths:[] }],
  };
}

export function renamePlaylistCategory(value, playlistIdValue, name) {
  const normalized = normalizePlaylistManagement(value);
  const safeName = String(name ?? "").trim();
  const target = normalized.playlists.find((playlist) => playlist.id === playlistIdValue);
  if (!target || target.kind === "weekday" || !safeName) return normalized;
  if (normalized.playlists.some((playlist) => playlist.id !== playlistIdValue && playlist.name.toLocaleLowerCase() === safeName.toLocaleLowerCase())) return normalized;
  return {
    ...normalized,
    playlists: normalized.playlists.map((playlist) => playlist.id === playlistIdValue
      ? { ...playlist, name:safeName }
      : playlist),
  };
}

export function removePlaylistCategory(value, playlistIdValue) {
  const normalized = normalizePlaylistManagement(value);
  const target = normalized.playlists.find((playlist) => playlist.id === playlistIdValue);
  if (!target || target.kind === "weekday") return normalized;
  const playlists = normalized.playlists.filter((playlist) => playlist.id !== playlistIdValue);
  return {
    ...normalized,
    playlists,
    dailySchedule: Object.fromEntries(playlistWeekdays.map((day) => {
      const requested = normalized.dailySchedule[day];
      const fallback = playlists.find((playlist) => playlist.name === day) ?? playlists[0];
      return [day, requested === playlistIdValue ? fallback.id : requested];
    })),
  };
}
