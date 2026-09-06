# YouTube one-time setup

The standard pipeline uploads finished videos to YouTube through Upload-Post as private drafts.

Why Upload-Post is used:
- New unverified YouTube Data API projects can have API-uploaded videos locked as private.
- A locked-private API upload cannot simply be made public later in YouTube Studio.
- The desired workflow is: upload privately, then manually set the final title, thumbnail, and publish status.

Automatic fields:
- Temporary title: `【下書き】タイトルを設定してください`
- Description: generated automatically
- Tags: generated automatically
- Privacy: private

Manual fields/actions:
- Final title
- Thumbnail
- Publish / schedule

## 1. Create an Upload-Post account

Create an account at Upload-Post.

Create one profile for 賢明なる投資家チャンネル and connect the target YouTube channel to that profile.

Record the profile username.

## 2. Create an Upload-Post API key

Generate an API key in the Upload-Post dashboard.

Keep it private.

The pipeline needs exactly:

```text
UPLOAD_POST_API_KEY
UPLOAD_POST_USER
```

`UPLOAD_POST_USER` is the Upload-Post profile username that has the YouTube channel connected.

## 3. Add GitHub Actions secrets

Repository:
Settings -> Secrets and variables -> Actions -> New repository secret

Create:

```text
UPLOAD_POST_API_KEY
UPLOAD_POST_USER
```

Do not put the API key in repository files, workflow YAML, issues, or chat logs.

## 4. Pipeline behavior

The generic workflow is:

`.github/workflows/video-pipeline.yml`

At the end of a successful run it:
1. Creates the final MP4
2. Verifies size and loudness
3. Uploads the MP4 to YouTube through Upload-Post
4. Sets the generated description
5. Sets the generated tags
6. Uses the fixed temporary title
7. Sets YouTube privacy to private
8. Does not set a thumbnail
9. Does not publish or schedule
10. Writes `youtube_upload.json` with the YouTube video ID/URL where available

The workflow fails rather than silently succeeding if Upload-Post credentials are missing or the YouTube upload fails.

## Legacy direct YouTube API path

`youtube-upload.mjs` and `youtube-oauth-local.mjs` remain in the repository for future use if a YouTube API project is audited/verified.

They are not the standard production path.
