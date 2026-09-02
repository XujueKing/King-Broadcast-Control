import test from "node:test";
import assert from "node:assert/strict";
import {
  addPlaylistCategory,
  createDefaultPlaylistManagement,
  createDefaultPlaylistLibraries,
  createPlaylistPlaybackSource,
  createWeekdayDeckPlaybackSources,
  currentWeekdayPlaylistName,
  movePlaylistWithinKind,
  movePlaylistTrack,
  normalizePlaylistManagement,
  normalizePlaylistLibraries,
  removePlaylistTrack,
  removePlaylistCategory,
  renamePlaylistCategory,
  resolvePlaybackQueuePaths,
  resolveWeekdayDeckStartupSelections,
  seedPlaylistManagement,
  updatePlaylistTracks,
  updatePlaylistLibrary,
} from "../src/playlist-management.js";

test("startup playlist follows the local weekday", () => {
  assert.equal(currentWeekdayPlaylistName(new Date(2026, 7, 31, 12)), "周一");
  assert.equal(currentWeekdayPlaylistName(new Date(2026, 8, 6, 12)), "周日");
  assert.equal(currentWeekdayPlaylistName(new Date("invalid")), "周一");
});

test("default playlist management has weekdays and daily assignments", () => {
  const state = createDefaultPlaylistManagement();
  assert.equal(state.playlists.filter((playlist) => playlist.kind === "weekday").length, 7);
  assert.equal(state.dailySchedule.周一, "playlist:周一");
});

test("the two libraries own independent playlist suites", () => {
  const state = createDefaultPlaylistLibraries();
  assert.equal(state.version, 2);
  assert.equal(state.libraries["1"].seeded, false);
  assert.equal(state.libraries["2"].seeded, true);
  assert.notEqual(state.libraries["1"].playlists, state.libraries["2"].playlists);

  const updated = updatePlaylistLibrary(state, 2, (library) => updatePlaylistTracks(
    library,
    "playlist:周一",
    () => ["library-two.mp3"],
  ));
  assert.deepEqual(updated.libraries["2"].playlists[0].trackPaths, ["library-two.mp3"]);
  assert.deepEqual(updated.libraries["1"].playlists[0].trackPaths, []);
});

test("Deck playback source stays on its loaded category while L browses elsewhere", () => {
  let state = createDefaultPlaylistLibraries();
  state = updatePlaylistLibrary(state, 1, (management) => updatePlaylistTracks(
    management,
    "playlist:周一",
    () => ["monday-1.mp3", "monday-2.mp3"],
  ));
  state = updatePlaylistLibrary(state, 1, (management) => updatePlaylistTracks(
    management,
    "playlist:周二",
    () => ["tuesday-1.mp3", "tuesday-2.mp3"],
  ));
  const monday = state.libraries["1"].playlists.find((playlist) => playlist.name === "周一");
  const source = createPlaylistPlaybackSource(1, monday);

  assert.deepEqual(resolvePlaybackQueuePaths(state, source), ["monday-1.mp3", "monday-2.mp3"]);
  assert.deepEqual(resolvePlaybackQueuePaths(state, { kind:"single" }), []);
});

test("cold-start Deck sources use today's category from their matching libraries", () => {
  let state = createDefaultPlaylistLibraries();
  state = updatePlaylistLibrary(state, 1, (management) => ({
    ...updatePlaylistTracks(management, "playlist:周一", () => ["library-1-monday.mp3"]),
    seeded:true,
  }));
  state = updatePlaylistLibrary(state, 2, (management) => updatePlaylistTracks(
    management,
    "playlist:周一",
    () => ["library-2-monday.mp3"],
  ));
  const sources = createWeekdayDeckPlaybackSources(state, "周一");

  assert.equal(sources[1].libraryKey, "1");
  assert.equal(sources[2].libraryKey, "2");
  assert.deepEqual(resolvePlaybackQueuePaths(state, sources[1]), ["library-1-monday.mp3"]);
  assert.deepEqual(resolvePlaybackQueuePaths(state, sources[2]), ["library-2-monday.mp3"]);
});

test("cold-start Decks resolve independently and wait for the actual first song", () => {
  let state = createDefaultPlaylistLibraries();
  state = updatePlaylistLibrary(state, 1, (management) => ({
    ...updatePlaylistTracks(management, "playlist:周一", () => ["first.mp3", "second.mp3"]),
    seeded:true,
  }));
  state = updatePlaylistLibrary(state, 2, (management) => updatePlaylistTracks(
    management,
    "playlist:周一",
    () => ["library-2-first.mp3"],
  ));

  const partial = resolveWeekdayDeckStartupSelections(state, new Map([
    ["second.mp3", 8],
    ["library-2-first.mp3", 12],
  ]), "周一");
  assert.equal(partial[1].trackIndex, null);
  assert.equal(partial[2].trackIndex, 12);

  const complete = resolveWeekdayDeckStartupSelections(state, new Map([
    ["first.mp3", 7],
    ["second.mp3", 8],
    ["library-2-first.mp3", 12],
  ]), "周一");
  assert.equal(complete[1].trackIndex, 7);
  assert.equal(complete[2].trackIndex, 12);
});

test("legacy single-library data migrates into library one without duplication", () => {
  const legacy = updatePlaylistTracks(createDefaultPlaylistManagement(), "playlist:周三", () => ["kept.mp3"]);
  const migrated = normalizePlaylistLibraries(legacy);
  assert.deepEqual(migrated.libraries["1"].playlists.find((item) => item.name === "周三").trackPaths, ["kept.mp3"]);
  assert.deepEqual(migrated.libraries["2"].playlists.find((item) => item.name === "周三").trackPaths, []);
  assert.equal(migrated.libraries["2"].seeded, true);
});

test("first media scan seeds only the preferred playlist", () => {
  const state = seedPlaylistManagement(createDefaultPlaylistManagement(), ["a.mp3", "b.mp3"], "周六");
  assert.deepEqual(state.playlists.find((playlist) => playlist.name === "周六").trackPaths, ["a.mp3", "b.mp3"]);
  assert.deepEqual(state.playlists.find((playlist) => playlist.name === "周日").trackPaths, []);
  assert.equal(state.seeded, true);
});

test("playlist membership is unique and reorderable", () => {
  const state = updatePlaylistTracks(createDefaultPlaylistManagement(), "playlist:周一", (paths) => [...new Set([...paths, "a", "b", "a"])]);
  assert.deepEqual(state.playlists[0].trackPaths, ["a", "b"]);
  assert.deepEqual(movePlaylistTrack(state.playlists[0].trackPaths, 1, 0), ["b", "a"]);
  assert.deepEqual(removePlaylistTrack(["a", "b", "c"], "b"), ["a", "c"]);
});

test("playlist categories move only inside their own group", () => {
  const state = createDefaultPlaylistManagement();
  const moved = movePlaylistWithinKind(state, "playlist:周二", -1);
  assert.deepEqual(moved.playlists.slice(0, 3).map((playlist) => playlist.name), ["周二", "周一", "周三"]);
  assert.equal(moved.playlists.findIndex((playlist) => playlist.name === "情人节"), 7);
  assert.deepEqual(movePlaylistWithinKind(moved, "playlist:周二", -1).playlists, moved.playlists);
});

test("event and custom categories support add rename reorder and delete", () => {
  let state = createDefaultPlaylistManagement();
  state = addPlaylistCategory(state, { id:"playlist:event:summer", name:"夏日派对", kind:"event" });
  state = addPlaylistCategory(state, { id:"playlist:custom:vip", name:"VIP 暖场", kind:"custom" });
  assert.equal(state.playlists.find((item) => item.id === "playlist:event:summer").kind, "event");
  assert.equal(state.playlists.find((item) => item.id === "playlist:custom:vip").kind, "custom");

  state = renamePlaylistCategory(state, "playlist:event:summer", "夏季活动");
  assert.equal(state.playlists.find((item) => item.id === "playlist:event:summer").name, "夏季活动");
  const moved = movePlaylistWithinKind(state, "playlist:event:summer", -1);
  assert.ok(moved.playlists.findIndex((item) => item.id === "playlist:event:summer") < state.playlists.findIndex((item) => item.id === "playlist:event:summer"));

  state = { ...moved, dailySchedule:{ ...moved.dailySchedule, 周一:"playlist:event:summer" } };
  state = removePlaylistCategory(state, "playlist:event:summer");
  assert.equal(state.playlists.some((item) => item.id === "playlist:event:summer"), false);
  assert.equal(state.dailySchedule.周一, "playlist:周一");
});

test("weekday categories keep their fixed names and cannot be deleted", () => {
  const state = createDefaultPlaylistManagement();
  assert.deepEqual(renamePlaylistCategory(state, "playlist:周一", "星期一").playlists, state.playlists);
  assert.deepEqual(removePlaylistCategory(state, "playlist:周一").playlists, state.playlists);
});

test("normalization rejects malformed saved state", () => {
  assert.equal(normalizePlaylistManagement({ version: 9 }).playlists.length, 14);
});
