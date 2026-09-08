import {spawn} from 'node:child_process';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const getEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const runCurl = (args, {timeoutMs = 15 * 60 * 1000} = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('curl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
        reject(
          new Error(
            `curl exited with code ${code}: ${stderr.slice(-4000)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sha256File = async (filePath) => {
  const file = await readFile(filePath);
  return createHash('sha256').update(file).digest('hex');
};

const extractYoutubeResult = (payload) => {
  if (!payload) return null;

  if (payload.results?.youtube) {
    return payload.results.youtube;
  }

  if (Array.isArray(payload.results)) {
    return payload.results.find(
      (item) => String(item?.platform || '').toLowerCase() === 'youtube',
    ) || null;
  }

  if (payload.platform === 'youtube') return payload;
  return null;
};

const normalizeResult = ({payload, youtube, requestId, metadata}) => {
  const videoId =
    youtube?.platform_post_id ||
    youtube?.video_id ||
    youtube?.post_id ||
    youtube?.id ||
    payload?.video_id ||
    null;

  const postUrl =
    youtube?.post_url ||
    youtube?.url ||
    (videoId ? `https://youtu.be/${videoId}` : null);

  return {
    provider: 'upload-post',
    request_id: requestId || payload?.request_id || null,
    video_id: videoId,
    youtube_url: postUrl,
    studio_edit_url: videoId
      ? `https://studio.youtube.com/video/${videoId}/edit`
      : null,
    privacy_status: 'private',
    contains_synthetic_media: true,
    draft_title:
      String(metadata?.title_candidates?.[0] || '').trim() ||
      process.env.YOUTUBE_DRAFT_TITLE?.trim() ||
      '【下書き】タイトルを設定してください',
    description_set: Boolean(String(metadata?.description || '').trim()),
    tag_count: Array.isArray(metadata?.tags)
      ? metadata.tags.filter((tag) => String(tag || '').trim()).length
      : 0,
    raw_result: youtube || payload,
  };
};

const upload = async ({videoPath, metadataPath}) => {
  const apiKey = getEnv('UPLOAD_POST_API_KEY');
  const user = getEnv('UPLOAD_POST_USER');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const fileStat = await stat(videoPath);

  if (!fileStat.size) throw new Error('Video file is empty');

  const title =
    String(metadata?.title_candidates?.[0] || '').trim() ||
    process.env.YOUTUBE_DRAFT_TITLE?.trim() ||
    '【下書き】タイトルを設定してください';
  const categoryId =
    process.env.YOUTUBE_CATEGORY_ID?.trim() || '25';

  const idempotencyKey = `youtube-${(await sha256File(videoPath)).slice(0, 40)}`;

  const args = [
    '--fail-with-body',
    '--silent',
    '--show-error',
    '--location',
    '--retry',
    '3',
    '--retry-delay',
    '3',
    '--retry-all-errors',
    '--max-time',
    '900',
    '-X',
    'POST',
    'https://api.upload-post.com/api/upload',
    '-H',
    `Authorization: Apikey ${apiKey}`,
    '-H',
    `Idempotency-Key: ${idempotencyKey}`,
    '-F',
    `video=@${videoPath};type=video/mp4`,
    '-F',
    `title=${title}`,
    '-F',
    `user=${user}`,
    '-F',
    'platform[]=youtube',
    '-F',
    `description=<${pathForCurl(metadataPath, 'description')}`,
    '-F',
    `categoryId=${categoryId}`,
    '-F',
    'privacyStatus=private',
    '-F',
    'containsSyntheticMedia=true',
    '-F',
    'async_upload=true',
  ];

  for (const tag of Array.isArray(metadata.tags) ? metadata.tags : []) {
    const clean = String(tag || '').trim().replace(/^#+/, '');
    if (clean) args.push('-F', `tags[]=${clean}`);
  }

  const descriptionTemp = await writeDescriptionTemp(metadataPath, metadata.description || '');
  const descriptionArgIndex = args.findIndex(
    (arg) => typeof arg === 'string' && arg.startsWith('description=<'),
  );
  args[descriptionArgIndex] = `description=<${descriptionTemp}`;

  const raw = await runCurl(args);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Upload-Post returned non-JSON: ${raw.slice(0, 2000)}`);
  }

  if (payload.success === false) {
    throw new Error(`Upload-Post upload failed: ${JSON.stringify(payload)}`);
  }

  let youtube = extractYoutubeResult(payload);
  if (youtube?.success === false) {
    throw new Error(`YouTube upload failed: ${JSON.stringify(youtube)}`);
  }

  const requestId = payload.request_id || payload.job_id || null;

  if (!youtube && requestId) {
    for (let attempt = 1; attempt <= 120; attempt++) {
      await sleep(10000);

      const statusRaw = await runCurl(
        [
          '--fail-with-body',
          '--silent',
          '--show-error',
          '--location',
          '-H',
          `Authorization: Apikey ${apiKey}`,
          `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`,
        ],
        {timeoutMs: 60000},
      );

      const status = JSON.parse(statusRaw);
      youtube = extractYoutubeResult(status);

      if (youtube?.success === false) {
        throw new Error(
          `YouTube async upload failed: ${JSON.stringify(youtube)}`,
        );
      }

      if (
        youtube?.success === true ||
        status.status === 'completed'
      ) {
        payload = status;
        break;
      }

      console.log(
        `Upload-Post status: attempt=${attempt} status=${status.status || 'unknown'}`,
      );
    }
  }

  const result = normalizeResult({
    payload,
    youtube,
    requestId,
    metadata,
  });

  if (!result.video_id && !result.youtube_url) {
    throw new Error(
      `Upload-Post completed without a YouTube video id/url: ${JSON.stringify(payload)}`,
    );
  }

  return result;
};

const writeDescriptionTemp = async (metadataPath, description) => {
  const temp = `${metadataPath}.description.txt`;
  await writeFile(temp, String(description), 'utf8');
  return temp;
};

// Kept only so the multipart argument construction stays explicit.
const pathForCurl = () => '';

const main = async () => {
  const [videoPath, metadataPath, outputPath = 'youtube_upload.json'] =
    process.argv.slice(2);

  if (!videoPath || !metadataPath) {
    throw new Error(
      'Usage: node upload-post-youtube.mjs <video.mp4> <publish_metadata.json> [output.json]',
    );
  }

  const result = await upload({videoPath, metadataPath});
  await writeFile(
    outputPath,
    JSON.stringify(result, null, 2) + '\n',
    'utf8',
  );

  console.log(
    `YOUTUBE DRAFT COMPLETE via Upload-Post: ${result.video_id || result.youtube_url}`,
  );
  if (result.studio_edit_url) {
    console.log(`Studio: ${result.studio_edit_url}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
