import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 10000);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');

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
  ], {cwd, maxBuffer: 20 * 1024 * 1024});
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  return output;
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
    return;
  }

  if (req.url === '/render' && req.method === 'POST') {
    try {
      const output = await renderVideo('TestVideo', 'test.mp4');
      const data = await readFile(output);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': data.length,
        'content-disposition': 'attachment; filename="test.mp4"',
      });
      res.end(data);
    } catch (error) {
      console.error('Render request failed:', error);
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: String(error)}));
    }
    return;
  }

  res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
  res.end('Remotion prototype is running. POST /render to create test.mp4');
});

server.listen(port, () => {
  console.log(`Listening on :${port}`);
});
