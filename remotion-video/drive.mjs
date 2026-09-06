import {google} from 'googleapis';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const parseServiceAccount = () => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
    }
  }
};

const getAuth = () => {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    const auth = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({refresh_token: GOOGLE_REFRESH_TOKEN});
    return auth;
  }

  const credentials = parseServiceAccount();
  if (credentials) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });
  }

  throw new Error(
    'Google Drive auth is not configured. Set OAuth refresh-token variables or GOOGLE_SERVICE_ACCOUNT_JSON.',
  );
};

const textFromBody = (body) => {
  if (!body?.content) return '';

  return body.content
    .flatMap((block) => block.paragraph?.elements || [])
    .map((element) => element.textRun?.content || '')
    .join('');
};

export const readGoogleDocText = async (documentId) => {
  if (typeof documentId !== 'string' || !documentId.trim()) {
    throw new Error('documentId must be a non-empty string');
  }

  const auth = getAuth();
  const docs = google.docs({version: 'v1', auth});
  const response = await docs.documents.get({
    documentId: documentId.trim(),
  });

  const script = textFromBody(response.data.body).trim();
  if (!script) {
    throw new Error('Google Doc did not contain readable text');
  }

  return {
    documentId: documentId.trim(),
    title: response.data.title || '',
    script,
  };
};


const getDrive = () => google.drive({version: 'v3', auth: getAuth()});

export const readDriveJsonFile = async (fileId) => {
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new Error('fileId must be a non-empty string');
  }

  const drive = getDrive();
  const response = await drive.files.get(
    {fileId: fileId.trim(), alt: 'media'},
    {responseType: 'arraybuffer'},
  );
  const text = Buffer.from(response.data).toString('utf8');
  return JSON.parse(text);
};

export const listDriveFolderFiles = async (folderId) => {
  if (typeof folderId !== 'string' || !folderId.trim()) {
    throw new Error('folderId must be a non-empty string');
  }

  const drive = getDrive();
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId.trim()}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,size)',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
};

export const downloadDriveFile = async ({fileId, outputPath}) => {
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new Error('fileId must be a non-empty string');
  }
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new Error('outputPath must be a non-empty string');
  }

  const drive = getDrive();
  const response = await drive.files.get(
    {fileId: fileId.trim(), alt: 'media'},
    {responseType: 'arraybuffer'},
  );

  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, Buffer.from(response.data));
  return outputPath;
};
