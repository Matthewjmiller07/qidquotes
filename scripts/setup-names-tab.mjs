/**
 * Creates the "names" tab in the QidQuotes spreadsheet and populates it.
 * Run: GOOGLE_SERVICE_ACCOUNT_EMAIL=xxx GOOGLE_PRIVATE_KEY=yyy node scripts/setup-names-tab.mjs
 *
 * GOOGLE_PRIVATE_KEY: paste the full PEM block (with real newlines, or with literal \n).
 */

const SHEETS_ID = '1tMeTdXJ81SRtq9sEFUe9eqHrX9z4NuTid8-LVZ4UKrs';

const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;
if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error(
    'Usage: GOOGLE_SERVICE_ACCOUNT_EMAIL=xxx GOOGLE_PRIVATE_KEY=yyy node scripts/setup-names-tab.mjs',
  );
  process.exit(1);
}

// ── JWT / token ───────────────────────────────────────────────────────────────

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const pem = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const keyBody = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Buffer.from(keyBody, 'base64');

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

  const encodedSig = Buffer.from(sig).toString('base64url');
  const jwt = `${signingInput}.${encodedSig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    console.error('Token error:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Sheets helpers ────────────────────────────────────────────────────────────

async function sheetsRequest(token, method, path, body) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const token = await getAccessToken();
console.log('✅ Got access token');

// 1. Check if "names" tab already exists
const meta = await sheetsRequest(token, 'GET', '');
const existing = meta.sheets.find((s) => s.properties.title === 'names');

if (existing) {
  console.log('ℹ️  "names" tab already exists — overwriting data');
} else {
  // Create the tab
  await sheetsRequest(token, 'POST', ':batchUpdate', {
    requests: [{ addSheet: { properties: { title: 'names' } } }],
  });
  console.log('✅ Created "names" tab');
}

// 2. Write header + data
// Columns: Name | Birthday (MM/DD/YYYY) | Photo URL 1 | Photo URL 2 | ...
const rows = [
  ['Name', 'Birthday (MM/DD/YYYY)', 'Photo URL 1', 'Photo URL 2'],
  ['Aviya',  '05/26/2021', '', ''],
  ['Tzofia', '02/26/2024', '', ''],
  ['Lielle', '03/25/2026', '', ''],
  ['Miriam', '08/16/2018', 'https://i.imgur.com/UArK1kH.jpeg', ''],
];

await sheetsRequest(
  token,
  'PUT',
  `/values/${encodeURIComponent('names!A1')}?valueInputOption=RAW`,
  { values: rows },
);

console.log('✅ Populated "names" tab with header + 4 children');
console.log('\nOpen the sheet and fill in photo URLs for Aviya, Tzofia, and Lielle:');
console.log(`https://docs.google.com/spreadsheets/d/${SHEETS_ID}/edit`);
