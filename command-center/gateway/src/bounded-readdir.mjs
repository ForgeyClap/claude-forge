// One folder listing with a hard entry budget (Codex run B F-05/F-06, verification 2026-09-28).
//
// fs.readdirSync() builds the WHOLE listing in memory before any cap can apply, so a folder with a
// huge number of entries could block the single-threaded gateway on an ordinary GET. This reads the
// entries one at a time and stops at `maxEntries`, and says so (`truncated`) instead of cutting silently.
import fs from 'node:fs';

/** readDirBounded(dir, maxEntries) -> { entries: fs.Dirent[], truncated }. Throws exactly like
 *  fs.readdirSync() when the folder cannot be opened, so callers keep their own catch. */
export function readDirBounded(dir, maxEntries) {
  const d = fs.opendirSync(dir);
  const entries = [];
  let truncated = false;
  try {
    let e = d.readSync();
    while (e !== null) {
      if (entries.length >= maxEntries) { truncated = true; break; }
      entries.push(e);
      e = d.readSync();
    }
  } finally {
    d.closeSync();
  }
  return { entries, truncated };
}
