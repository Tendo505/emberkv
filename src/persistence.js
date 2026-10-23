// Snapshot persistence: the whole keyspace is written as JSON to a temp file
// and atomically renamed over the previous snapshot, so a crash mid-save can
// never leave a half-written database behind.

import fs from "node:fs";
import path from "node:path";

export function saveSnapshot(store, file) {
  const snapshot = store.snapshot();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, file);
  store.dirty = 0;
  return snapshot.entries.length;
}

/** Load a snapshot if one exists. Returns the number of keys restored. */
export function loadSnapshot(store, file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error(`snapshot ${file} is corrupt (invalid JSON); move it aside to start fresh`);
  }
  store.restore(snapshot);
  return store.data.size;
}
