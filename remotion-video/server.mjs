import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {stat, mkdir, writeFile, readFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {planScenes} from './planner.mjs';
import {readGoogleDocText} from './drive.mjs';
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

const validateProps = (props) => {
  if (!props || !Array.isArray(props.scenes) || props.scenes.length === 0) {
    throw new Error('scenes must be a non-empty array');
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

const buildNarratedProps = async (props, jobId) => {
  const prepared = await prepareNarratedScenes({
    scenes: props.scenes,
    outputDir: generatedAudioDir,
    publicPrefix: 'generated',
    fps: 30,
    paddingFrames: 12,
    jobId,
    ttsSpeed: props.tts_speed,
  });

  return {
    ...prepared,
    props: {
      ...props,
      scenes: prepared.scenes,
    },
  };
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
});
