import {createReadStream} from 'node:fs';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {google} from 'googleapis';

const getEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const firstEnv = (...names) => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is not configured`);
};

const cleanTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim().replace(/^#+/, ''))
    .filter(Boolean);

const main = async () => {
  const [videoPath, metadataPath, outputPath = 'youtube_upload.json'] =
    process.argv.slice(2);

  if (!videoPath || !metadataPath) {
    throw new Error(
      'Usage: node youtube-direct-upload.mjs <video.mp4> <publish_metadata.json> [output.json]',
    );
  }

  const fileStat = await stat(videoPath);
  if (!fileStat.size) throw new Error('Video file is empty');

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const title =
    String(metadata?.title_candidates?.[0] || '').trim() ||
    process.env.YOUTUBE_DRAFT_TITLE?.trim() ||
    '【下書き】タイトルを設定してください';
  const description = String(metadata?.description || '').trim();
  const tags = cleanTags(metadata?.tags);
  const categoryId = process.env.YOUTUBE_CATEGORY_ID?.trim() || '25';

  if (!description) throw new Error('YouTube description is empty');
  if (!tags.length) throw new Error('YouTube tags are empty');

  const oauth2 = new google.auth.OAuth2(
    firstEnv('YOUTUBE_CLIENT_ID', 'GOOGLE_CLIENT_ID'),
    firstEnv('YOUTUBE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'),
  );
  oauth2.setCredentials({refresh_token: getEnv('YOUTUBE_REFRESH_TOKEN')});

  // Fail fast on OAuth problems before streaming the large video file.
  await oauth2.getAccessToken();

  const youtube = google.youtube({version: 'v3', auth: oauth2});

  console.log(`Uploading ${fileStat.size} bytes directly to YouTube Data API...`);
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId,
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
    },
    media: {
      mimeType: 'video/mp4',
      body: createReadStream(videoPath),
    },
  });

  const video = response.data || {};
  const videoId = String(video.id || '').trim();
  if (!videoId) throw new Error(`YouTube API returned no video id: ${JSON.stringify(video)}`);

  const privacyStatus = video.status?.privacyStatus || null;
  const result = {
    provider: 'youtube-data-api',
    video_id: videoId,
    youtube_url: `https://youtu.be/${videoId}`,
    studio_edit_url: `https://studio.youtube.com/video/${videoId}/edit`,
    privacy_status: privacyStatus,
    contains_synthetic_media: video.status?.containsSyntheticMedia === true,
    self_declared_made_for_kids: video.status?.selfDeclaredMadeForKids ?? false,
    draft_title: video.snippet?.title || title,
    description_set: Boolean(String(video.snippet?.description || description).trim()),
    tag_count: Array.isArray(video.snippet?.tags) ? video.snippet.tags.length : tags.length,
    category_id: video.snippet?.categoryId || categoryId,
    upload_response: video,
  };

  if (result.privacy_status !== 'private') {
    throw new Error(`YouTube privacy status is not private: ${JSON.stringify(result)}`);
  }
  if (!result.description_set) throw new Error('YouTube description was not set');
  if (result.tag_count < 1) throw new Error('YouTube tags were not set');

  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`YOUTUBE DRAFT COMPLETE via Data API: ${videoId}`);
  console.log(`Studio: ${result.studio_edit_url}`);
};

main().catch((error) => {
  const detail = error?.response?.data
    ? `\nYouTube API response: ${JSON.stringify(error.response.data)}`
    : '';
  console.error(`${error?.stack || error}${detail}`);
  process.exit(1);
});
