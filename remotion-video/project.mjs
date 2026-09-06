import path from 'node:path';
import {
  downloadDriveFile,
  listDriveFolderFiles,
  readDriveJsonFile,
} from './drive.mjs';

const validEmotions = new Set(['normal', 'surprise', 'serious', 'smile']);

const asString = (value, fallback = '') =>
  typeof value === 'string' ? value : fallback;

export const prepareDriveProject = async ({
  videoPlanFileId,
  slidesFolderId,
  endingSlideFileId,
  outputDir,
  publicPrefix,
}) => {
  if (!videoPlanFileId || !slidesFolderId || !outputDir || !publicPrefix) {
    throw new Error(
      'videoPlanFileId, slidesFolderId, outputDir, and publicPrefix are required',
    );
  }

  const plan = await readDriveJsonFile(videoPlanFileId);
  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    throw new Error('video plan must contain a non-empty slides array');
  }

  const driveSlides = await listDriveFolderFiles(slidesFolderId);
  const slideByName = new Map(
    driveSlides
      .filter((file) => file?.id && file?.name)
      .map((file) => [file.name, file]),
  );

  const generatedFiles = [];
  const scenes = [];

  for (const [index, slide] of plan.slides.entries()) {
    const filename = asString(
      slide.filename,
      `slide_${String(index + 1).padStart(3, '0')}.png`,
    );

    let driveFileId = null;
    let localFilename = filename;

    if (slide.fixed_asset) {
      if (!endingSlideFileId) {
        throw new Error(
          `Slide ${slide.id || index} requires fixed_asset but endingSlideFileId was not supplied`,
        );
      }
      driveFileId = endingSlideFileId;
      localFilename = 'ending_slide.png';
    } else {
      const file = slideByName.get(filename);
      if (!file?.id) {
        throw new Error(`Drive slide not found: ${filename}`);
      }
      driveFileId = file.id;
    }

    const outputPath = path.join(outputDir, localFilename);
    await downloadDriveFile({fileId: driveFileId, outputPath});
    generatedFiles.push(outputPath);

    scenes.push({
      from: 0,
      duration: 1,
      title: asString(
        slide.display_title,
        asString(slide.headline, asString(slide.section, '')),
      ),
      body: asString(
        slide.subtitle,
        asString(slide.subheadline, asString(slide.slide_text, '')),
      ),
      narration: asString(slide.narration, asString(slide.source_text, '')),
      emotion: validEmotions.has(slide.emotion) ? slide.emotion : 'normal',
      slideSrc: `${publicPrefix}/${localFilename}`,
    });
  }

  return {
    plan,
    generatedFiles,
    props: {
      scenes,
      tts_voice: asString(plan.tts_voice, 'marin'),
      tts_speed:
        typeof plan.tts_speed === 'number' && Number.isFinite(plan.tts_speed)
          ? plan.tts_speed
          : 1.18,
      bgmAsset: asString(plan.bgm_asset, 'common/bgm/main_bgm.mp3'),
      bgmLoop: plan.bgm_loop !== false,
      bgmVolume:
        typeof plan.bgm_volume === 'number' && Number.isFinite(plan.bgm_volume)
          ? plan.bgm_volume
          : 0.02,
      bgmFadeInFrames:
        typeof plan.bgm_fade_in_frames === 'number'
          ? plan.bgm_fade_in_frames
          : 30,
      bgmFadeOutFrames:
        typeof plan.bgm_fade_out_frames === 'number'
          ? plan.bgm_fade_out_frames
          : 45,
    },
  };
};
