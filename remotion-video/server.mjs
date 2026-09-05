import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {stat, mkdir, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {planScenes} from './planner.mjs';
import {readGoogleDocText} from './drive.mjs';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 10000);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');

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

  for (const [index, scene] of props.scenes.entries()) {
    if (
      typeof scene.from !== 'number' ||
      typeof scene.duration !== 'number' ||
      typeof scene.title !== 'string' ||
      typeof scene.body !== 'string' ||
      !['normal', 'surprise', 'serious'].includes(scene.emotion)
    ) {
      throw new Error(`Invalid scene at index ${index}`);
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

const streamVideo = async (output, res, filename) => {
  const fileStat = await stat(output);
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': fileStat.size,
    'content-disposition': `attachment; filename="${filename}"`,
  });
  createReadStream(output).pipe(res);
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

  if ((req.url === '/demo.mp4' || req.url?.startsWith('/demo.mp4?')) && req.method === 'GET') {
    try {
      const output = path.join(outDir, 'demo.mp4');
      await streamVideo(output, res, 'demo.mp4');
    } catch (error) {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Demo video not available'}));
    }
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'Unauthorized'}));
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
      res.end(JSON.stringify({ok: true, document: {id: doc.documentId, title: doc.title}, ...result}, null, 2));
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
      const output = await renderVideo('TestVideo', 'drive-script-test.mp4', result.props);
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
      const output = await renderVideo('TestVideo', 'script-test.mp4', result.props);
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
      const output = await renderVideo('TestVideo', 'dynamic-test.mp4', props);
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
