import type { Env, LocationEntry, ChildInfo } from './types';
import { sendMessage, sendPhoto } from './telegram';
import { fetchPhotoAsDataUri } from './replicate';
import { loadChildren } from './sheets';

const KV_KEY = 'weather_locations';
const CHAT_ID = -1003932140533;

// ── Default locations ─────────────────────────────────────────────────────────
const DEFAULT_LOCATIONS: LocationEntry[] = [
  {
    city: 'Chicago, IL',
    lat: 41.8781,
    lon: -87.6298,
    timezone: 'America/Chicago',
    people: ['Aaron', 'Matthew', 'Aviya', 'Tzofia', 'Georgia', 'Lielle', 'Miriam'],
  },
  {
    city: 'Highland Park, IL',
    lat: 42.1817,
    lon: -87.8003,
    timezone: 'America/Chicago',
    people: ['Bubbie', 'Papa'],
  },
  {
    city: 'New York, NY',
    lat: 40.7128,
    lon: -74.006,
    timezone: 'America/New_York',
    people: ['Lorne'],
  },
];

// ── Illustration styles (shared by weather + zmanim) ─────────────────────────
export const WEATHER_THEMES: Record<string, { label: string; styleDesc: string }> = {
  watercolor: {
    label: '🎨 Watercolor',
    styleDesc: 'warm watercolor illustration style, soft pastel colors, gentle brushstrokes, painterly textures',
  },
  comic: {
    label: '💥 Comic',
    styleDesc: 'bold comic book style, strong ink outlines, vivid colors, dynamic composition, halftone shading',
  },
  anime: {
    label: '🌸 Anime',
    styleDesc: 'anime illustration style, clean linework, expressive characters, vibrant colors, cel-shaded',
  },
  pencil: {
    label: '✏️ Pencil',
    styleDesc: 'hand-drawn pencil sketch style, detailed graphite textures, soft warm tones, sketchbook feel',
  },
  pixel: {
    label: '🎮 Pixel Art',
    styleDesc: '16-bit pixel art style, charming retro game aesthetic, vibrant pixel colors, chunky sprites',
  },
  storybook: {
    label: '📖 Storybook',
    styleDesc: "classic children's picture book illustration style, rich painted textures, warm inviting colors",
  },
  lego: {
    label: '🧱 Lego',
    styleDesc: 'LEGO set box art style — all people are LEGO minifigures with blocky yellow heads, cylindrical bodies, and plastic claw hands. Bright primary LEGO brick colors. The scene is built from LEGO bricks. Official LEGO box art aesthetic.',
  },
};

function makeStyleRows(prefix: 'weather_style' | 'zmanim_style') {
  return [
    [
      { text: '🎨 Watercolor', callback_data: `${prefix}:watercolor` },
      { text: '💥 Comic',      callback_data: `${prefix}:comic` },
      { text: '🌸 Anime',      callback_data: `${prefix}:anime` },
      { text: '✏️ Pencil',     callback_data: `${prefix}:pencil` },
    ],
    [
      { text: '🎮 Pixel Art',  callback_data: `${prefix}:pixel` },
      { text: '📖 Storybook',  callback_data: `${prefix}:storybook` },
      { text: '🧱 Lego',       callback_data: `${prefix}:lego` },
    ],
  ];
}

function labelsKeyboard(prefix: 'weather_labels' | 'zmanim_labels') {
  return {
    inline_keyboard: [[
      { text: '✅ Yes, label them', callback_data: `${prefix}:yes` },
      { text: '❌ No labels',       callback_data: `${prefix}:no` },
    ]],
  };
}

// ── KV helpers ────────────────────────────────────────────────────────────────
async function getLocations(env: Env): Promise<LocationEntry[]> {
  const raw = await env.QIDQUOTES.get(KV_KEY);
  if (!raw) return DEFAULT_LOCATIONS;
  try { return JSON.parse(raw) as LocationEntry[]; } catch { return DEFAULT_LOCATIONS; }
}

async function saveLocations(env: Env, locations: LocationEntry[]): Promise<void> {
  await env.QIDQUOTES.put(KV_KEY, JSON.stringify(locations));
}

// ── Geocoding ─────────────────────────────────────────────────────────────────
async function geocodeCity(name: string): Promise<{ city: string; lat: number; lon: number; timezone: string } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as {
    results?: Array<{ name: string; country: string; admin1?: string; latitude: number; longitude: number; timezone?: string }>
  };
  const r = data.results?.[0];
  if (!r) return null;
  const label = r.admin1 ? `${r.name}, ${r.admin1}` : `${r.name}, ${r.country}`;
  return { city: label, lat: r.latitude, lon: r.longitude, timezone: r.timezone ?? 'UTC' };
}

// Resolve timezone — uses stored value if present, else queries Open-Meteo
async function resolveTimezone(lat: number, lon: number, stored?: string): Promise<string> {
  if (stored) return stored;
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&current=weather_code`);
    const d = await res.json() as { timezone?: string };
    return d.timezone ?? 'UTC';
  } catch { return 'UTC'; }
}

// ── WMO weather codes ─────────────────────────────────────────────────────────
const WMO_CODES: Record<number, { label: string; emoji: string }> = {
  0:  { label: 'Clear sky',     emoji: '☀️' },
  1:  { label: 'Mainly clear',  emoji: '🌤️' },
  2:  { label: 'Partly cloudy', emoji: '⛅' },
  3:  { label: 'Overcast',      emoji: '☁️' },
  45: { label: 'Foggy',         emoji: '🌫️' },
  48: { label: 'Rime fog',      emoji: '🌫️' },
  51: { label: 'Light drizzle', emoji: '🌦️' },
  53: { label: 'Drizzle',       emoji: '🌦️' },
  55: { label: 'Heavy drizzle', emoji: '🌧️' },
  61: { label: 'Light rain',    emoji: '🌧️' },
  63: { label: 'Rain',          emoji: '🌧️' },
  65: { label: 'Heavy rain',    emoji: '🌧️' },
  71: { label: 'Light snow',    emoji: '🌨️' },
  73: { label: 'Snow',          emoji: '❄️' },
  75: { label: 'Heavy snow',    emoji: '🌨️' },
  80: { label: 'Rain showers',  emoji: '🌦️' },
  81: { label: 'Heavy showers', emoji: '🌧️' },
  95: { label: 'Thunderstorm',  emoji: '⛈️' },
  96: { label: 'Storm w/ hail', emoji: '⛈️' },
  99: { label: 'Storm w/ hail', emoji: '⛈️' },
};

type WeatherData = { temp: number; feelsLike: number; humidity: number; wind: number; label: string; emoji: string };
type LocationWeatherResult = LocationEntry & { weather: WeatherData };

async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const data = await res.json() as {
    current: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number };
  };
  const c = data.current;
  const wmo = WMO_CODES[c.weather_code] ?? { label: 'Unknown', emoji: '🌡️' };
  return {
    temp: Math.round(c.temperature_2m),
    feelsLike: Math.round(c.apparent_temperature),
    humidity: c.relative_humidity_2m,
    wind: Math.round(c.wind_speed_10m),
    label: wmo.label,
    emoji: wmo.emoji,
  };
}

// ── Zmanim (Hebcal) ───────────────────────────────────────────────────────────
interface ZmanimResult { candleLighting: string; havdalah: string; parasha: string }

function extractTimeFromTitle(title: string): string {
  // "Candle lighting: 7:52pm" → "7:52pm"; "Havdalah (42 min): 9:04pm" → "9:04pm"
  const match = title.match(/:\s*([\d:]+\s*[ap]m)/i);
  return match ? match[1] : title;
}

async function fetchZmanim(lat: number, lon: number, storedTimezone?: string): Promise<ZmanimResult | null> {
  const timezone = await resolveTimezone(lat, lon, storedTimezone);
  const url =
    `https://www.hebcal.com/shabbat?cfg=json` +
    `&latitude=${lat}&longitude=${lon}` +
    `&tzid=${encodeURIComponent(timezone)}&M=on`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { items: Array<{ title: string; date: string; category: string }> };
    const parashat = data.items.find((i) => i.category === 'parashat');
    const candles  = data.items.find((i) => i.category === 'candles');
    const havdalah = data.items.find((i) => i.category === 'havdalah');
    return {
      candleLighting: candles  ? extractTimeFromTitle(candles.title)  : '',
      havdalah:       havdalah ? extractTimeFromTitle(havdalah.title) : '',
      parasha: parashat?.title ?? '',
    };
  } catch (err) {
    console.error('fetchZmanim error:', err);
    return null;
  }
}

// ── Reference image loader (shared) ──────────────────────────────────────────
async function loadReferenceImages(
  allPeople: string[],
  allChildren: ChildInfo[],
): Promise<{ referenceImages: string[]; refImageLabels: string[] }> {
  const referenceImages: string[] = [];
  const refImageLabels: string[] = [];
  let imgIdx = 1;
  for (const name of allPeople) {
    const child = allChildren.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!child || child.photoUrls.length === 0) continue;
    try {
      referenceImages.push(await fetchPhotoAsDataUri(child.photoUrls[0]));
      refImageLabels.push(`Reference image ${imgIdx} shows ${child.name}.`);
      imgIdx++;
    } catch (err) {
      console.error(`Could not load photo for ${name}:`, err);
    }
  }
  return { referenceImages, refImageLabels };
}

// ── Telegram + Replicate helpers ──────────────────────────────────────────────
async function tgSend(token: string, method: string, body: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCb(token: string, cbId: string, text: string): Promise<void> {
  await tgSend(token, 'answerCallbackQuery', { callback_query_id: cbId, text });
}

async function submitToReplicate(
  prompt: string,
  referenceImages: string[],
  webhookUrl: string,
  env: Env,
): Promise<void> {
  const input: Record<string, unknown> = {
    prompt,
    quality: 'low',
    aspect_ratio: '3:2',
  };
  if (referenceImages.length > 0) input.input_images = referenceImages;
  const res = await fetch('https://api.replicate.com/v1/models/openai/gpt-image-2/predictions', {
    method: 'POST',
    headers: { Authorization: `Token ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, webhook: webhookUrl, webhook_events_filter: ['completed'] }),
  });
  if (!res.ok) throw new Error(`Replicate submit error ${res.status}: ${await res.text()}`);
}

async function downloadAndSend(imageUrl: string, caption: string, env: Env): Promise<void> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const imageBytes = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get('content-type') ?? 'image/png';
  await sendPhoto(imageBytes, contentType, caption, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEATHER FLOW
// ─────────────────────────────────────────────────────────────────────────────

function buildWeatherPrompt(
  results: LocationWeatherResult[],
  refImageLabels: string[],
  dateLabel: string,
  style: string,
  labelPeople: boolean,
): string {
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;
  const refBlock = refImageLabels.length > 0 ? refImageLabels.join(' ') + ' ' : '';

  const sections = results.map(({ city, people, weather }) => {
    const peopleList = people.length === 1
      ? people[0]
      : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`;
    const labelNote = labelPeople
      ? `Display each person's name as a small label directly above their character in the scene. `
      : '';
    return (
      `A section for ${city} showing ${weather.label} (${weather.emoji} ${weather.temp}°F, feels ${weather.feelsLike}°F). ` +
      `The scene depicts ${peopleList} dressed for ${weather.label.toLowerCase()} conditions, appearances based on reference images where provided. ` +
      labelNote +
      `Section header: "${city}". Weather line: "${weather.emoji} ${weather.temp}°F — ${weather.label}". ` +
      `Names below the scene: "${people.join(', ')}".`
    );
  }).join(' | ');

  return (
    `Create a beautiful wide family weather card in ${theme.styleDesc}. ` +
    refBlock +
    `The card has a header "Family Weather" and the date "${dateLabel}" just below it. ` +
    `It has ${results.length} equal side-by-side sections with a soft divider between them: ` +
    sections +
    ` Each section's scene vividly matches its weather: sunny parks for clear skies, umbrellas and puddles for rain, scarves and snowflakes for snow, etc. ` +
    `Use reference images to depict each person's appearance in their city's scene. ` +
    `All city names, temperatures, the date, and people's names must be clearly legible. ` +
    `No outer border. High quality illustration.`
  );
}

// Step 1: /weather
export async function sendFamilyWeather(env: Env): Promise<void> {
  const locations = await getLocations(env);
  const results: LocationWeatherResult[] = await Promise.all(
    locations.map(async (loc) => ({ ...loc, weather: await fetchWeather(loc.lat, loc.lon) })),
  );

  const lines = results.map(({ city, people, weather }) =>
    `📍 ${city} — ${weather.emoji} ${weather.label}\n` +
    `🌡 ${weather.temp}°F (feels ${weather.feelsLike}°F)  💧 ${weather.humidity}%  💨 ${weather.wind} mph\n` +
    `👥 ${people.join(', ')}`,
  );
  await sendMessage(`🌦 Family Weather Report\n\n${lines.join('\n\n')}`, env);

  await tgSend(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: CHAT_ID,
    text: '🌦 WEATHER_PICK\nGenerate an image? Pick a style:',
    reply_markup: { inline_keyboard: makeStyleRows('weather_style') },
  });
}

// Step 2: style chosen → ask about labels
export async function handleWeatherStyleCallback(style: string, cbId: string, env: Env): Promise<void> {
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;
  await answerCb(env.TELEGRAM_BOT_TOKEN, cbId, `${theme.label} selected!`);
  await tgSend(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: CHAT_ID,
    text: `🌦 WEATHER_GEN [${style}]\nLabel people above their character in the scene?`,
    reply_markup: labelsKeyboard('weather_labels'),
  });
}

// Step 3: labels chosen → generate
export async function handleWeatherLabelsCallback(
  labelPeople: boolean,
  msgText: string,
  cbId: string,
  env: Env,
  workerOrigin: string,
): Promise<void> {
  const match = msgText.match(/^🌦 WEATHER_GEN \[([^\]]+)\]/);
  const style = match?.[1] ?? 'watercolor';
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;

  await answerCb(env.TELEGRAM_BOT_TOKEN, cbId, `${theme.label} — generating...`);
  await sendMessage(`✨ Generating ${theme.label} weather image${labelPeople ? ' with name labels' : ''}...`, env);

  const [locations, allChildren] = await Promise.all([
    getLocations(env),
    loadChildren(env).catch(() => [] as ChildInfo[]),
  ]);
  const results: LocationWeatherResult[] = await Promise.all(
    locations.map(async (loc) => ({ ...loc, weather: await fetchWeather(loc.lat, loc.lon) })),
  );
  const allPeople = results.flatMap((r) => r.people);
  const { referenceImages, refImageLabels } = await loadReferenceImages(allPeople, allChildren);
  const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  const prompt = buildWeatherPrompt(results, refImageLabels, dateLabel, style, labelPeople);

  try {
    await submitToReplicate(prompt, referenceImages, `${workerOrigin}/webhook/weather`, env);
  } catch (err) {
    console.error('Weather Replicate submit error:', err);
    await sendMessage('⚠️ Could not start weather image generation. Check Replicate credits.', env);
  }
}

export async function handleWeatherWebhook(bodyText: string, env: Env): Promise<void> {
  let body: { status: string; output: string | string[] | null; error?: string };
  try { body = JSON.parse(bodyText); } catch {
    console.error('Weather webhook: failed to parse body'); return;
  }
  if (body.status !== 'succeeded' || !body.output) {
    const detail = body.error ? ` — ${body.error}` : '';
    await sendMessage(`⚠️ Weather image generation failed${detail}`, env).catch(() => {});
    return;
  }
  const imageUrl = Array.isArray(body.output) ? body.output[0] : body.output;
  if (!imageUrl) return;
  await downloadAndSend(imageUrl, '🌦 Family Weather', env).catch(
    (err) => console.error('Weather webhook: failed to send image:', err),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ZMANIM FLOW
// ─────────────────────────────────────────────────────────────────────────────

type LocationZmanimResult = LocationEntry & { zmanim: ZmanimResult | null };

function buildZmanimPrompt(
  results: LocationZmanimResult[],
  refImageLabels: string[],
  parasha: string,
  dateLabel: string,
  style: string,
  labelPeople: boolean,
): string {
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;
  const refBlock = refImageLabels.length > 0 ? refImageLabels.join(' ') + ' ' : '';

  const sections = results.map(({ city, people, zmanim }) => {
    const peopleList = people.length === 1
      ? people[0]
      : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`;
    const labelNote = labelPeople
      ? `Display each person's name as a small label directly above their character. `
      : '';
    const candleTime = zmanim?.candleLighting ?? '–';
    const havdalahTime = zmanim?.havdalah ?? '–';
    return (
      `A section for ${city}: a warm glowing Shabbat scene with ${peopleList} around a white-tablecloth table with lit Shabbat candles, challah loaves, and a kiddush cup, dressed in Shabbat clothes, appearances based on reference images where provided. ` +
      labelNote +
      `Section header: "${city}". Two lines of text below the scene: "🕯 ${candleTime}" and "✨ ${havdalahTime}". ` +
      `Names at the bottom: "${people.join(', ')}".`
    );
  }).join(' | ');

  const parashaLine = parasha ? `The top banner reads "${parasha}". ` : '';

  return (
    `Create a beautiful warm family Shabbat times card in ${theme.styleDesc}. ` +
    refBlock +
    `Header: "Family Shabbat Times". Date just below: "${dateLabel}". ${parashaLine}` +
    `The card has ${results.length} equal side-by-side sections with a soft golden divider: ` +
    sections +
    ` The overall mood is warm, golden, and holy — candles glowing, soft Shabbat light filling each scene. ` +
    `Use reference images to depict each person's appearance. ` +
    `All city names, candle lighting times, havdalah times, and people's names must be clearly legible. ` +
    `No outer border. High quality illustration.`
  );
}

// Step 1: /zmanim
export async function sendFamilyZmanim(env: Env): Promise<void> {
  const locations = await getLocations(env);
  const results: LocationZmanimResult[] = await Promise.all(
    locations.map(async (loc) => ({ ...loc, zmanim: await fetchZmanim(loc.lat, loc.lon, loc.timezone) })),
  );

  const parasha = results.find((r) => r.zmanim?.parasha)?.zmanim?.parasha ?? '';
  const header = parasha ? `🕍 ${parasha}\n\n` : '';

  const lines = results.map(({ city, people, zmanim }) => {
    if (!zmanim || (!zmanim.candleLighting && !zmanim.havdalah)) {
      return `📍 ${city}\n⚠️ Times unavailable\n👥 ${people.join(', ')}`;
    }
    return (
      `📍 ${city}\n` +
      `🕯 Candle lighting: ${zmanim.candleLighting}\n` +
      `✨ Havdalah: ${zmanim.havdalah}\n` +
      `👥 ${people.join(', ')}`
    );
  });

  await sendMessage(`${header}🕯 Family Shabbat Times\n\n${lines.join('\n\n')}`, env);

  await tgSend(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: CHAT_ID,
    text: '🕍 ZMANIM_PICK\nGenerate a Shabbat image? Pick a style:',
    reply_markup: { inline_keyboard: makeStyleRows('zmanim_style') },
  });
}

// Step 2: style chosen → ask about labels
export async function handleZmanimStyleCallback(style: string, cbId: string, env: Env): Promise<void> {
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;
  await answerCb(env.TELEGRAM_BOT_TOKEN, cbId, `${theme.label} selected!`);
  await tgSend(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: CHAT_ID,
    text: `🕍 ZMANIM_GEN [${style}]\nLabel people above their character in the scene?`,
    reply_markup: labelsKeyboard('zmanim_labels'),
  });
}

// Step 3: labels chosen → generate
export async function handleZmanimLabelsCallback(
  labelPeople: boolean,
  msgText: string,
  cbId: string,
  env: Env,
  workerOrigin: string,
): Promise<void> {
  const match = msgText.match(/^🕍 ZMANIM_GEN \[([^\]]+)\]/);
  const style = match?.[1] ?? 'watercolor';
  const theme = WEATHER_THEMES[style] ?? WEATHER_THEMES.watercolor;

  await answerCb(env.TELEGRAM_BOT_TOKEN, cbId, `${theme.label} — generating...`);
  await sendMessage(`✨ Generating ${theme.label} Shabbat card${labelPeople ? ' with name labels' : ''}...`, env);

  const [locations, allChildren] = await Promise.all([
    getLocations(env),
    loadChildren(env).catch(() => [] as ChildInfo[]),
  ]);
  const results: LocationZmanimResult[] = await Promise.all(
    locations.map(async (loc) => ({ ...loc, zmanim: await fetchZmanim(loc.lat, loc.lon, loc.timezone) })),
  );
  const parasha = results.find((r) => r.zmanim?.parasha)?.zmanim?.parasha ?? '';
  const allPeople = results.flatMap((r) => r.people);
  const { referenceImages, refImageLabels } = await loadReferenceImages(allPeople, allChildren);
  const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  const prompt = buildZmanimPrompt(results, refImageLabels, parasha, dateLabel, style, labelPeople);

  try {
    await submitToReplicate(prompt, referenceImages, `${workerOrigin}/webhook/zmanim`, env);
  } catch (err) {
    console.error('Zmanim Replicate submit error:', err);
    await sendMessage('⚠️ Could not start Shabbat image generation. Check Replicate credits.', env);
  }
}

export async function handleZmanimWebhook(bodyText: string, env: Env): Promise<void> {
  let body: { status: string; output: string | string[] | null; error?: string };
  try { body = JSON.parse(bodyText); } catch {
    console.error('Zmanim webhook: failed to parse body'); return;
  }
  if (body.status !== 'succeeded' || !body.output) {
    const detail = body.error ? ` — ${body.error}` : '';
    await sendMessage(`⚠️ Shabbat image generation failed${detail}`, env).catch(() => {});
    return;
  }
  const imageUrl = Array.isArray(body.output) ? body.output[0] : body.output;
  if (!imageUrl) return;
  await downloadAndSend(imageUrl, '🕯 Family Shabbat Times', env).catch(
    (err) => console.error('Zmanim webhook: failed to send image:', err),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

export async function handleWeatherLocationsCommand(env: Env): Promise<void> {
  const locations = await getLocations(env);
  const lines = locations.map((loc) => `📍 ${loc.city}: ${loc.people.join(', ')}`);
  await sendMessage(`🗺 Family Locations\n\n${lines.join('\n')}\n\nUse /move [name] to [city] to update.`, env);
}

export async function handleMoveCommand(text: string, env: Env): Promise<void> {
  const match = text.match(/^\/move\s+(.+?)\s+to\s+(.+)$/i);
  if (!match) {
    await sendMessage('❓ Usage: /move [name] to [city]\nExample: /move Lorne to Chicago', env);
    return;
  }

  const [, personName, targetCityRaw] = match;
  const name = personName.trim();
  const cityQuery = targetCityRaw.trim();

  const locations = await getLocations(env);
  const currentCity = locations.find((loc) =>
    loc.people.some((p) => p.toLowerCase() === name.toLowerCase()),
  );
  let targetCity = locations.find((loc) =>
    loc.city.toLowerCase().includes(cityQuery.toLowerCase()),
  );

  if (!targetCity) {
    await sendMessage(`🔍 Looking up "${cityQuery}"...`, env);
    const geo = await geocodeCity(cityQuery);
    if (!geo) {
      await sendMessage(`❌ Couldn't find "${cityQuery}". Try a more specific name (e.g. "Chicago, IL").`, env);
      return;
    }
    targetCity = { city: geo.city, lat: geo.lat, lon: geo.lon, timezone: geo.timezone, people: [] };
    locations.push(targetCity);
  }

  if (currentCity && currentCity.city === targetCity.city) {
    await sendMessage(`ℹ️ ${name} is already in ${targetCity.city}.`, env);
    return;
  }

  const actualName = currentCity?.people.find((p) => p.toLowerCase() === name.toLowerCase()) ?? name;
  if (currentCity) {
    currentCity.people = currentCity.people.filter((p) => p.toLowerCase() !== name.toLowerCase());
  }
  targetCity.people.push(actualName);

  const pruned = locations.filter((loc) => loc.people.length > 0);
  await saveLocations(env, pruned);

  const moveMsg = currentCity
    ? `✅ Moved ${actualName} from ${currentCity.city} to ${targetCity.city}!`
    : `✅ Added ${actualName} to ${targetCity.city}!`;
  await sendMessage(`${moveMsg}\n📍 ${targetCity.city}: ${targetCity.people.join(', ')}`, env);
}
