import http from 'node:http';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {stat, mkdir, unlink} from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT || 10000);
const cwd = process.cwd();
const outDir = path.join(cwd, 'out');
const packagePath = path.join(outDir, 'render-package.tar.gz');
const markerPath = path.join(outDir, 'render-resume.json');
const outputFilename =
  process.env.AUTO_PROJECT_OUTPUT_FILENAME || 'project-output.mp4';
const outputPath = path.join(outDir, outputFilename);

const fileExists = async (file) => {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

const streamFile = async (file, res, filename, contentType) => {
  const info = await stat(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'content-disposition': 'attachment; filename="' + filename + '"',
  });
  createReadStream(file).pipe(res);
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
    return;
  }

  if (
    (req.url === '/render-package.tar.gz' ||
      req.url?.startsWith('/render-package.tar.gz?')) &&
    req.method === 'GET'
  ) {
    try {
      await streamFile(
        packagePath,
        res,
        'render-package.tar.gz',
        'application/gzip',
      );
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Render package not available'}));
    }
    return;
  }

  if (
    (req.url === '/project-output.mp4' ||
      req.url?.startsWith('/project-output.mp4?')) &&
    req.method === 'GET'
  ) {
    try {
      await streamFile(outputPath, res, outputFilename, 'video/mp4');
    } catch {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'Project video not available'}));
    }
    return;
  }

  res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
  res.end('Remotion render supervisor');
});

const runWorker = (script, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        RENDER_WORKER_MODE: script === 'server.mjs' ? '1' : '0',
      },
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      resolve({
        code: typeof code === 'number' ? code : -1,
        signal: signal || '',
      });
    });
  });

const runPipeline = async () => {
  await mkdir(outDir, {recursive: true});

  if (await fileExists(outputPath)) {
    console.log('Supervisor: final video already exists');
    return;
  }

  const hasPackage =
    (await fileExists(packagePath)) && (await fileExists(markerPath));

  if (!hasPackage) {
    console.log('Supervisor: phase 1/2 preparing TTS, captions, mouth cues and render package');
    const prep = await runWorker('server.mjs', {AUTO_RENDER_PACKAGE_ONLY: '1'});
    if (prep.code !== 0) {
      console.error(
        'Supervisor: preparation worker failed, code=' +
          prep.code +
          ', signal=' +
          prep.signal,
      );
      return;
    }
  } else {
    console.log('Supervisor: reusable render package already exists; skipping preparation');
  }

  if (!(await fileExists(packagePath)) || !(await fileExists(markerPath))) {
    console.error('Supervisor: preparation finished without a reusable render package');
    return;
  }

  // The preparation process has exited here, releasing its heap and TTS buffers.
  // Start Chromium only in a fresh render-only worker.
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await fileExists(outputPath)) break;

    console.log(
      'Supervisor: phase 2/2 render worker attempt ' + attempt + '/4',
    );
    const render = await runWorker('render-only.mjs', {AUTO_RENDER_PACKAGE_ONLY: '0'});

    if (await fileExists(outputPath)) {
      console.log('Supervisor: final video render complete');
      await unlink(markerPath).catch(() => {});
      break;
    }

    console.warn(
      'Supervisor: render worker exited before final output, code=' +
        render.code +
        ', signal=' +
        render.signal +
        '; completed segment checkpoints will be reused',
    );
  }

  if (!(await fileExists(outputPath))) {
    console.error(
      'Supervisor: final output was not produced after render retries',
    );
  }
};

server.listen(port, () => {
  console.log('Render supervisor listening on :' + port);
  runPipeline().catch((error) => {
    console.error('Supervisor pipeline failure:', error);
  });
});
