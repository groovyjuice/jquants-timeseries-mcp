import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';

const CLIENT_FILE = process.argv[2];

const loadClient = async () => {
  if (CLIENT_FILE) {
    const parsed = JSON.parse(await readFile(CLIENT_FILE, 'utf8'));
    const client = parsed.installed || parsed.web;
    if (!client?.client_id || !client?.client_secret) {
      throw new Error('OAuth JSON does not contain client_id/client_secret');
    }
    return {
      clientId: client.client_id,
      clientSecret: client.client_secret,
    };
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Pass the Google OAuth desktop client JSON file as the first argument, or set YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET.',
    );
  }
  return {clientId, clientSecret};
};

const base64url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const main = async () => {
  const {clientId, clientSecret} = await loadClient();
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(
    createHash('sha256').update(verifier).digest(),
  );

  const server = http.createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) throw new Error('Could not start local OAuth callback server');

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set(
    'scope',
    'https://www.googleapis.com/auth/youtube.upload',
  );
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for Google authorization...\n');

  const result = await new Promise((resolve, reject) => {
    server.on('request', async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        if (url.searchParams.get('state') !== state) {
          throw new Error('OAuth state mismatch');
        }

        const error = url.searchParams.get('error');
        if (error) throw new Error(`Google OAuth error: ${error}`);

        const code = url.searchParams.get('code');
        if (!code) throw new Error('Google did not return an OAuth code');

        const tokenResponse = await fetch(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              code_verifier: verifier,
              grant_type: 'authorization_code',
              redirect_uri: redirectUri,
            }),
          },
        );

        const tokens = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok) {
          throw new Error(
            `Token exchange failed: HTTP ${tokenResponse.status} ${JSON.stringify(tokens)}`,
          );
        }

        res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
        res.end(
          '<h2>YouTube authorization complete.</h2><p>You can close this window and return to the terminal.</p>',
        );
        resolve(tokens);
      } catch (error) {
        res.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
        res.end(String(error));
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  if (!result.refresh_token) {
    throw new Error(
      'No refresh token was returned. Revoke the existing app grant and rerun with prompt=consent.',
    );
  }

  console.log('\nAuthorization complete. Add these GitHub Actions secrets:\n');
  console.log(`YOUTUBE_CLIENT_ID=${clientId}`);
  console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret}`);
  console.log(`YOUTUBE_REFRESH_TOKEN=${result.refresh_token}`);
  console.log(
    '\nKeep these values private. Do not commit them to the repository.\n',
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
