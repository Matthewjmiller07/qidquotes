import type { Env, ChildInfo } from './types';
import { getAge, isAdult } from './age';

const THEMES: Record<string, { opening: string; closing: string }> = {
  watercolor: {
    opening: 'warm watercolor storybook style',
    closing: 'Soft pastel colors, warm and loving mood, no border.',
  },
  comic: {
    opening: 'bold comic book style, dynamic composition, strong ink outlines',
    closing: 'Vivid bold colors, energetic comic book mood, no border.',
  },
  anime: {
    opening: 'anime illustration style, clean linework, expressive characters',
    closing: 'Vibrant anime colors, warm and joyful mood, no border.',
  },
  pencil: {
    opening: 'hand-drawn pencil sketch style, detailed graphite textures',
    closing: 'Soft warm tones, gentle hand-drawn mood, no border.',
  },
  pixel: {
    opening: 'charming pixel art style, 16-bit retro game aesthetic',
    closing: 'Vibrant pixel colors, playful retro mood, no border.',
  },
  storybook: {
    opening: "classic children's picture book illustration style, rich painted textures",
    closing: 'Warm inviting colors, cozy storybook mood, no border.',
  },
};

async function fetchTelegramPhotoAsDataUri(fileId: string, env: Env): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json() as { ok: boolean; result?: { file_path?: string } };
  if (!data.ok || !data.result?.file_path) throw new Error(`getFile failed for fileId ${fileId}`);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
  return fetchPhotoAsDataUri(url);
}

export async function fetchPhotoAsDataUri(photoUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let imgRes: Response;
  try {
    imgRes = await fetch(photoUrl, { redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!imgRes.ok) throw new Error(`Photo fetch failed: ${imgRes.status}`);

  const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
  if (contentType.includes('text/html')) throw new Error('Got HTML, not an image');

  const buffer = await imgRes.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('Photo URL returned empty body');

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

interface SceneContext {
  adultSayer: boolean;
  sayerName: string;
  age: string | null;
  themeOpening: string;
  themeClosing: string;
  quoteDateLabel: string;
  imageLines: string[];
  depictionLine: string;
  referenceImages: string[];
}

// Shared by buildInput (gpt-image) and buildFluxInput (Flux Klein): figures out who's
// in the scene, gathers reference photos, and resolves theme/date text common to both.
async function buildSceneContext(
  child: ChildInfo,
  quoteText: string,
  quoteDate: Date,
  allPeople: ChildInfo[],
  env: Env,
  sceneHint: string | undefined,
  uploadedFileId: string | undefined,
  referenceImageUrl: string | undefined,
  secondChild: ChildInfo | undefined,
  theme: string | undefined,
  sceneRefFileId: string | undefined,
  extraRefs: { name: string; url: string }[] = [],
): Promise<SceneContext> {
  const adultSayer = isAdult(child.birthday);
  const { name: sayerName, photoUrls } = child;
  const age = adultSayer ? null : getAge(child.birthday, quoteDate);

  const hasSayerPhoto = photoUrls.length > 0;

  // Everyone (other than the sayer) whose name appears in the quote or scene hint
  const searchText = sceneHint ? `${quoteText} ${sceneHint}` : quoteText;
  const mentionedPeople = allPeople.filter(
    (p) => p.name !== sayerName && new RegExp(`\\b${p.name}\\b`, 'i').test(searchText),
  );
  const mentionedWithPhotos = mentionedPeople.filter((p) => p.photoUrls.length > 0);

  // ── Build reference image labels for the prompt ───────────────────────────
  const imageLines: string[] = [];
  let imgIdx = 1;

  // Uploaded photo or regen reference URL takes priority; fall back to sheet photo.
  if (uploadedFileId || referenceImageUrl) {
    imageLines.push(`Reference image ${imgIdx} shows ${sayerName}.`);
    imgIdx++;
  } else if (hasSayerPhoto) {
    imageLines.push(`Reference image ${imgIdx} shows ${sayerName}.`);
    imgIdx++;
  }
  for (const person of mentionedWithPhotos) {
    imageLines.push(`Reference image ${imgIdx} shows ${person.name}.`);
    imgIdx++;
  }

  // For dialog cards, also include a reference image for the second child if available
  // and not already included via mentionedWithPhotos.
  const secondChildIncluded = secondChild && mentionedWithPhotos.some(p => p.name === secondChild.name);
  if (secondChild && secondChild.photoUrls.length > 0 && !secondChildIncluded) {
    imageLines.push(`Reference image ${imgIdx} shows ${secondChild.name}.`);
    imgIdx++;
  }

  // ── Who to depict ─────────────────────────────────────────────────────────
  const sayerLabel = adultSayer ? sayerName : `the child ${sayerName}`;
  const otherNames = mentionedPeople.map((p) => p.name);
  const hasPortrait = Boolean(uploadedFileId) || Boolean(referenceImageUrl) || hasSayerPhoto;
  const portraitClause = hasPortrait
    ? `Place a small, warm circular portrait of ${sayerName} in one corner of the card. `
    : '';
  const depictionLine = otherNames.length > 0
    ? `${portraitClause}Depict ${sayerLabel} as the central character in the illustration, and also show ${otherNames.join(' and ')} in the scene.`
    : `${portraitClause}Depict ${sayerLabel} as the central character in the illustration.`;

  const { opening: themeOpening, closing: themeClosing } = THEMES[theme ?? 'watercolor'] ?? THEMES['watercolor'];
  const quoteDateLabel = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(quoteDate);

  // ── Load reference images ─────────────────────────────────────────────────
  const referenceImages: string[] = [];

  // Uploaded Telegram photo takes first priority; regen reference URL second; sheet photo as fallback.
  if (uploadedFileId) {
    try {
      referenceImages.push(await fetchTelegramPhotoAsDataUri(uploadedFileId, env));
    } catch (err) {
      console.error(`Could not load uploaded photo ${uploadedFileId}:`, err);
    }
  } else if (referenceImageUrl) {
    try {
      referenceImages.push(await fetchPhotoAsDataUri(referenceImageUrl));
    } catch (err) {
      console.error(`Could not load reference image URL ${referenceImageUrl}:`, err);
    }
  } else if (hasSayerPhoto) {
    const url = photoUrls[Math.floor(Math.random() * photoUrls.length)];
    try {
      referenceImages.push(await fetchPhotoAsDataUri(url));
    } catch (err) {
      console.error(`Could not load sayer photo ${url}:`, err);
    }
  }

  // Date-matched overrides from the API caller win over a random sheet photo.
  const extraRefByName = new Map(extraRefs.map((r) => [r.name.toLowerCase(), r.url]));
  for (const person of mentionedWithPhotos) {
    const override = extraRefByName.get(person.name.toLowerCase());
    const url = override ?? person.photoUrls[Math.floor(Math.random() * person.photoUrls.length)];
    try {
      referenceImages.push(await fetchPhotoAsDataUri(url));
    } catch (err) {
      console.error(`Could not load ${person.name} photo ${url}:`, err);
    }
  }

  // For dialog: also load second child's photo if not already included
  if (secondChild && secondChild.photoUrls.length > 0 && !secondChildIncluded) {
    const url = secondChild.photoUrls[Math.floor(Math.random() * secondChild.photoUrls.length)];
    try {
      referenceImages.push(await fetchPhotoAsDataUri(url));
    } catch (err) {
      console.error(`Could not load ${secondChild.name} photo for dialog:`, err);
    }
  }

  // Scene reference goes last and is labelled by its actual position, so it can't be
  // confused with a person even if an earlier photo failed to load.
  // 'exact:<fileId>' recreates the pictured place; 'loose:<fileId>' or a bare id only inspires.
  if (sceneRefFileId) {
    const exact = sceneRefFileId.startsWith('exact:');
    const fileId = sceneRefFileId.replace(/^(exact|loose):/, '');
    try {
      // API submissions pass an https:// URL (Imgur-hosted); the Telegram
      // flow passes a Telegram file_id.
      const dataUri = fileId.startsWith('http')
        ? await fetchPhotoAsDataUri(fileId)
        : await fetchTelegramPhotoAsDataUri(fileId, env);
      referenceImages.push(dataUri);
      const n = referenceImages.length;
      imageLines.push(
        (exact
          ? `Reference image ${n} shows a real place that must be the setting of the illustration. ` +
            `Recreate that exact place faithfully so it is instantly recognizable: keep its architecture, shape, proportions, ` +
            `colors, materials, roof, windows, doors, and surrounding features (trees, fences, paths) as they appear in reference image ${n}, ` +
            `only translated into the requested art style. Do not invent a different building or setting. `
          : `Reference image ${n} is scene inspiration only: use it to shape the setting, objects, composition and mood. `) +
        `Do not take anyone's appearance from reference image ${n} — every person must look like their own reference image or description.`,
      );
    } catch (err) {
      console.error(`Could not load scene reference ${fileId}:`, err);
    }
  }

  return { adultSayer, sayerName, age, themeOpening, themeClosing, quoteDateLabel, imageLines, depictionLine, referenceImages };
}

// Full quote-card prompt with the text baked in — quote, attribution, age, date, and tag
// labels all rendered by the image model itself. Shared by the premium (gpt-image) and
// budget (nano-banana) paths; both models render legible text.
function buildCardPrompt(
  ctx: SceneContext,
  quoteText: string,
  quoteDate: Date,
  tag?: string, // 'eggcorn' | 'lie' | undefined
  sceneHint?: string,
  secondChild?: ChildInfo,
  secondQuoteText?: string,
  dialogOrder?: 'before' | 'after',
): string {
  const { adultSayer, sayerName, age, themeOpening, themeClosing, quoteDateLabel, imageLines, depictionLine } = ctx;
  let prompt: string;

  if (secondChild && secondQuoteText) {
    // Dialog card: two speakers, conversation layout
    const secondAdult = isAdult(secondChild.birthday);
    const secondAge = secondAdult ? null : getAge(secondChild.birthday, quoteDate);
    const speaker1 = dialogOrder === 'before' ? secondChild.name : sayerName;
    const q1 = dialogOrder === 'before' ? secondQuoteText : quoteText;
    const age1 = dialogOrder === 'before' ? secondAge : age;
    const speaker2 = dialogOrder === 'before' ? sayerName : secondChild.name;
    const q2 = dialogOrder === 'before' ? quoteText : secondQuoteText;
    const age2 = dialogOrder === 'before' ? age : secondAge;
    const line1 = age1 ? `"${q1}" — ${speaker1} (${age1})` : `"${q1}" — ${speaker1}`;
    const line2 = age2 ? `"${q2}" — ${speaker2} (${age2})` : `"${q2}" — ${speaker2}`;

    const bothAdults = adultSayer && secondAdult;
    const dialogCardStyle = bothAdults
      ? `Create a wide quote card in a ${themeOpening}, capturing a conversation between two people. `
      : `Create a wide quote card in a ${themeOpening}, capturing a sweet moment between two people. `;
    const dialogDepict = bothAdults
      ? `Depict both ${sayerName} and ${secondChild.name} together in the illustration, showing their exchange. `
      : `Depict both ${sayerName} and ${secondChild.name} together in the illustration, showing their warm interaction. `;

    prompt =
      dialogCardStyle +
      (imageLines.length > 0 ? imageLines.join(' ') + ' ' : '') +
      dialogDepict +
      `${speaker1} said: "${q1}", then ${speaker2} replied: "${q2}"${sceneHint ? `, specifically showing ${sceneHint}` : ''}. ` +
      `At the bottom of the card, display their conversation in clear, elegant handwritten typography: ` +
      `${line1}   ${line2}. ` +
      `Below the quotes, on its own separate line, display the date in smaller text: ${quoteDateLabel}. ` +
      `All quote text must be fully legible. ${themeClosing}`;
  } else {
    const cardStyle = adultSayer
      ? `Create a wide quote card in a ${themeOpening}. `
      : `Create a wide children's quote card in a ${themeOpening}. `;
    const attribution = adultSayer
      ? `"${quoteText}" — ${sayerName}`
      : `"${quoteText}" — ${sayerName}, ${age}`;

    prompt =
      cardStyle +
      (imageLines.length > 0 ? imageLines.join(' ') + ' ' : '') +
      depictionLine + ' ' +
      `The illustration should depict or be inspired by what ${adultSayer ? sayerName : 'the child'} said: "${quoteText}"${sceneHint ? `, specifically showing ${sceneHint}` : ''}. ` +
      `At the bottom of the card, display the exact quote in clear, elegant handwritten typography: ` +
      `${attribution}. ` +
      `Below the quote, on its own separate line, display the date in smaller text: ${quoteDateLabel}. ` +
      `The quote text must be fully legible. ${themeClosing}`;

    if (tag === 'eggcorn') {
      prompt +=
        ` This quote is an eggcorn — the speaker has charmingly misheard or repurposed a word. ` +
        `Let the illustration playfully hint at the mix-up. ` +
        `Below the main quote text, also display the small label "🥚 eggcorn" in a subtle, whimsical font.`;
    } else if (tag === 'lie') {
      prompt +=
        ` This quote is a lie — the speaker is telling a playful fib or tall tale. ` +
        `Let the illustration gently hint that the claim isn't true, with a mischievous or exaggerated touch. ` +
        `Below the main quote text, also display the small label "🤥 lie" in a subtle, whimsical font.`;
    }
  }

  return prompt;
}

async function buildInput(
  child: ChildInfo,
  quoteText: string,
  quoteDate: Date,
  allPeople: ChildInfo[],
  env: Env,
  tag?: string, // 'eggcorn' | 'lie' | undefined
  sceneHint?: string,
  uploadedFileId?: string,
  referenceImageUrl?: string,
  secondChild?: ChildInfo,
  secondQuoteText?: string,
  dialogOrder?: 'before' | 'after',
  theme?: string,
  sceneRefFileId?: string,
  extraRefs: { name: string; url: string }[] = [],
): Promise<Record<string, unknown>> {
  const ctx = await buildSceneContext(child, quoteText, quoteDate, allPeople, env, sceneHint, uploadedFileId, referenceImageUrl, secondChild, theme, sceneRefFileId, extraRefs);
  const prompt = buildCardPrompt(ctx, quoteText, quoteDate, tag, sceneHint, secondChild, secondQuoteText, dialogOrder);

  // No openai_api_key — Replicate bills the run. (A BYO key that OpenAI rejects surfaces
  // from Replicate as a misleading E003 "high demand" error.)
  const input: Record<string, unknown> = { prompt, quality: 'low', aspect_ratio: '3:2' };
  if (ctx.referenceImages.length > 0) {
    input.input_images = ctx.referenceImages;
  }

  return input;
}

// Async submit for the budget path — same webhook contract, same full prompt, and same
// input shape as submitQuoteImageAsync, but hits gpt-image-1-mini instead of gpt-image-2.
// Billed via Replicate, roughly a third of premium per low-quality 3:2 image. Same
// model family, so reference-photo likeness and legible card text carry over.
// (The 'flux' model identifier in callback data / webhook URLs is kept for compatibility.)
export async function submitBudgetQuoteImageAsync(
  child: ChildInfo,
  quoteText: string,
  webhookUrl: string,
  env: Env,
  quoteDate?: Date,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  uploadedFileId?: string,
  referenceImageUrl?: string,
  secondChild?: ChildInfo,
  secondQuoteText?: string,
  dialogOrder?: 'before' | 'after',
  theme?: string,
  sceneRefFileId?: string,
  extraRefs: { name: string; url: string }[] = [],
): Promise<void> {
  const input = await buildInput(child, quoteText, quoteDate ?? new Date(), allPeople, env, tag, sceneHint, uploadedFileId, referenceImageUrl, secondChild, secondQuoteText, dialogOrder, theme, sceneRefFileId, extraRefs);
  const res = await fetch(
    'https://api.replicate.com/v1/models/openai/gpt-image-1-mini/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, webhook: webhookUrl, webhook_events_filter: ['completed'] }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Replicate budget submit error ${res.status}: ${err}`);
  }
}

// Async submit — worker returns immediately, Replicate POSTs back to webhookUrl when done.
export async function submitQuoteImageAsync(
  child: ChildInfo,
  quoteText: string,
  webhookUrl: string,
  env: Env,
  quoteDate?: Date,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  uploadedFileId?: string,
  referenceImageUrl?: string,
  secondChild?: ChildInfo,
  secondQuoteText?: string,
  dialogOrder?: 'before' | 'after',
  theme?: string,
  sceneRefFileId?: string,
  extraRefs: { name: string; url: string }[] = [],
): Promise<void> {
  const input = await buildInput(child, quoteText, quoteDate ?? new Date(), allPeople, env, tag, sceneHint, uploadedFileId, referenceImageUrl, secondChild, secondQuoteText, dialogOrder, theme, sceneRefFileId, extraRefs);
  const res = await fetch(
    'https://api.replicate.com/v1/models/openai/gpt-image-2/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, webhook: webhookUrl, webhook_events_filter: ['completed'] }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Replicate submit error ${res.status}: ${err}`);
  }
}

// Direct OpenAI call — generates image synchronously, no Replicate proxy needed.
export async function generateQuoteImageDirectly(
  child: ChildInfo,
  quoteText: string,
  env: Env,
  quoteDate: Date,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  uploadedFileId?: string,
  referenceImageUrl?: string,
  theme?: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const input = await buildInput(child, quoteText, quoteDate, allPeople, env, tag, sceneHint, uploadedFileId, referenceImageUrl, undefined, undefined, undefined, theme);
  const prompt = input.prompt as string;
  const refImages = (input.input_images as string[] | undefined) ?? [];

  let b64: string;

  if (refImages.length > 0) {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', '1536x1024');

    for (let i = 0; i < refImages.length; i++) {
      const uri = refImages[i];
      const commaIdx = uri.indexOf(',');
      const ct = uri.slice(5, commaIdx).split(';')[0];
      const bin = atob(uri.slice(commaIdx + 1));
      const buf = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
      form.append('image', new Blob([buf], { type: ct }), `ref${i}.${ct.split('/')[1] || 'jpg'}`);
    }

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI edits ${res.status}: ${await res.text()}`);
    const data = await res.json() as { data: [{ b64_json: string }] };
    b64 = data.data[0].b64_json;
  } else {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1536x1024', quality: 'low' }),
    });
    if (!res.ok) throw new Error(`OpenAI gen ${res.status}: ${await res.text()}`);
    const data = await res.json() as { data: [{ b64_json: string }] };
    b64 = data.data[0].b64_json;
  }

  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes: bytes.buffer, contentType: 'image/png' };
}

// Synchronous (Prefer: wait) — only used by the /rerun endpoint for manual retries.
export async function generateQuoteImage(
  child: ChildInfo,
  quoteText: string,
  env: Env,
  quoteDate?: Date,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  theme?: string,
): Promise<string> {
  const input = await buildInput(child, quoteText, quoteDate ?? new Date(), allPeople, env, tag, sceneHint, undefined, undefined, undefined, undefined, undefined, theme);
  const res = await fetch(
    'https://api.replicate.com/v1/models/openai/gpt-image-2/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Replicate error ${res.status}: ${err}`);
  }
  const data = await res.json() as { output: string | string[]; error?: string };
  if (data.error) throw new Error(`Replicate prediction failed: ${data.error}`);
  const output = data.output;
  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) throw new Error('Replicate returned no image URL');
  return imageUrl;
}

// Resubmit a failed prediction with the exact input Replicate echoed back in the webhook.
// Strips any openai_api_key left over from predictions submitted by older deploys.
export async function resubmitPrediction(
  model: string,
  input: Record<string, unknown>,
  webhookUrl: string,
  env: Env,
): Promise<string> {
  const { openai_api_key: _dropped, ...body } = input;
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: body, webhook: webhookUrl, webhook_events_filter: ['completed'] }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Replicate resubmit error ${res.status}: ${err}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}
