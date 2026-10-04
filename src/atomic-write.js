import { writeFileSync, renameSync } from 'node:fs';

/** Write through a temp file and rename, so a crash never leaves a truncated file behind. */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
