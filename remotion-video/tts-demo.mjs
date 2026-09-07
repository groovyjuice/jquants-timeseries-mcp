import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {getTtsConfig, prepareNarratedScenes} from './tts.mjs';

const execFileAsync = promisify(execFile);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');
const generatedAudioDir = path.join(cwd, 'public', 'generated');

const main = async () => {
  const config = getTtsConfig();

  if (!config.configured) {
    console.log(
      `TTS demo skipped: OPENAI_API_KEY is not configured (voice=${config.voice}, speed=${config.speed}).`,
    );
    return;
  }

  await mkdir(outDir, {recursive: true});

  const demoProps = JSON.parse(
    await readFile(path.join(cwd, 'demo-props.json'), 'utf8'),
  );

  let generatedFiles = [];
  const propsPath = path.join(outDir, 'demo-tts-props.json');

  try {
    const prepared = await prepareNarratedScenes({
      scenes: demoProps.scenes,
      outputDir: generatedAudioDir,
      publicPrefix: 'generated',
      fps: 30,
      paddingFrames: 12,
      jobId: 'build-demo',
    });
    generatedFiles = prepared.generatedFiles;

    await writeFile(
      propsPath,
      JSON.stringify({...demoProps, scenes: prepared.scenes}),
      'utf8',
    );

    console.log(
      `TTS demo: ${prepared.config.voice}, speed=${prepared.config.speed}, frames=${prepared.totalFrames}`,
    );

    const {stdout, stderr} = await execFileAsync(
      'npx',
      [
        'remotion',
        'render',
        'src/index.tsx',
        'TestVideo',
        path.join(outDir, 'demo-tts.mp4'),
        '--codec=h264',
        '--concurrency=1',
        `--props=${propsPath}`,
      ],
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS:
            process.env.NODE_OPTIONS || '--max-old-space-size=384',
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    await Promise.all(
      generatedFiles.map((file) => unlink(file).catch(() => {})),
    );
    await unlink(propsPath).catch(() => {});
  }
};

try {
  await main();
} catch (error) {
  // Keep the web service deployable even if billing/key/TTS has a temporary issue.
  console.error('TTS demo generation failed:', error);
}
