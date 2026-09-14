import path from 'node:path';
import {mkdir, rm, stat} from 'node:fs/promises';
import {downloadDriveFile, listDriveFolderFiles} from './drive.mjs';

const folderId =
  process.env.CHARACTERS_DRIVE_FOLDER_ID || '1ucqNuaEwnAumEXYnzb3PRP2-fVzJpE6g';

const expected = [
  'body_normal.png',
  'body_point_up.png',
  'body_caution.png',
  'body_positive.png',
  'body_explain.png',
  'head_base.png',
  'hair_back.png',
  'hair_front.png',
  'eyebrow_normal.png',
  'eyebrow_serious.png',
  'eyebrow_surprise.png',
  'eyebrow_smile.png',
  'eyes_open.png',
  'eyes_closed.png',
  'eyes_surprise.png',
  'eyes_smile.png',
  'pupil_left.png',
  'pupil_right.png',
  'mouth_closed.png',
  'mouth_half.png',
  'mouth_open.png',
  'mouth_smile_closed.png',
  'mouth_smile_half.png',
  'mouth_smile_open.png',
];

const outputDir = path.resolve('public', 'characters');

await rm(outputDir, {recursive: true, force: true});
await mkdir(outputDir, {recursive: true});

const files = await listDriveFolderFiles(folderId);
const byName = new Map();
for (const file of files) {
  if (!file?.name) continue;
  if (byName.has(file.name)) {
    throw new Error(`Duplicate character asset in Drive folder: ${file.name}`);
  }
  byName.set(file.name, file);
}

const missing = expected.filter((name) => !byName.has(name));
if (missing.length) {
  throw new Error(
    `Missing ${missing.length} character assets in Drive folder ${folderId}: ${missing.join(', ')}`,
  );
}

for (const name of expected) {
  const file = byName.get(name);
  const outputPath = path.join(outputDir, name);
  await downloadDriveFile({fileId: file.id, outputPath});
  const info = await stat(outputPath);
  if (info.size <= 0) throw new Error(`Downloaded empty asset: ${name}`);
  console.log(`${name}\t${info.size} bytes\t${file.id}`);
}

console.log(`Character assets ready: ${expected.length}/24`);
console.log(`Source Drive folder: ${folderId}`);
console.log(`Output: ${outputDir}`);
