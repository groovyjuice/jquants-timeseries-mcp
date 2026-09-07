import {open, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_ENV = [
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
];

const getEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refreshAccessToken = async () => {
  const body = new URLSearchParams({
    client_id: getEnv('YOUTUBE_CLIENT_ID'),
    client_secret: getEnv('YOUTUBE_CLIENT_SECRET'),
    refresh_token: getEnv('YOUTUBE_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(
      `Could not refresh YouTube access token: HTTP ${response.status} ${JSON.stringify(json)}`,
    );
  }
  return json.access_token;
};

const sanitizeTags = (tags) => {
  const unique = [];
  let total = 0;

  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw || '').trim().replace(/^#+/, '');
    if (!tag || unique.includes(tag)) continue;

    const next = total + tag.length + (unique.length ? 1 : 0);
    if (next > 450) break;

    unique.push(tag);
    total = next;
    if (unique.length >= 30) break;
  }
  return unique;
};

const buildRequestBody = (metadata) => ({
  snippet: {
    title:
      process.env.YOUTUBE_DRAFT_TITLE?.trim() ||
      '【下書き】タイトルを設定してください',
    description: String(metadata.description || '').slice(0, 5000),
    tags: sanitizeTags(metadata.tags),
    categoryId: process.env.YOUTUBE_CATEGORY_ID?.trim() || '25',
    defaultLanguage: 'ja',
  },
  status: {
    privacyStatus: 'private',
    selfDeclaredMadeForKids: false,
  },
});

const parseUploadedEnd = (rangeHeader) => {
  if (!rangeHeader) return -1;
  const match = /bytes=\d+-(\d+)/i.exec(rangeHeader);
  return match ? Number(match[1]) : -1;
};

const queryUploadPosition = async ({uploadUrl, accessToken, totalBytes}) => {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-length': '0',
      'content-range': `bytes */${totalBytes}`,
    },
  });

  if (response.status === 308) {
    return {
      complete: false,
      nextByte: parseUploadedEnd(response.headers.get('range')) + 1,
    };
  }

  if (response.ok) {
    const json = await response.json().catch(() => ({}));
    return {complete: true, response: json};
  }

  const body = await response.text().catch(() => '');
  throw new Error(
    `Could not query YouTube upload position: HTTP ${response.status} ${body}`,
  );
};

const initiateResumableUpload = async ({
  accessToken,
  totalBytes,
  requestBody,
}) => {
  const url = new URL(
    'https://www.googleapis.com/upload/youtube/v3/videos',
  );
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('part', 'snippet,status');
  url.searchParams.set('notifySubscribers', 'false');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(totalBytes),
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify(requestBody),
  });

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(
      `Could not initiate YouTube upload: HTTP ${response.status} ${body}`,
    );
  }

  const uploadUrl = response.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube resumable upload did not return a Location header');
  }
  return uploadUrl;
};

const uploadVideo = async ({
  videoPath,
  metadata,
  chunkSize = 8 * 1024 * 1024,
}) => {
  const fileStat = await stat(videoPath);
  const totalBytes = fileStat.size;
  if (!totalBytes) throw new Error('Video file is empty');

  let accessToken = await refreshAccessToken();
  const requestBody = buildRequestBody(metadata);
  const uploadUrl = await initiateResumableUpload({
    accessToken,
    totalBytes,
    requestBody,
  });

  const handle = await open(videoPath, 'r');
  let position = 0;
  let finalResponse = null;

  try {
    while (position < totalBytes) {
      const remaining = totalBytes - position;
      const requested = Math.min(chunkSize, remaining);
      const buffer = Buffer.allocUnsafe(requested);
      const {bytesRead} = await handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (!bytesRead) {
        throw new Error(`Unexpected EOF at byte ${position}`);
      }

      const body = bytesRead === buffer.length
        ? buffer
        : buffer.subarray(0, bytesRead);
      const end = position + bytesRead - 1;

      let uploaded = false;
      let lastError = null;

      for (let attempt = 1; attempt <= 6 && !uploaded; attempt++) {
        try {
          const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'video/mp4',
              'content-length': String(bytesRead),
              'content-range': `bytes ${position}-${end}/${totalBytes}`,
            },
            body,
          });

          if (response.status === 308) {
            const uploadedEnd = parseUploadedEnd(
              response.headers.get('range'),
            );
            position =
              uploadedEnd >= position
                ? uploadedEnd + 1
                : end + 1;
            uploaded = true;
            console.log(
              `YouTube upload: ${position}/${totalBytes} bytes`,
            );
            break;
          }

          if (response.ok) {
            finalResponse = await response.json().catch(() => ({}));
            position = totalBytes;
            uploaded = true;
            console.log(
              `YouTube upload: ${totalBytes}/${totalBytes} bytes`,
            );
            break;
          }

          if (response.status === 401 && attempt <= 2) {
            accessToken = await refreshAccessToken();
            lastError = new Error('Access token refreshed after 401');
            continue;
          }

          const text = await response.text().catch(() => '');
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;

          if (!retryable) {
            throw new Error(
              `YouTube upload failed: HTTP ${response.status} ${text}`,
            );
          }
          lastError = new Error(
            `Retryable YouTube error: HTTP ${response.status} ${text}`,
          );
        } catch (error) {
          lastError = error;
        }

        if (attempt < 6) {
          await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
          try {
            const status = await queryUploadPosition({
              uploadUrl,
              accessToken,
              totalBytes,
            });
            if (status.complete) {
              finalResponse = status.response;
              position = totalBytes;
              uploaded = true;
              break;
            }
            if (status.nextByte > position) {
              position = status.nextByte;
              uploaded = true;
              break;
            }
          } catch (statusError) {
            lastError = statusError;
          }
        }
      }

      if (!uploaded) {
        throw lastError || new Error('YouTube upload failed after retries');
      }
    }
  } finally {
    await handle.close();
  }

  if (!finalResponse?.id) {
    const status = await queryUploadPosition({
      uploadUrl,
      accessToken,
      totalBytes,
    });
    finalResponse = status.response || finalResponse;
  }

  if (!finalResponse?.id) {
    throw new Error(
      `YouTube upload completed without a video id: ${JSON.stringify(finalResponse)}`,
    );
  }

  return {
    video_id: finalResponse.id,
    privacy_status:
      finalResponse.status?.privacyStatus || 'private',
    draft_title: requestBody.snippet.title,
    description_set: Boolean(requestBody.snippet.description),
    tag_count: requestBody.snippet.tags.length,
    category_id: requestBody.snippet.categoryId,
    made_for_kids: false,
    youtube_url: `https://youtu.be/${finalResponse.id}`,
    studio_edit_url: `https://studio.youtube.com/video/${finalResponse.id}/edit`,
    uploaded_bytes: totalBytes,
  };
};

const main = async () => {
  for (const name of REQUIRED_ENV) getEnv(name);

  const [videoPath, metadataPath, outputPath = 'youtube_upload.json'] =
    process.argv.slice(2);

  if (!videoPath || !metadataPath) {
    throw new Error(
      'Usage: node youtube-upload.mjs <video.mp4> <publish_metadata.json> [output.json]',
    );
  }

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const result = await uploadVideo({videoPath, metadata});
  await writeFile(
    outputPath,
    JSON.stringify(result, null, 2) + '\n',
    'utf8',
  );

  console.log(
    `YOUTUBE UPLOAD COMPLETE: video_id=${result.video_id} privacy=${result.privacy_status}`,
  );
  console.log(`Studio: ${result.studio_edit_url}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
