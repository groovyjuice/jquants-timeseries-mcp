import {spawn} from 'node:child_process';
import {stat, writeFile} from 'node:fs/promises';

const getEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const runCurl = (args, {timeoutMs = 120000} = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('curl', args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('curl timed out'));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`curl exited with code ${code}: ${stderr.slice(-3000)}`));
        return;
      }
      resolve(stdout);
    });
  });

const main = async () => {
  const [videoId, thumbnailPath, outputPath = 'youtube_thumbnail.json'] =
    process.argv.slice(2);

  if (!videoId || !thumbnailPath) {
    throw new Error(
      'Usage: node set-youtube-thumbnail.mjs <youtube-video-id> <thumbnail-file> [output.json]',
    );
  }

  const st = await stat(thumbnailPath);
  if (!st.size) throw new Error('Thumbnail file is empty');
  if (st.size > 2 * 1024 * 1024) {
    throw new Error('Thumbnail file exceeds YouTube/Upload-Post 2 MB limit');
  }

  const apiKey = getEnv('UPLOAD_POST_API_KEY');
  const user = getEnv('UPLOAD_POST_USER');

  const raw = await runCurl([
    '--fail-with-body',
    '--silent',
    '--show-error',
    '--location',
    '-X',
    'POST',
    'https://api.upload-post.com/api/uploadposts/youtube/thumbnail',
    '-H',
    `Authorization: Apikey ${apiKey}`,
    '-F',
    `user=${user}`,
    '-F',
    `video_id=${videoId}`,
    '-F',
    `thumbnail=@${thumbnailPath}`,
  ]);

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Upload-Post returned non-JSON: ${raw.slice(0, 2000)}`);
  }

  if (result.success !== true) {
    throw new Error(`Thumbnail update failed: ${JSON.stringify(result)}`);
  }

  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`YOUTUBE THUMBNAIL UPDATED: video_id=${videoId}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
