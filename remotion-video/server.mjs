import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {stat, mkdir, writeFile, readFile, unlink, rm, cp} from 'node:fs/promises';
import path from 'node:path';
import {planScenes} from './planner.mjs';
import {readGoogleDocText} from './drive.mjs';
import {prepareDriveProject, prepareLocalProject, prepareSpriteProject, prepareEmbeddedSpriteProject, prepareRepoPlanProject} from './project.mjs';
import {generatePublishMetadata, applyChaptersToPublishMetadata} from './publish-metadata.mjs';
import {
  getTtsConfig,
  prepareNarratedScenes,
  synthesizeNarration,
} from './tts.mjs';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 10000);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');
const generatedAudioDir = path.join(cwd, 'public', 'generated');

const childEnv = {
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=384',
};

const readJsonBody = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      throw new Error('Request body too large');
    }
  }
  if (!raw) return {};
  return JSON.parse(raw);
};


const readRawBody = async (req, maxBytes = 6 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const isProjectIngestAuthorized = (req) => {
  const expected = process.env.PROJECT_INGEST_TOKEN;
  return Boolean(expected) && req.headers.authorization === `Bearer ${expected}`;
};

const validateProps = (props) => {
  if (!props || !Array.isArray(props.scenes) || props.scenes.length === 0) {
    throw new Error('scenes must be a non-empty array');
  }

  if (
    props.tts_voice !== undefined &&
    (typeof props.tts_voice !== 'string' || props.tts_voice.trim().length === 0)
  ) {
    throw new Error('tts_voice must be a non-empty string');
  }

  if (
    props.tts_speed !== undefined &&
    (typeof props.tts_speed !== 'number' ||
      !Number.isFinite(props.tts_speed) ||
      props.tts_speed < 0.25 ||
      props.tts_speed > 4)
  ) {
    throw new Error('tts_speed must be a number between 0.25 and 4.0');
  }

  for (const [index, scene] of props.scenes.entries()) {
    if (
      typeof scene.from !== 'number' ||
      typeof scene.duration !== 'number' ||
      typeof scene.title !== 'string' ||
      typeof scene.body !== 'string' ||
      !['normal', 'surprise', 'serious', 'smile'].includes(scene.emotion)
    ) {
      throw new Error(`Invalid scene at index ${index}`);
    }

    if (
      scene.narration !== undefined &&
      typeof scene.narration !== 'string'
    ) {
      throw new Error(`Invalid narration at scene ${index}`);
    }
  }

  return props;
};

const renderVideo = async (
  composition = 'TestVideo',
  filename = 'test.mp4',
  inputProps = null,
) => {
  await mkdir(outDir, {recursive: true});
  const output = path.join(outDir, filename);
  const args = [
    'remotion',
    'render',
    'src/index.tsx',
    composition,
    output,
    '--codec=h264',
    '--concurrency=1',
  ];

  let propsPath = null;
  if (inputProps) {
    propsPath = path.join(outDir, `props-${Date.now()}.json`);
    await writeFile(propsPath, JSON.stringify(inputProps), 'utf8');
    args.push(`--props=${propsPath}`);
  }

  try {
    const {stdout, stderr} = await execFileAsync('npx', args, {
      cwd,
      env: childEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    if (propsPath) {
      await unlink(propsPath).catch(() => {});
    }
  }

  return output;
};

const streamFile = async (output, res, filename, contentType) => {
  const fileStat = await stat(output);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': fileStat.size,
    'content-disposition': `attachment; filename="${filename}"`,
  });
  createReadStream(output).pipe(res);
};

const streamVideo = (output, res, filename) =>
  streamFile(output, res, filename, 'video/mp4');

const cleanupGenerated = async (files) => {
  await Promise.all((files || []).map((file) => unlink(file).catch(() => {})));
};

const resolveFfmpegBinary = async () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  try {
    const {stdout} = await execFileAsync('sh', ['-lc', 'command -v ffmpeg'], {
      cwd,
      env: childEnv,
    });
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // Search Remotion/node_modules below.
  }

  const {stdout} = await execFileAsync(
    'sh',
    [
      '-lc',
      'find node_modules -type f -name ffmpeg -perm -111 2>/dev/null | head -n 1',
    ],
    {cwd, env: childEnv, maxBuffer: 1024 * 1024},
  );
  const found = stdout.trim();
  if (!found) {
    throw new Error('ffmpeg binary could not be located');
  }
  return path.resolve(cwd, found);
};

const rebaseScenes = (scenes) => {
  let cursor = 0;
  return scenes.map((scene) => {
    const rebased = {...scene, from: cursor};
    cursor += scene.duration;
    return rebased;
  });
};

const splitScenesForRender = (
  scenes,
  {maxFrames = 1800, maxScenes = 1} = {},
) => {
  const chunks = [];
  let current = [];
  let currentFrames = 0;

  for (const scene of scenes) {
    const wouldOverflowFrames =
      current.length > 0 && currentFrames + scene.duration > maxFrames;
    const wouldOverflowScenes = current.length >= maxScenes;

    if (wouldOverflowFrames || wouldOverflowScenes) {
      chunks.push(current);
      current = [];
      currentFrames = 0;
    }

    current.push(scene);
    currentFrames += scene.duration;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
};

const concatSegmentsAndAddBgm = async ({
  segmentPaths,
  outputFilename,
  totalFrames,
  props,
}) => {
  if (!segmentPaths.length) {
    throw new Error('No rendered segments to concatenate');
  }

  const ffmpeg = await resolveFfmpegBinary();
  const concatListPath = path.join(outDir, 'concat-' + Date.now() + '.txt');
  const concatOutput = path.join(outDir, 'concat-' + Date.now() + '.mp4');
  const finalOutput = path.join(outDir, outputFilename);

  const concatList = segmentPaths
    .map((segment) => "file '" + segment + "'")
    .join('\n');
  await writeFile(concatListPath, concatList + '\n', 'utf8');

  try {
    await execFileAsync(
      ffmpeg,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        concatOutput,
      ],
      {
        cwd,
        env: childEnv,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const bgmVolume =
      typeof props.bgmVolume === 'number' ? props.bgmVolume : 0.025;
    const fadeInFrames =
      typeof props.bgmFadeInFrames === 'number' ? props.bgmFadeInFrames : 30;
    const fadeOutFrames =
      typeof props.bgmFadeOutFrames === 'number' ? props.bgmFadeOutFrames : 45;
    const durationSeconds = totalFrames / 30;
    const fadeInSeconds = Math.max(0, fadeInFrames / 30);
    const fadeOutSeconds = Math.max(0, fadeOutFrames / 30);
    const fadeOutStart = Math.max(0, durationSeconds - fadeOutSeconds);
    const bgmPath = path.join(
      cwd,
      'public',
      String(props.bgmAsset || 'common/bgm/main_bgm.mp3').replace(/^\//, ''),
    );

    const bgmFilters = ['[1:a]volume=' + bgmVolume];
    if (fadeInSeconds > 0) {
      bgmFilters.push(
        'afade=t=in:st=0:d=' + fadeInSeconds.toFixed(3),
      );
    }
    if (fadeOutSeconds > 0) {
      bgmFilters.push(
        'afade=t=out:st=' +
          fadeOutStart.toFixed(3) +
          ':d=' +
          fadeOutSeconds.toFixed(3),
      );
    }
    const bgmFilter = bgmFilters.join(',');

    await execFileAsync(
      ffmpeg,
      [
        '-y',
        '-i',
        concatOutput,
        '-stream_loop',
        '-1',
        '-i',
        bgmPath,
        '-filter_complex',
        bgmFilter +
          '[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]',
        '-map',
        '0:v:0',
        '-map',
        '[a]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '320k',
        '-shortest',
        finalOutput,
      ],
      {
        cwd,
        env: childEnv,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } finally {
    await unlink(concatListPath).catch(() => {});
    await unlink(concatOutput).catch(() => {});
  }

  return finalOutput;
};

const renderSegmentedVideo = async ({
  outputFilename,
  prepared,
}) => {
  const chunks = splitScenesForRender(prepared.scenes);
  const segmentPaths = [];

  console.log(
    'Segmented render: ' +
      chunks.length +
      ' segments for ' +
      prepared.totalFrames +
      ' frames',
  );

  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const segmentFilename =
        'segment-' + String(index + 1).padStart(2, '0') + '.mp4';
      const segmentFrames = chunk.reduce(
        (sum, scene) => sum + scene.duration,
        0,
      );

      console.log(
        'Segmented render: segment ' +
          (index + 1) +
          '/' +
          chunks.length +
          ', scenes=' +
          chunk.length +
          ', frames=' +
          segmentFrames,
      );

      const segmentProps = {
        ...prepared.props,
        scenes: rebaseScenes(chunk),
        bgmVolume: 0,
        bgmFadeInFrames: 0,
        bgmFadeOutFrames: 0,
      };

      const segmentPath = await renderVideo(
        'TestVideo',
        segmentFilename,
        segmentProps,
      );
      segmentPaths.push(segmentPath);
      console.log(
        'Segmented render: completed segment ' +
          (index + 1) +
          '/' +
          chunks.length,
      );
    }

    console.log('Segmented render: concatenating segments and mixing BGM');
    return await concatSegmentsAndAddBgm({
      segmentPaths,
      outputFilename,
      totalFrames: prepared.totalFrames,
      props: prepared.props,
    });
  } finally {
    await Promise.all(
      segmentPaths.map((segment) => unlink(segment).catch(() => {})),
    );
  }
};

const buildNarratedProps = async (props, jobId) => {
  const prepared = await prepareNarratedScenes({
    scenes: props.scenes,
    outputDir: generatedAudioDir,
    publicPrefix: 'generated',
    fps: 30,
    paddingFrames: 12,
    jobId,
    ttsSpeed: props.tts_speed,
    ttsVoice: props.tts_voice,
  });

  return {
    ...prepared,
    props: {
      ...props,
      scenes: prepared.scenes,
    },
  };
};



const createRenderPackage = async ({
  projectDir,
  prepared,
  jobId,
  publishDir,
}) => {
  const stageDir = path.join(outDir, 'render-package-stage');
  const packagePath = path.join(outDir, 'render-package.tar.gz');

  await rm(stageDir, {recursive: true, force: true}).catch(() => {});
  await mkdir(path.join(stageDir, 'public', 'generated'), {recursive: true});

  await writeFile(
    path.join(stageDir, 'props.json'),
    JSON.stringify(prepared.props),
    'utf8',
  );

  await cp(
    projectDir,
    path.join(stageDir, 'public', 'generated', jobId),
    {recursive: true},
  );

  for (const audioPath of prepared.generatedFiles || []) {
    await cp(
      audioPath,
      path.join(
        stageDir,
        'public',
        'generated',
        path.basename(audioPath),
      ),
    );
  }

  if (publishDir) {
    await cp(publishDir, path.join(stageDir, 'publish'), {
      recursive: true,
    });
  }

  await execFileAsync(
    'tar',
    ['-czf', packagePath, '-C', stageDir, '.'],
    {
      cwd,
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  await rm(stageDir, {recursive: true, force: true}).catch(() => {});
  const packageStat = await stat(packagePath);
  console.log(
    'AUTO RENDER PACKAGE READY: ' +
      packagePath +
      ' bytes=' +
      packageStat.size,
  );
  return packagePath;
};

const autoRenderConfiguredProject = async () => {
  const useRepoPlan = process.env.AUTO_RENDER_REPO_PROJECT === '1';
  const useRepoSprite = process.env.AUTO_RENDER_REPO_SPRITE === '1';
  if (
    !useRepoPlan &&
    !useRepoSprite &&
    process.env.AUTO_RENDER_DRIVE_PROJECT !== '1'
  ) return;

  const videoPlanFileId = process.env.AUTO_PROJECT_VIDEO_PLAN_FILE_ID;
  const slidesFolderId = process.env.AUTO_PROJECT_SLIDES_FOLDER_ID;
  const endingSlideFileId = process.env.AUTO_PROJECT_ENDING_SLIDE_FILE_ID;
  const spritePlanFileId = process.env.AUTO_PROJECT_SPRITE_PLAN_FILE_ID;
  const outputFilename =
    process.env.AUTO_PROJECT_OUTPUT_FILENAME || 'project-output.mp4';

  if (
    !useRepoPlan &&
    !useRepoSprite &&
    (
      !endingSlideFileId ||
      (!spritePlanFileId && (!videoPlanFileId || !slidesFolderId))
    )
  ) {
    console.error(
      'Auto project render skipped: Drive project environment variables are incomplete',
    );
    return;
  }

  let projectDir = null;
  let generatedAudioFiles = [];

  try {
    const output = path.join(outDir, outputFilename);
    try {
      await stat(output);
      console.log(`Auto project output already exists: ${output}`);
      return;
    } catch {
      // Render it below.
    }

    const jobId = `auto-project-${Date.now()}`;
    projectDir = path.join(generatedAudioDir, jobId);
    const publicPrefix = `generated/${jobId}`;

    const bundlePath = path.join(cwd, 'project-bundle.tar.gz');
    let project;

    if (useRepoPlan) {
      console.log('Auto project render: loading repository video plan');
      project = await prepareRepoPlanProject({
        planPath: path.join(cwd, 'terradone-video-plan.json'),
      });
    } else if (useRepoSprite) {
      console.log('Auto project render: loading repository Howa bundled project');
      await mkdir(projectDir, {recursive: true});
      await stat(bundlePath);
      await execFileAsync(
        'tar',
        ['-xzf', bundlePath, '-C', projectDir],
        {cwd, env: childEnv, maxBuffer: 10 * 1024 * 1024},
      );
      project = await prepareLocalProject({
        projectDir,
        publicPrefix,
      });
    } else if (spritePlanFileId) {
      console.log('Auto project render: loading sprite project and embedded plan from Drive');
      project = await prepareSpriteProject({
        spritePlanFileId,
        endingSlideFileId,
        outputDir: projectDir,
        publicPrefix,
      });
    } else if (process.env.AUTO_RENDER_USE_BUNDLED_PROJECT === '1') {
      console.log('Auto project render: using explicitly enabled bundled project assets');
      await mkdir(projectDir, {recursive: true});
      await stat(bundlePath);
      await execFileAsync(
        'tar',
        ['-xzf', bundlePath, '-C', projectDir],
        {cwd, env: childEnv, maxBuffer: 10 * 1024 * 1024},
      );
      project = await prepareLocalProject({
        projectDir,
        publicPrefix,
      });
    } else {
      console.log('Auto project render: loading current project assets from Drive');
      project = await prepareDriveProject({
        videoPlanFileId,
        slidesFolderId,
        endingSlideFileId,
        outputDir: projectDir,
        publicPrefix,
      });
    }

    console.log(
      `Auto project render: loaded ${project.props.scenes.length} slides; starting TTS and publish metadata`,
    );
    const props = validateProps(project.props);
    const publishDir = path.join(projectDir, 'publish');

    const [prepared, publishMetadata] = await Promise.all([
      buildNarratedProps(props, jobId),
      generatePublishMetadata({
        plan: project.plan,
        outputDir: publishDir,
      }),
    ]);
    generatedAudioFiles = prepared.generatedFiles;

    const finalizedPublishMetadata =
      await applyChaptersToPublishMetadata({
        metadata: publishMetadata,
        plan: project.plan,
        scenes: prepared.scenes,
        fps: 30,
        totalFrames: prepared.totalFrames,
        outputDir: publishDir,
      });

    console.log(
      `Auto project render: TTS complete, totalFrames=${prepared.totalFrames}; publish metadata titles=${finalizedPublishMetadata.title_candidates.length}; chapters=${finalizedPublishMetadata.chapters.length}; creating render package`,
    );
    await createRenderPackage({
      projectDir,
      prepared,
      jobId,
      publishDir,
    });

    if (process.env.AUTO_RENDER_PACKAGE_ONLY === '1') {
      console.log('Auto project render: package-only mode complete');
      return;
    }

    console.log('Auto project render: rendering video in segments');
    await renderSegmentedVideo({
      outputFilename,
      prepared,
    });

    console.log(`AUTO PROJECT RENDER COMPLETE: ${output}`);
  } catch (error) {
    console.error('AUTO PROJECT RENDER FAILED:', error);
  } finally {
    await cleanupGenerated(generatedAudioFiles);
    if (projectDir) {
      await rm(projectDir, {recursive: true, force: true}).catch(() => {});
    }
  }
};

const isAuthorized = (req) => {
  const expected = process.env.VIDEO_API_TOKEN;
  if (!expected) return false;
  return req.headers.authorization === `Bearer ${expected}`;
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
    return;
  }

  if (
    (req.url === '/demo.mp4' || req.url?.startsWith('/demo.mp4?')) &&
    req.method === 'GET'
  ) {
    try {
      const output = path.join(outDir, 'demo.mp4');
      await streamVideo(output, res, 'demo.mp4');
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Demo video not available'}));
    }
    return;
  }

  if (
    (req.url === '/demo-tts.mp4' || req.url?.startsWith('/demo-tts.mp4?')) &&
    req.method === 'GET'
  ) {
    try {
      const output = path.join(outDir, 'demo-tts.mp4');
      await streamVideo(output, res, 'demo-tts.mp4');
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'TTS demo video not available'}));
    }
    return;
  }


  if (
    (req.url === '/render-package.tar.gz' ||
      req.url?.startsWith('/render-package.tar.gz?')) &&
    req.method === 'GET'
  ) {
    try {
      const output = path.join(outDir, 'render-package.tar.gz');
      await streamFile(
        output,
        res,
        'render-package.tar.gz',
        'application/gzip',
      );
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(
        JSON.stringify({ok: false, error: 'Render package not available'}),
      );
    }
    return;
  }

  if (
    (req.url === '/project-output.mp4' ||
      req.url?.startsWith('/project-output.mp4?')) &&
    req.method === 'GET'
  ) {
    try {
      const filename =
        process.env.AUTO_PROJECT_OUTPUT_FILENAME || 'project-output.mp4';
      const output = path.join(outDir, filename);
      await streamVideo(output, res, filename);
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Project video not available'}));
    }
    return;
  }


  if ((req.url === '/prepare-project-upload' || req.url === '/render-project-upload') && req.method === 'POST') {
    if (!isProjectIngestAuthorized(req)) {
      res.writeHead(401, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Unauthorized'}));
      return;
    }

    let projectDir = null;
    let generatedAudioFiles = [];
    try {
      const body = await readRawBody(req);
      if (!body.length) throw new Error('Uploaded sprite is empty');

      const jobId = `upload-project-${Date.now()}`;
      projectDir = path.join(generatedAudioDir, jobId);
      await mkdir(projectDir, {recursive: true});
      const spritePath = path.join(projectDir, 'project_sprite.webp');
      await writeFile(spritePath, body);

      const project = await prepareEmbeddedSpriteProject({
        spritePath,
        publicPrefix: `generated/${jobId}`,
      });
      const props = validateProps(project.props);
      const publishDir = path.join(projectDir, 'publish');

      const [prepared, publishMetadata] = await Promise.all([
        buildNarratedProps(props, jobId),
        generatePublishMetadata({
          plan: project.plan,
          outputDir: publishDir,
        }),
      ]);
      generatedAudioFiles = prepared.generatedFiles;

      const finalizedPublishMetadata =
        await applyChaptersToPublishMetadata({
          metadata: publishMetadata,
          plan: project.plan,
          scenes: prepared.scenes,
          fps: 30,
          totalFrames: prepared.totalFrames,
          outputDir: publishDir,
        });

      await createRenderPackage({
        projectDir,
        prepared,
        jobId,
        publishDir,
      });

      if (req.url === '/render-project-upload') {
        const output = await renderSegmentedVideo({
          outputFilename: 'uploaded-project.mp4',
          prepared,
        });
        await streamVideo(output, res, 'uploaded-project.mp4');
        return;
      }

      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        ok: true,
        scenes: prepared.scenes.length,
        totalFrames: prepared.totalFrames,
        durationSeconds: prepared.totalFrames / 30,
        titleCandidates: finalizedPublishMetadata.title_candidates.length,
        chapters: finalizedPublishMetadata.chapters.length,
      }));
    } catch (error) {
      console.error('Uploaded project preparation failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    } finally {
      await cleanupGenerated(generatedAudioFiles);
      if (projectDir) {
        await rm(projectDir, {recursive: true, force: true}).catch(() => {});
      }
    }
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'Unauthorized'}));
    return;
  }

  if (req.url === '/tts-status' && req.method === 'GET') {
    const config = getTtsConfig();
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok: true, ...config}, null, 2));
    return;
  }

  if (req.url === '/tts-preview' && req.method === 'POST') {
    let output = null;
    try {
      const body = await readJsonBody(req);
      output = path.join(outDir, `tts-preview-${Date.now()}.wav`);
      const result = await synthesizeNarration({
        text: body.text,
        outputPath: output,
        fps: 30,
      });

      res.setHeader('x-tts-voice', result.voice);
      res.setHeader('x-tts-speed', String(result.speed));
      res.on('finish', () => {
        unlink(output).catch(() => {});
      });
      await streamFile(output, res, 'tts-preview.wav', 'audio/wav');
    } catch (error) {
      if (output) await unlink(output).catch(() => {});
      console.error('TTS preview failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-tts-demo' && req.method === 'POST') {
    let generatedFiles = [];
    try {
      const demo = JSON.parse(
        await readFile(path.join(cwd, 'demo-props.json'), 'utf8'),
      );
      const props = validateProps(demo);
      const prepared = await buildNarratedProps(
        props,
        `demo-${Date.now()}`,
      );
      generatedFiles = prepared.generatedFiles;

      const output = await renderVideo(
        'TestVideo',
        'demo-tts.mp4',
        prepared.props,
      );

      await cleanupGenerated(generatedFiles);
      generatedFiles = [];
      await streamVideo(output, res, 'demo-tts.mp4');
    } catch (error) {
      await cleanupGenerated(generatedFiles);
      console.error('TTS demo render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-tts' && req.method === 'POST') {
    let generatedFiles = [];
    try {
      const props = validateProps(await readJsonBody(req));
      const prepared = await buildNarratedProps(
        props,
        `runtime-${Date.now()}`,
      );
      generatedFiles = prepared.generatedFiles;

      const output = await renderVideo(
        'TestVideo',
        'tts-video.mp4',
        prepared.props,
      );

      await cleanupGenerated(generatedFiles);
      generatedFiles = [];
      await streamVideo(output, res, 'tts-video.mp4');
    } catch (error) {
      await cleanupGenerated(generatedFiles);
      console.error('TTS render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }


  if (req.url === '/render-project-drive' && req.method === 'POST') {
    let generatedFiles = [];
    let projectDir = null;
    let generatedAudioFiles = [];

    try {
      const body = await readJsonBody(req);
      const jobId = `project-${Date.now()}`;
      projectDir = path.join(generatedAudioDir, jobId);
      const publicPrefix = `generated/${jobId}`;

      const project = await prepareDriveProject({
        videoPlanFileId: body.videoPlanFileId,
        slidesFolderId: body.slidesFolderId,
        endingSlideFileId: body.endingSlideFileId,
        outputDir: projectDir,
        publicPrefix,
      });
      generatedFiles = project.generatedFiles;

      const props = validateProps(project.props);
      const prepared = await buildNarratedProps(props, jobId);
      generatedAudioFiles = prepared.generatedFiles;

      const filename =
        typeof body.outputFilename === 'string' && body.outputFilename.trim()
          ? body.outputFilename.trim()
          : 'project-video.mp4';

      const output = await renderVideo(
        'TestVideo',
        filename,
        prepared.props,
      );

      await cleanupGenerated(generatedAudioFiles);
      generatedAudioFiles = [];
      await rm(projectDir, {recursive: true, force: true}).catch(() => {});
      projectDir = null;

      await streamVideo(output, res, filename);
    } catch (error) {
      await cleanupGenerated(generatedAudioFiles);
      if (projectDir) {
        await rm(projectDir, {recursive: true, force: true}).catch(() => {});
      } else {
        await cleanupGenerated(generatedFiles);
      }
      console.error('Drive project render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-test' && req.method === 'GET') {
    try {
      const output = await renderVideo('SmokeTest', 'runtime-smoke.mp4');
      const fileStat = await stat(output);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true, bytes: fileStat.size}));
    } catch (error) {
      console.error('Runtime smoke test failed:', error);
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/plan-drive' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const doc = await readGoogleDocText(body.documentId);
      const result = await planScenes(doc.script);
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(
        JSON.stringify(
          {
            ok: true,
            document: {id: doc.documentId, title: doc.title},
            ...result,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('Drive scene planning failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-drive' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const doc = await readGoogleDocText(body.documentId);
      const result = await planScenes(doc.script);
      const output = await renderVideo(
        'TestVideo',
        'drive-script-test.mp4',
        result.props,
      );
      await streamVideo(output, res, 'drive-script-test.mp4');
    } catch (error) {
      console.error('Drive script render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/plan-scenes' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await planScenes(body.script);
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({ok: true, ...result}, null, 2));
    } catch (error) {
      console.error('Scene planning failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-script' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await planScenes(body.script);
      const output = await renderVideo(
        'TestVideo',
        'script-test.mp4',
        result.props,
      );
      await streamVideo(output, res, 'script-test.mp4');
    } catch (error) {
      console.error('Script render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render-json' && req.method === 'POST') {
    try {
      const props = validateProps(await readJsonBody(req));
      const output = await renderVideo(
        'TestVideo',
        'dynamic-test.mp4',
        props,
      );
      await streamVideo(output, res, 'dynamic-test.mp4');
    } catch (error) {
      console.error('Dynamic render failed:', error);
      res.writeHead(400, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  if (req.url === '/render' && req.method === 'POST') {
    try {
      const output = await renderVideo('TestVideo', 'test.mp4');
      await streamVideo(output, res, 'test.mp4');
    } catch (error) {
      console.error('Render request failed:', error);
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
  res.end('Remotion prototype: authenticated API');
});

server.listen(port, () => {
  console.log(`Listening on :${port}`);
  autoRenderConfiguredProject().catch((error) => {
    console.error('Auto project render startup failure:', error);
  });
});
