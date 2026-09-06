# YouTube one-time setup

This project uploads finished videos to YouTube as private drafts.

Automatic fields:
- Temporary title: `【下書き】タイトルを設定してください`
- Description: generated automatically
- Tags: generated automatically
- Privacy: private

Manual fields/actions:
- Final title
- Thumbnail
- Publish / schedule

## 1. Create or select a Google Cloud project

Open Google Cloud Console and create/select the project used only for this personal YouTube automation.

Enable:
- YouTube Data API v3

## 2. Configure OAuth consent

Add the YouTube upload scope:

`https://www.googleapis.com/auth/youtube.upload`

For stable long-term automation, do not leave the OAuth app in Testing indefinitely.
Testing-mode refresh tokens are time-limited.

This is a personal-use automation, so the owner may proceed through Google's unverified-app warning where applicable.

## 3. Create OAuth credentials

Create:
- OAuth client ID
- Application type: Desktop app

Download the client JSON file.

Do not commit the JSON file to GitHub.

## 4. Obtain the refresh token

From a local checkout of this repository:

```bash
cd remotion-video
node youtube-oauth-local.mjs /path/to/client_secret.json
```

The script prints a Google authorization URL.

Open it, sign in to the Google account that owns the YouTube channel, approve the YouTube upload permission, then return to the terminal.

The script prints:

- YOUTUBE_CLIENT_ID
- YOUTUBE_CLIENT_SECRET
- YOUTUBE_REFRESH_TOKEN

Keep these private.

## 5. Add GitHub Actions secrets

Repository:
Settings -> Secrets and variables -> Actions -> New repository secret

Create exactly these three secrets:

```text
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
```

Do not put these values in repository files, workflow YAML, issues, or chat logs.

## 6. Pipeline behavior

The generic workflow is:

`.github/workflows/video-pipeline.yml`

At the end of a successful run it:
1. Creates the final MP4
2. Verifies size/loudness
3. Uploads the MP4 to YouTube
4. Sets description and tags
5. Forces privacyStatus=private
6. Leaves the thumbnail untouched
7. Writes `youtube_upload.json` with the video ID and YouTube Studio edit URL

The workflow fails instead of publishing if YouTube OAuth credentials are missing or upload verification fails.
