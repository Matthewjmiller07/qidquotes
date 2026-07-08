import type { Env } from './types';

async function getAccessToken(env: Env): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_PHOTOS_CLIENT_ID,
      client_secret: env.GOOGLE_PHOTOS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_PHOTOS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Photos token exchange failed: ${res.status}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

export async function uploadToGooglePhotos(
  imageBytes: ArrayBuffer,
  contentType: string,
  caption: string,
  env: Env,
): Promise<string> {
  const token = await getAccessToken(env);

  const ext = contentType.includes('jpeg') || contentType.includes('jpg')
    ? 'jpg'
    : (contentType.split('/')[1] ?? 'webp');
  const filename = `quote-${Date.now()}.${ext}`;

  const uploadRes = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-File-Name': filename,
      'X-Goog-Upload-Protocol': 'raw',
    },
    body: imageBytes,
  });
  if (!uploadRes.ok) throw new Error(`Photos upload failed: ${uploadRes.status}`);
  const uploadToken = await uploadRes.text();

  const createRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      albumId: env.GOOGLE_PHOTOS_ALBUM_ID,
      newMediaItems: [{
        description: caption,
        simpleMediaItem: { fileName: filename, uploadToken },
      }],
    }),
  });
  if (!createRes.ok) throw new Error(`Photos batchCreate failed: ${createRes.status}`);

  const data = await createRes.json() as {
    newMediaItemResults: Array<{
      status: { message: string };
      mediaItem?: { productUrl: string };
    }>;
  };

  const result = data.newMediaItemResults[0];
  if (result.status.message !== 'Success' || !result.mediaItem) {
    throw new Error(`Photos item creation failed: ${result.status.message}`);
  }

  return result.mediaItem.productUrl;
}
