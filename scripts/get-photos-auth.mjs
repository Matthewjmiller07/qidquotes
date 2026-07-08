/**
 * One-time script to get a Google Photos refresh token.
 * Run: node scripts/get-photos-auth.mjs
 * Requires CLIENT_ID and CLIENT_SECRET env vars.
 */
import { createServer } from 'http';
import { exec } from 'child_process';

const { CLIENT_ID, CLIENT_SECRET } = process.env;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: CLIENT_ID=xxx CLIENT_SECRET=yyy node scripts/get-photos-auth.mjs');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:8080/callback';
const SCOPE = [
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
].join(' ');

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080');
  const code = url.searchParams.get('code');
  if (!code) { res.end('No code'); return; }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>✅ Authorized! You can close this tab.</h1>');
  server.close();

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    console.error('❌ No refresh token returned:', tokens);
    process.exit(1);
  }

  console.log('\n✅ Success! Copy these values:\n');
  console.log('REFRESH_TOKEN:', tokens.refresh_token);

  // Also list albums so we can find the album ID
  console.log('\n🔍 Fetching your albums...\n');
  const albumsRes = await fetch('https://photoslibrary.googleapis.com/v1/albums?pageSize=50', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const albums = await albumsRes.json();
  if (albums.albums) {
    albums.albums.forEach(a => console.log(`  ${a.title}: ${a.id}`));
  } else {
    console.log('Could not list albums:', albums);
  }
});

server.listen(8080, () => {
  console.log('Opening browser...\n');
  exec(`open "${authUrl}"`);
});
