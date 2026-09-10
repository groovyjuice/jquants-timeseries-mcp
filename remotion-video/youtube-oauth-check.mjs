import {google} from 'googleapis';

const firstEnv = (...names) => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is not configured`);
};

const oauth2 = new google.auth.OAuth2(
  firstEnv('YOUTUBE_CLIENT_ID', 'GOOGLE_CLIENT_ID'),
  firstEnv('YOUTUBE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'),
);

oauth2.setCredentials({refresh_token: firstEnv('YOUTUBE_REFRESH_TOKEN')});
const token = await oauth2.getAccessToken();
if (!token?.token) throw new Error('Could not obtain an access token');

const info = await oauth2.getTokenInfo(token.token);
const scopes = Array.isArray(info.scopes) ? info.scopes : [];
const required = 'https://www.googleapis.com/auth/youtube.upload';
if (!scopes.includes(required)) {
  throw new Error(`Refresh token does not include ${required}. Scopes: ${scopes.join(', ')}`);
}

console.log('YouTube OAuth preflight passed.');
console.log(`Scopes: ${scopes.join(', ')}`);
