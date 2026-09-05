import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {stat, mkdir} from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 10000);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');

const childEnv = {
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=384',
};

const renderVideo = async (composition = 'TestVideo', filename = 'test.mp4') => {
  await mkdir(outDir, {recursive: true});
  const output = path.join(outDir, filename);
  const {stdout, stderr} = await execFileAsync('npx', [
    'remotion',
    'render',
    'src/index.tsx',
    composition,
    output,
    '--codec=h264',
    '--concurrency=1',
  ], {
    cwd,
    env: childEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
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

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
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
  res.end('Remotion prototype is running. GET /render-test or POST /render');
});

server.listen(port, () => {
  console.log(`Listening on :${port}`);
});
