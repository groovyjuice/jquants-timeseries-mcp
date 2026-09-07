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


const getScriptBlocksByLineRange = (script, startLine, endLine) => {
  const lines = String(script ?? '').split(/\r?\n/);
  const selected = lines.slice(Math.max(0, startLine - 1), endLine);
  const blocks = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      blocks.push(current.join(''));
      current = [];
    }
  };

  for (const rawLine of selected) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (line) current.push(line);
    else flush();
  }
  flush();
  return blocks;
};

const splitNarrationBlocks = (blocks, count) => {
  if (count <= 1) return [blocks.join('')];
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let remainingTotal = total;
  let remainingCount = count;

  for (const block of blocks) {
    if (remainingCount > 1) {
      const target = remainingTotal / remainingCount;
      if (
        current.length &&
        currentLength >= target * 0.75 &&
        currentLength + block.length > target * 1.15
      ) {
        chunks.push(current);
        remainingTotal -= currentLength;
        remainingCount -= 1;
        current = [];
        currentLength = 0;
      }
    }
    current.push(block);
    currentLength += block.length;
  }
  if (current.length) chunks.push(current);

  while (chunks.length < count) {
    let largestIndex = 0;
    let largestLength = -1;
    for (let i = 0; i < chunks.length; i++) {
      const length = chunks[i].reduce((sum, block) => sum + block.length, 0);
      if (length > largestLength && chunks[i].length > 1) {
        largestIndex = i;
        largestLength = length;
      }
    }
    const chunk = chunks[largestIndex];
    if (!chunk || chunk.length <= 1) break;

    const chunkTotal = chunk.reduce((sum, block) => sum + block.length, 0);
    let cumulative = 0;
    let splitAt = 1;
    for (let i = 0; i < chunk.length - 1; i++) {
      cumulative += chunk[i].length;
      splitAt = i + 1;
      if (cumulative >= chunkTotal / 2) break;
    }
    chunks.splice(largestIndex, 1, chunk.slice(0, splitAt), chunk.slice(splitAt));
  }

  while (chunks.length > count) {
    const tail = chunks.pop();
    chunks[chunks.length - 1].push(...tail);
  }

  return chunks.map((chunk) => chunk.join(''));
};

const applyHowaBeginnerScriptOverride = (plan, script) => {
  const mapping = [
    [[3, 62], [5, 6, 7, 8, 9]],
    [[65, 98], [11, 12, 13]],
    [[101, 128], [14, 15]],
    [[131, 180], [16, 17]],
    [[183, 218], [18, 19]],
    [[221, 240], [21]],
    [[243, 258], [22]],
    [[261, 280], [23]],
    [[283, 330], [24, 25]],
    [[333, 354], [26]],
    [[357, 388], [28, 29, 30]],
    [[391, 402], [31]],
    [[405, 420], [33]],
    [[423, 448], [34, 35]],
    [[451, 474], [36, 37]],
    [[477, 502], [38, 39]],
    [[505, 552], [41, 42, 43, 44]],
    [[555, 614], [46, 47, 48, 49]],
    [[617, 702], [50, 51, 52, 53, 54]],
  ];

  for (const [[startLine, endLine], slideNumbers] of mapping) {
    const blocks = getScriptBlocksByLineRange(script, startLine, endLine);
    const narrations = splitNarrationBlocks(blocks, slideNumbers.length);
    if (narrations.length !== slideNumbers.length) {
      throw new Error(
        'Howa beginner override could not split lines ' +
          startLine +
          '-' +
          endLine +
          ' into ' +
          slideNumbers.length +
          ' scenes',
      );
    }

    slideNumbers.forEach((slideNumber, index) => {
      const slide = plan.slides[slideNumber - 1];
      if (!slide) throw new Error('Howa beginner override slide missing: ' + slideNumber);
      slide.narration = narrations[index];
      slide.source_text = narrations[index];
    });
  }

  const slide24 = plan.slides[23];
  if (slide24?.narration?.endsWith('一方で、')) {
    slide24.narration = slide24.narration.slice(0, -4);
    slide24.source_text = slide24.narration;
  }

  const slide46 = plan.slides[45];
  if (slide46?.narration?.endsWith('次に確認したいのは、')) {
    slide46.narration =
      slide46.narration.slice(0, -10) +
      'ここから、次に確認したい具体的な数字を見ていきます。';
    slide46.source_text = slide46.narration;
  }

  const slide47 = plan.slides[46];
  if (slide47?.narration?.endsWith('特に防衛分野では、共同開発、実証、採用、')) {
    slide47.narration =
      slide47.narration.slice(0, -20) +
      '特に防衛分野には、共同開発、実証、採用、量産契約、納入という段階があります。';
    slide47.source_text = slide47.narration;
  }

  const slide48 = plan.slides[47];
  if (slide48?.narration?.startsWith('量産契約、納入、という段階があります。')) {
    slide48.narration =
      'この中で、' +
      slide48.narration.slice('量産契約、納入、という段階があります。'.length);
    slide48.source_text = slide48.narration;
  }

  plan.source_file = '豊和工業_6203_解説台本_初心者向け補足追加版.txt';
  plan.source_character_count = String(script ?? '').length;
  plan.project_title =
    '豊和工業（6203）国産ドローン量産への期待と注意点【初心者向け補足版】';
  plan.video_title =
    '豊和工業（6203）国産ドローン量産への期待と注意点【初心者向け補足版】';

  return plan;
};

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

  const scriptOverrideFileId = process.env.AUTO_PROJECT_SCRIPT_OVERRIDE_FILE_ID;
  const scriptOverrideMode = process.env.AUTO_PROJECT_SCRIPT_OVERRIDE_MODE;
  if (
    scriptOverrideFileId &&
    scriptOverrideMode === 'howa_beginner_20260907'
  ) {
    const scriptOverridePath = path.join(outputDir, 'source-script-override.txt');
    await downloadDriveFile({
      fileId: scriptOverrideFileId,
      outputPath: scriptOverridePath,
    });
    const overrideScript = await readFile(scriptOverridePath, 'utf8');
    applyHowaBeginnerScriptOverride(plan, overrideScript);
    console.log(
      'Drive project: applied Howa beginner narration override from current source script',
    );
  }
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


export const prepareRepoPlanProject = async ({planPath}) => {
  if (!planPath) throw new Error('planPath is required');

  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (!Array.isArray(plan.slides) || plan.slides.length === 0) {
    throw new Error('repo video plan must contain a non-empty slides array');
  }

  const scenes = plan.slides.map((slide) => ({
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
    slideType: asString(slide.type, 'content'),
    section: asString(slide.section, ''),
    slideItems: Array.isArray(slide.slide_text)
      ? slide.slide_text.map((item) => String(item))
      : [],
  }));

  return {
    plan,
    generatedFiles: [],
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
