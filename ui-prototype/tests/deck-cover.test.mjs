import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const rustSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("embedded audio artwork reaches both Deck cover slots with an icon fallback", () => {
  assert.match(rustSource, /cache_embedded_audio_cover/);
  assert.match(rustSource, /thumbnail_path: media_metadata\.thumbnail_path/);
  assert.match(appSource, /coverSrc: item\.thumbnailPath \? convertFileSrc\(item\.thumbnailPath\) : ""/);
  assert.match(appSource, /showCover\?<img src=\{track\.coverSrc\}/);
  assert.match(appSource, /:<MusicNotes weight="fill" \/>/);
  assert.match(stylesSource, /\.cover\.has-artwork img\{width:100%;height:100%;display:block;object-fit:cover\}/);
});
