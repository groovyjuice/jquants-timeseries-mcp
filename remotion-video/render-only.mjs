import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat, mkdir, writeFile, readFile, unlink, rm, cp, rename} from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');
const generatedDir = path.join(cwd, 'public', 'generated');
const packagePath = path.join(outDir, 'render-package.tar.gz');
const resumeStage = path.join(outDir, 'render-only-stage');
const outputFilename =
  process.env.AUTO_PROJECT_OUTPUT_FILENAME || 'project-output.mp4';
const remotionBin = path.join(cwd, 'node_modules', '.bin', 'remotion');

const childEnv = {
  ...process.env,
  NODE_OPTIONS: '--max-old-space-size=128',
};

const exists = async (file) => {
  try {
    const s = await stat(file);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
};

const resolveFfmpegBinary = async () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const {stdout} = await execFileAsync('sh', ['-lc', 'command -v ffmpeg'], {
      cwd,
      env: childEnv,
    });
    if (stdout.trim()) return stdout.trim();
  } catch {}
  const {stdout} = await execFileAsync(
    'sh',
    ['-lc', 'find node_modules -type f -name ffmpeg -perm -111 2>/dev/null | head -n 1'],
    {cwd, env: childEnv, maxBuffer: 1024 * 1024},
  );
  if (!stdout.trim()) throw new Error('ffmpeg binary could not be located');
  return path.resolve(cwd, stdout.trim());
};

const restore = async () => {
  if (!(await exists(packagePath))) {
    throw new Error('render package is missing');
  }

  await rm(resumeStage, {recursive: true, force: true}).catch(() => {});
  await mkdir(resumeStage, {recursive: true});
  await execFileAsync(
    'tar',
    ['-xzf', packagePath, '-C', resumeStage],
    {cwd, env: childEnv, maxBuffer: 10 * 1024 * 1024},
  );

  const sourceGenerated = path.join(resumeStage, 'public', 'generated');
  await rm(generatedDir, {recursive: true, force: true}).catch(() => {});
  await cp(sourceGenerated, generatedDir, {recursive: true, force: true});

  const props = JSON.parse(
    await readFile(path.join(resumeStage, 'props.json'), 'utf8'),
  );
  if (!Array.isArray(props.scenes) || props.scenes.length === 0) {
    throw new Error('render package props contain no scenes');
  }

  return props;
};

const rebaseScene = (scene) => ({...scene, from: 0});

const renderSegment = async ({scene, index, total}) => {
  const segmentFilename =
    'segment-' + String(index + 1).padStart(2, '0') + '.mp4';
  const segmentPath = path.join(outDir, segmentFilename);

  if (await exists(segmentPath)) {
    const s = await stat(segmentPath);
    if (s.size > 10 * 1024) {
      console.log(
        'Render-only: reusing segment ' +
          (index + 1) +
          '/' +
          total +
          ', bytes=' +
          s.size,
      );
      return segmentPath;
    }
  }

  const partialFilename = segmentFilename + '.partial.mp4';
  const partialPath = path.join(outDir, partialFilename);
  await unlink(partialPath).catch(() => {});

  const segmentProps = {
    scenes: [rebaseScene(scene)],
    logoSrc: undefined,
    bgmAsset: '',
    bgmLoop: false,
    bgmVolume: 0,
    bgmFadeInFrames: 0,
    bgmFadeOutFrames: 0,
  };

  const propsPath = path.join(
    outDir,
    'render-only-props-' + String(index + 1).padStart(2, '0') + '.json',
  );
  await writeFile(propsPath, JSON.stringify(segmentProps), 'utf8');

  console.log(
    'Render-only: segment ' +
      (index + 1) +
      '/' +
      total +
      ', frames=' +
      scene.duration,
  );

  try {
    const {stdout, stderr} = await execFileAsync(
      remotionBin,
      [
        'render',
        'src/index.tsx',
        'TestVideo',
        partialPath,
        '--codec=h264',
        '--concurrency=1',
        '--props=' + propsPath,
      ],
      {
        cwd,
        env: childEnv,
        maxBuffer: 30 * 1024 * 1024,
      },
    );
    if (stdout) {
      const lines = stdout.trim().split(/\r?\n/);
      console.log(
        'Render-only: remotion finished segment ' +
          (index + 1) +
          '/' +
          total +
          ' (' +
          (lines[lines.length - 1] || 'done') +
          ')',
      );
    }
    if (stderr) console.error(stderr);
  } finally {
    await unlink(propsPath).catch(() => {});
  }

  await rename(partialPath, segmentPath);
  return segmentPath;
};

const concatAndMix = async ({segments, props, totalFrames}) => {
  const ffmpeg = await resolveFfmpegBinary();
  const listPath = path.join(outDir, 'render-only-concat.txt');
  const concatPath = path.join(outDir, 'render-only-concat.mp4');
  const finalPath = path.join(outDir, outputFilename);

  await writeFile(
    listPath,
    segments.map((p) => "file '" + p + "'").join('\n') + '\n',
    'utf8',
  );

  await execFileAsync(
    ffmpeg,
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath],
    {cwd, env: childEnv, maxBuffer: 10 * 1024 * 1024},
  );

  const bgmAsset =
    typeof props.bgmAsset === 'string' && props.bgmAsset
      ? props.bgmAsset
      : 'common/bgm/main_bgm.mp3';
  const bgmPath = path.join(cwd, 'public', bgmAsset.replace(/^\//, ''));
  const bgmVolume =
    typeof props.bgmVolume === 'number' ? props.bgmVolume : 0.025;
  const fadeInFrames =
    typeof props.bgmFadeInFrames === 'number' ? props.bgmFadeInFrames : 30;
  const fadeOutFrames =
    typeof props.bgmFadeOutFrames === 'number' ? props.bgmFadeOutFrames : 45;
  const duration = totalFrames / 30;
  const fadeIn = Math.max(0, fadeInFrames / 30);
  const fadeOut = Math.max(0, fadeOutFrames / 30);
  const fadeOutStart = Math.max(0, duration - fadeOut);

  const filters = ['[1:a]volume=' + bgmVolume];
  if (fadeIn > 0) filters.push('afade=t=in:st=0:d=' + fadeIn.toFixed(3));
  if (fadeOut > 0) {
    filters.push(
      'afade=t=out:st=' +
        fadeOutStart.toFixed(3) +
        ':d=' +
        fadeOut.toFixed(3),
    );
  }

  await execFileAsync(
    ffmpeg,
    [
      '-y',
      '-i',
      concatPath,
      '-stream_loop',
      '-1',
      '-i',
      bgmPath,
      '-filter_complex',
      filters.join(',') +
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
      finalPath,
    ],
    {cwd, env: childEnv, maxBuffer: 20 * 1024 * 1024},
  );

  await unlink(listPath).catch(() => {});
  await unlink(concatPath).catch(() => {});
  return finalPath;
};

const main = async () => {
  await mkdir(outDir, {recursive: true});

  const finalPath = path.join(outDir, outputFilename);
  if (await exists(finalPath)) {
    console.log('Render-only: final output already exists');
    return;
  }

  console.log('Render-only: restoring prepared package with no TTS/Drive imports');
  const props = await restore();
  const scenes = props.scenes;
  const totalFrames = scenes.reduce((sum, scene) => sum + scene.duration, 0);

  console.log(
    'Render-only: restored scenes=' +
      scenes.length +
      ', totalFrames=' +
      totalFrames,
  );

  const segments = [];
  for (let i = 0; i < scenes.length; i++) {
    segments.push(
      await renderSegment({scene: scenes[i], index: i, total: scenes.length}),
    );
  }

  console.log('Render-only: all segments complete; concatenating and mixing BGM');
  await concatAndMix({segments, props, totalFrames});

  for (const segment of segments) {
    await unlink(segment).catch(() => {});
  }

  console.log('RENDER_ONLY_COMPLETE: ' + finalPath);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('RENDER_ONLY_FAILED:', error);
    process.exit(1);
  });
