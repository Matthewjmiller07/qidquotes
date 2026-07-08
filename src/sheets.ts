import type { Env, ChildInfo } from './types';

async function getAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const pem = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const keyBody = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(keyBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${encodedSig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// Reads the "names" tab (case-insensitive). Columns: Name | Birthday (MM/DD/YYYY) | Photo URL 1 | ...
// Row 1 is a header row and is skipped. Birthday is optional — missing/unparseable defaults to Jan 1 2020.
export async function loadChildren(env: Env): Promise<ChildInfo[]> {
  const token = await getAccessToken(env);

  // Find the tab case-insensitively so "Names" or "NAMES" also work
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`loadChildren meta failed: ${metaRes.status}`);
  const meta = await metaRes.json() as { sheets: Array<{ properties: { title: string } }> };
  const sheet = meta.sheets.find((s) => s.properties.title.toLowerCase() === 'names');
  if (!sheet) throw new Error('No tab named "names" found in spreadsheet');
  const tabName = sheet.properties.title;

  const range = encodeURIComponent(`${tabName}!A:Z`);
  const valRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!valRes.ok) {
    const err = await valRes.text();
    throw new Error(`loadChildren values failed: ${valRes.status} ${err}`);
  }

  const data = await valRes.json() as { values?: string[][] };
  const rows = (data.values ?? []).slice(1); // skip header row

  return rows
    .filter((row) => row[0]?.trim()) // only require a name
    .map((row) => {
      const [name, birthdayStr, colC, ...rest] = row;
      let birthday: [number, number, number] | null = null;
      if (birthdayStr?.trim()) {
        const parts = birthdayStr.trim().split('/').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
          const [mm, dd, yyyy] = parts;
          birthday = [yyyy, mm, dd];
        }
      }
      // Col C is a photo URL in old layout, scene hint in new layout
      const isOldLayout = colC?.trim().startsWith('https://');
      const defaultSceneHint = isOldLayout ? '' : (colC?.trim() ?? '');
      const photoItems = isOldLayout ? [colC, ...rest] : rest;
      return {
        name: name.trim(),
        birthday,
        defaultSceneHint,
        photoUrls: photoItems.filter((u) => u?.trim()).map((u) => u.trim()),
      };
    });
}

export async function appendQuote(
  childName: string,
  quoteText: string,
  _imageUrl: string,
  env: Env,
  customDate?: string,
  tag?: string, // 'eggcorn' | 'lie' | '' — written to col E (old rows used 'yes' for eggcorn)
  sceneHint?: string,
): Promise<number> {
  const token = await getAccessToken(env);

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const date = customDate ?? `${get('day')}/${get('month')}/${get('year')}`;
  const time = `${get('hour')}:${get('minute')}`;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
    `/values/Quotes!A:F:append?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [[date, time, childName, quoteText, tag ?? '', sceneHint ?? '']] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { updates?: { updatedRange?: string } };
  const updatedRange = data.updates?.updatedRange ?? '';
  // updatedRange looks like "Quotes!A5:E5" — extract the row number
  const match = updatedRange.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function addNameToSheet(name: string, birthday: string, env: Env): Promise<void> {
  const token = await getAccessToken(env);

  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`addNameToSheet meta failed: ${metaRes.status}`);
  const meta = await metaRes.json() as { sheets: Array<{ properties: { title: string } }> };
  const sheet = meta.sheets.find((s) => s.properties.title.toLowerCase() === 'names');
  if (!sheet) throw new Error('No tab named "names" found in spreadsheet');
  const tabName = sheet.properties.title;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
    `/values/${encodeURIComponent(tabName + '!A:C')}:append?valueInputOption=USER_ENTERED`;

  // Always write 3 columns to establish new layout: Name | Birthday | SceneHint(empty)
  const row = [name, birthday, ''];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`addNameToSheet append failed: ${res.status} ${err}`);
  }
}

export async function updatePersonSceneHint(name: string, sceneHint: string, env: Env): Promise<void> {
  const token = await getAccessToken(env);

  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`updatePersonSceneHint meta failed: ${metaRes.status}`);
  const meta = await metaRes.json() as { sheets: Array<{ properties: { title: string } }> };
  const sheet = meta.sheets.find((s) => s.properties.title.toLowerCase() === 'names');
  if (!sheet) throw new Error('No tab named "names" found');
  const tabName = sheet.properties.title;

  const range = encodeURIComponent(`${tabName}!A:C`);
  const valRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!valRes.ok) throw new Error(`updatePersonSceneHint read failed: ${valRes.status}`);
  const data = await valRes.json() as { values?: string[][] };
  const rows = data.values ?? [];

  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0]?.trim() === name);
  if (rowIdx === -1) { console.warn(`updatePersonSceneHint: "${name}" not found`); return; }

  const colC = rows[rowIdx][2]?.trim() ?? '';
  if (colC.startsWith('https://')) {
    // Old layout — col C is a photo URL; skip to avoid overwriting it
    return;
  }

  const writeRange = encodeURIComponent(`${tabName}!C${rowIdx + 1}`);
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${writeRange}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[sceneHint]] }),
    },
  );
  if (!writeRes.ok) {
    const err = await writeRes.text();
    throw new Error(`updatePersonSceneHint write failed: ${writeRes.status} ${err}`);
  }
}

export async function addPhotoToNamesTab(name: string, photoUrl: string, env: Env): Promise<void> {
  const token = await getAccessToken(env);

  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`addPhotoToNamesTab meta failed: ${metaRes.status}`);
  const meta = await metaRes.json() as { sheets: Array<{ properties: { title: string } }> };
  const sheet = meta.sheets.find((s) => s.properties.title.toLowerCase() === 'names');
  if (!sheet) throw new Error('No tab named "names" found');
  const tabName = sheet.properties.title;

  const range = encodeURIComponent(`${tabName}!A:Z`);
  const valRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!valRes.ok) throw new Error(`addPhotoToNamesTab read failed: ${valRes.status}`);
  const data = await valRes.json() as { values?: string[][] };
  const rows = data.values ?? [];

  // Find person's row (1-indexed, row 1 is header)
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0]?.trim() === name);
  if (rowIdx === -1) {
    console.warn(`addPhotoToNamesTab: "${name}" not found in Names tab`);
    return;
  }

  const row = rows[rowIdx];
  // Old layout: photos at C+ (index 2). New layout: scene hint at C, photos at D+ (index 3).
  const isOldLayout = row[2]?.trim().startsWith('https://');
  const photoMinIdx = isOldLayout ? 2 : 3;
  const colIdx = Math.max(photoMinIdx, row.length);
  const colLetter = String.fromCharCode(65 + colIdx);
  const sheetRow = rowIdx + 1;

  const writeRange = encodeURIComponent(`${tabName}!${colLetter}${sheetRow}`);
  const writeUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
    `/values/${writeRange}?valueInputOption=RAW`;

  const writeRes = await fetch(writeUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [[photoUrl]] }),
  });

  if (!writeRes.ok) {
    const err = await writeRes.text();
    throw new Error(`addPhotoToNamesTab write failed: ${writeRes.status} ${err}`);
  }
}

export async function readQuoteRow(row: number, env: Env): Promise<string[]> {
  const token = await getAccessToken(env);
  const range = encodeURIComponent(`Quotes!A${row}:Z${row}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`readQuoteRow failed: ${res.status}`);
  const data = await res.json() as { values?: string[][] };
  return data.values?.[0] ?? [];
}

export async function updateQuoteImage(row: number, col: string, imageUrl: string, env: Env): Promise<void> {
  const token = await getAccessToken(env);
  const range = encodeURIComponent(`Quotes!${col}${row}`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}` +
    `/values/${range}?valueInputOption=RAW`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [[imageUrl]] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets update failed: ${res.status} ${err}`);
  }
}
