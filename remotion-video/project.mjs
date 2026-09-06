import path from 'node:path';
import {readFile} from 'node:fs/promises';
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
          : 0.025,
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


const SPRITE_PLAN_MARKER = Buffer.from('\n---TERRADONE_PLAN_JSON---\n', 'utf8');

export const prepareSpriteProject = async ({
  spritePlanFileId,
  endingSlideFileId,
  outputDir,
  publicPrefix,
  columns = 4,
}) => {
  if (!spritePlanFileId || !endingSlideFileId || !outputDir || !publicPrefix) {
    throw new Error(
      'spritePlanFileId, endingSlideFileId, outputDir, and publicPrefix are required',
    );
  }

  const spriteFilename = 'terradone_sprite_plan.jpg';
  const spritePath = path.join(outputDir, spriteFilename);
  await downloadDriveFile({fileId: spritePlanFileId, outputPath: spritePath});

  const spriteBuffer = await readFile(spritePath);
  const markerIndex = spriteBuffer.lastIndexOf(SPRITE_PLAN_MARKER);
  if (markerIndex < 0) {
    throw new Error('Embedded video plan marker not found in sprite file');
  }

  const planText = spriteBuffer
    .subarray(markerIndex + SPRITE_PLAN_MARKER.length)
    .toString('utf8');
  const plan = JSON.parse(planText);

  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    throw new Error('embedded video plan must contain a non-empty slides array');
  }

  const generatedSlideCount = plan.slides.filter((slide) => !slide.fixed_asset).length;
  const rows = Math.ceil(generatedSlideCount / columns);

  const endingFilename = 'ending_slide.png';
  const endingPath = path.join(outputDir, endingFilename);
  await downloadDriveFile({fileId: endingSlideFileId, outputPath: endingPath});

  let spriteIndex = 0;
  const scenes = plan.slides.map((slide) => {
    const base = {
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
    };

    if (slide.fixed_asset) {
      return {
        ...base,
        slideSrc: `${publicPrefix}/${endingFilename}`,
      };
    }

    const currentIndex = spriteIndex++;
    return {
      ...base,
      slideSpriteSrc: `${publicPrefix}/${spriteFilename}`,
      slideSpriteIndex: currentIndex,
      slideSpriteColumns: columns,
      slideSpriteRows: rows,
    };
  });

  return {
    plan,
    generatedFiles: [spritePath, endingPath],
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
          : 0.025,
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


export const prepareEmbeddedSpriteProject = async ({
  spritePath,
  publicPrefix,
  columns = 4,
}) => {
  if (!spritePath || !publicPrefix) {
    throw new Error('spritePath and publicPrefix are required');
  }

  const spriteBuffer = await readFile(spritePath);
  const markerIndex = spriteBuffer.lastIndexOf(SPRITE_PLAN_MARKER);
  if (markerIndex < 0) {
    throw new Error('Embedded video plan marker not found in uploaded sprite');
  }

  const plan = JSON.parse(
    spriteBuffer
      .subarray(markerIndex + SPRITE_PLAN_MARKER.length)
      .toString('utf8'),
  );

  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    throw new Error('embedded video plan must contain a non-empty slides array');
  }

  const rows = Math.ceil(plan.slides.length / columns);
  const spriteFilename = path.basename(spritePath);

  const scenes = plan.slides.map((slide, index) => ({
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
    slideSpriteSrc: `${publicPrefix}/${spriteFilename}`,
    slideSpriteIndex: index,
    slideSpriteColumns: columns,
    slideSpriteRows: rows,
  }));

  return {
    plan,
    generatedFiles: [spritePath],
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
          : 0.025,
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


export const prepareLocalProject = async ({
  projectDir,
  publicPrefix,
}) => {
  if (!projectDir || !publicPrefix) {
    throw new Error('projectDir and publicPrefix are required');
  }

  const planPath = path.join(projectDir, 'video_plan.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));

  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    throw new Error('local video plan must contain a non-empty slides array');
  }

  const scenes = plan.slides.map((slide, index) => {
    const defaultFilename = `slide_${String(index + 1).padStart(3, '0')}.webp`;
    const filename = asString(slide.filename, defaultFilename);
    const localFilename = slide.fixed_asset
      ? 'ending_slide.webp'
      : path.posix.join('slides', filename);

    return {
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
    };
  });

  return {
    plan,
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
          : 0.025,
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
