import http from 'node:http';
import {createHash, randomBytes} from 'node:crypto';

const getEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const base64url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const main = async () => {
  // No credential JSON file is used. Reuse the same OAuth client already
  // configured for Google Drive, and request a separate YouTube refresh token.
  const clientId = getEnv('GOOGLE_CLIENT_ID');
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET');

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

        const oauthError = url.searchParams.get('error');
        if (oauthError) throw new Error(`Google OAuth error: ${oauthError}`);

        const code = url.searchParams.get('code');
        if (!code) throw new Error('Google did not return an OAuth code');

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {'content-type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        });

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
      'No refresh token was returned. Revoke the existing app grant and rerun.',
    );
  }

  console.log('\nAuthorization complete. Add ONLY this new GitHub Actions secret:\n');
  console.log(`YOUTUBE_REFRESH_TOKEN=${result.refresh_token}`);
  console.log(
    '\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are reused from the existing Drive OAuth configuration. Keep the refresh token private.\n',
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
