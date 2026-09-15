import path from 'node:path';
import {
  downloadDriveFile,
  listDriveFolderFiles,
} from './drive.mjs';

const folderId = String(process.env.BGM_DRIVE_FOLDER_ID || '').trim();
if (!folderId) {
  throw new Error('BGM_DRIVE_FOLDER_ID is required');
}

const outputDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve('public/common/bgm');

const requiredNames = ['main_bgm.mp3', 'ending_bgm.mp3'];
const files = await listDriveFolderFiles(folderId);

for (const name of requiredNames) {
  const matches = files.filter((file) => file?.name === name && file?.id);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${name} in Drive BGM folder, found ${matches.length}`,
    );
  }

  const outputPath = path.join(outputDir, name);
  await downloadDriveFile({
    fileId: matches[0].id,
    outputPath,
  });
  console.log(`Downloaded ${name} -> ${outputPath}`);
}
