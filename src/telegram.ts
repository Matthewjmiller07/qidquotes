import type { Env } from './types';

const CHAT_ID = -1003932140533;

function api(token: string, method: string) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

// Step 1: ask who said the plain message.
// Names come from the "names" sheet so new children appear automatically.
// Pass uploadedFileId to show a "Custom" button (only for photo+caption messages).
export async function sendChildSelector(childNames: string[], messageId: number, env: Env, uploadedFileId?: string) {
  const buttons = childNames.map((name) => ({ text: name, callback_data: `child:${name}` }));
  // Telegram inline keyboards: up to 8 buttons per row, keep rows of 4 max for readability
  const rows: typeof buttons[] = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  if (uploadedFileId) {
    rows.push([{ text: '✏️ Custom', callback_data: 'child:custom' }]);
  }

  const res = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: '✨ Who said this quote?\n💡 Tip: add (scene description) at the end to guide the illustration — e.g. "I love bears (bears dancing)"',
      reply_to_message_id: messageId,
      ...(rows.length > 0 ? { reply_markup: { inline_keyboard: rows } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`sendChildSelector failed: ${res.status} ${body}`);
  }
}

// Custom name prompt — sent when user taps "✏️ Custom".
// Embeds quote context in the message text so the name reply can parse it.
export async function sendCustomNamePrompt(
  quoteText: string,
  sceneHint: string,
  uploadedFileId: string,
  originalMsgId: number,
  env: Env,
  replyToMessageId: number,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `✏️ CUSTOM [${quoteText}||${sceneHint}||${uploadedFileId}||${originalMsgId}]\nWho said this? Reply with their name:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

export function parseCustomNamePrompt(text: string): { quoteText: string; sceneHint: string; uploadedFileId: string; originalMsgId: number } | null {
  const match = text.match(/^✏️ CUSTOM \[(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)\|\|(\d+)\]/);
  if (!match) return null;
  return { quoteText: match[1], sceneHint: match[2], uploadedFileId: match[3], originalMsgId: parseInt(match[4], 10) };
}

// Birthday prompt — sent after the user provides a custom name.
// Birthday is optional; user can reply "skip".
export async function sendBirthdayPrompt(
  customName: string,
  quoteText: string,
  sceneHint: string,
  uploadedFileId: string,
  originalMsgId: number,
  env: Env,
  replyToMessageId: number,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🎂 BDAY [${customName}|${quoteText}||${sceneHint}||${uploadedFileId}||${originalMsgId}]\nBirthday? Reply with MM/DD/YYYY or "skip":`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

export function parseBirthdayPrompt(text: string): { customName: string; quoteText: string; sceneHint: string; uploadedFileId: string; originalMsgId: number } | null {
  const match = text.match(/^🎂 BDAY \[([^|]+)\|(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)\|\|(\d+)\]/);
  if (!match) return null;
  return { customName: match[1], quoteText: match[2], sceneHint: match[3], uploadedFileId: match[4], originalMsgId: parseInt(match[5], 10) };
}

// Step 2: ask when. Encodes child+quote+sceneHint+uploadedFileId in the message text so date callbacks can parse it.
export async function sendDateSelector(
  childName: string,
  quoteText: string,
  sceneHint: string,
  replyToMessageId: number,
  env: Env,
  uploadedFileId?: string,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `📅 [${childName}|${quoteText}||${sceneHint}||${uploadedFileId ?? ''}]\nWhen was this said? Tap a button, or ↩️ reply to THIS message with mm/dd/yyyy`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Today',      callback_data: 'date:today' },
          { text: '⬅️ Yesterday', callback_data: 'date:yesterday' },
          { text: '📅 Pick date', callback_data: 'date:other' },
        ]],
      },
    }),
  });
}

// ─── Calendar picker ──────────────────────────────────────────────────────────

function buildCalendarKeyboard(year: number, month: number): object[][] {
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);
  const label = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const prevStr = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const nextStr = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;

  const nav = [
    { text: '◀', callback_data: `cal_nav:${prevStr}` },
    { text: label,  callback_data: 'cal_noop' },
    { text: '▶', callback_data: `cal_nav:${nextStr}` },
  ];
  const dayHeaders = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => ({ text: d, callback_data: 'cal_noop' }));

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const blank = { text: ' ', callback_data: 'cal_noop' };

  const rows: object[][] = [nav, dayHeaders];
  let week: object[] = Array(firstDow).fill(blank);
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    week.push({ text: String(d), callback_data: `cal_pick:${mm}/${dd}/${year}` });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(blank);
    rows.push(week);
  }
  return rows;
}

export async function sendCalendarPicker(
  state: { childName: string; quoteText: string; sceneHint: string; uploadedFileId: string },
  replyToMessageId: number,
  env: Env,
) {
  const now = new Date();
  const { childName, quoteText, sceneHint, uploadedFileId } = state;
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `📅 CAL [${childName}|${quoteText}||${sceneHint}||${uploadedFileId}]\nPick a date:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: buildCalendarKeyboard(now.getFullYear(), now.getMonth()) },
    }),
  });
}

export async function editCalendarMonth(messageId: number, year: number, month: number, env: Env) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'editMessageReplyMarkup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: buildCalendarKeyboard(year, month) },
    }),
  });
}

export function parseCalendarMessage(text: string): { childName: string; quoteText: string; sceneHint: string; uploadedFileId: string } | null {
  const m = text.match(/^📅 CAL \[([^|]+)\|(.+?)\|\|([^|\]]*?)(?:\|\|([^\]]*))?\]/);
  if (!m) return null;
  return { childName: m[1], quoteText: m[2], sceneHint: m[3], uploadedFileId: m[4] ?? '' };
}

export function parseDateSelectorMessage(text: string): { childName: string; quoteText: string; sceneHint: string; uploadedFileId: string } | null {
  // Supports both old format (no fileId) and new format (with ||fileId).
  // Non-greedy quoteText prevents empty sceneHint/fileId from being absorbed into the quote.
  const match = text.match(/^📅 \[([^|]+)\|(.+?)\|\|([^|\]]*?)(?:\|\|([^\]]*))?\]/);
  if (!match) return null;
  return { childName: match[1], quoteText: match[2], sceneHint: match[3], uploadedFileId: match[4] ?? '' };
}

// Quote tags: '' (none), 'eggcorn', or 'lie'. Encoded as 'none'/'eggcorn'/'lie' in
// message state; old messages encoded the eggcorn boolean as 'true'/'false'.
export function decodeTag(s: string): string {
  if (s === 'true') return 'eggcorn';
  if (s === 'false' || s === 'none') return '';
  return s;
}

// Step 3: ask whether to tag the quote (eggcorn / lie / neither).
// Encodes child+quote+date+sceneHint+uploadedFileId in the message text.
export async function sendTagSelector(
  childName: string,
  quoteText: string,
  dateStr: string,
  sceneHint: string,
  replyToMessageId: number,
  env: Env,
  uploadedFileId?: string,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🥚 [${childName}|${quoteText}||${dateStr}||${sceneHint}||${uploadedFileId ?? ''}]\nTag this quote?`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '🥚 Eggcorn', callback_data: 'tag:eggcorn' },
          { text: '🤥 Lie',     callback_data: 'tag:lie' },
          { text: '❌ Neither', callback_data: 'tag:none' },
        ]],
      },
    }),
  });
}

export function parseTagSelectorMessage(text: string): { childName: string; quoteText: string; dateStr: string; sceneHint: string; uploadedFileId: string } | null {
  // Supports both old format (no fileId) and new format (with ||fileId).
  // Non-greedy quoteText prevents empty dateStr/sceneHint/fileId from being absorbed into the quote.
  const match = text.match(/^🥚 \[([^|]+)\|(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)(?:\|\|([^\]]*))?\]/);
  if (!match) return null;
  return { childName: match[1], quoteText: match[2], dateStr: match[3], sceneHint: match[4], uploadedFileId: match[5] ?? '' };
}

export async function sendPhotosPreview(
  photos: Array<{ bytes: ArrayBuffer; contentType: string; caption: string }>,
  env: Env,
): Promise<void> {
  if (photos.length === 0) return;
  if (photos.length === 1) {
    const { bytes, contentType, caption } = photos[0];
    await sendPhoto(bytes, contentType, caption, env);
  } else {
    const form = new FormData();
    form.append('chat_id', String(CHAT_ID));
    form.append('media', JSON.stringify(
      photos.map((p, i) => ({ type: 'photo', media: `attach://photo${i}`, caption: p.caption })),
    ));
    for (let i = 0; i < photos.length; i++) {
      const { bytes, contentType } = photos[i];
      const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
      form.append(`photo${i}`, new Blob([bytes], { type: contentType }), `photo${i}.${ext}`);
    }
    const res = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMediaGroup'), {
      method: 'POST',
      body: form,
    });
    if (!res.ok) console.error(`sendPhotosPreview media group failed: ${res.status}`);
  }
}

export async function sendRegenPicker(childName: string, photoCount: number, row: number, env: Env): Promise<void> {
  const photoButtons = Array.from({ length: photoCount }, (_, i) => ({
    text: `📷 Photo ${i + 1}`,
    callback_data: `regen_pick:${row}:${i}`,
  }));
  const actionRow = [
    { text: '📸 Upload new', callback_data: `regen_pick:${row}:upload` },
    { text: '🎲 Auto', callback_data: `regen_pick:${row}:auto` },
  ];
  const keyboard: (typeof photoButtons[0])[][] = [];
  for (let i = 0; i < photoButtons.length; i += 3) keyboard.push(photoButtons.slice(i, i + 3));
  keyboard.push(actionRow);

  const text = photoCount > 0
    ? `🎨 Regenerate *${childName}*'s quote card — choose a reference photo above, or:`
    : `🎨 Regenerate *${childName}*'s quote card — no saved photos yet:`;

  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }),
  });
}

export async function sendRegenThemeSelector(
  row: number,
  choice: string,
  uploadedFileId: string,
  replyToMessageId: number,
  env: Env,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🎨 REGEN THEME [${row}||${choice}||${uploadedFileId}]\nChoose an illustration style:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎨 Watercolor', callback_data: 'theme_regen:watercolor' },
            { text: '💥 Comic',      callback_data: 'theme_regen:comic'      },
            { text: '🌸 Anime',      callback_data: 'theme_regen:anime'      },
          ],
          [
            { text: '✏️ Pencil',     callback_data: 'theme_regen:pencil'     },
            { text: '🎮 Pixel Art',  callback_data: 'theme_regen:pixel'      },
            { text: '📖 Storybook',  callback_data: 'theme_regen:storybook'  },
          ],
        ],
      },
    }),
  });
}

export function parseRegenThemeSelectorMessage(text: string): {
  row: number; choice: string; uploadedFileId: string;
} | null {
  const m = text.match(/^🎨 REGEN THEME \[(\d+)\|\|([^|]*)\|\|([^\]]*)\]/);
  if (!m) return null;
  return { row: parseInt(m[1], 10), choice: m[2], uploadedFileId: m[3] };
}

export async function sendRegenUploadPrompt(row: number, env: Env, replyToMsgId: number): Promise<void> {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `📸 REGEN [${row}]\nReply to this message with a reference photo:`,
      reply_to_message_id: replyToMsgId,
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

export function parseRegenUploadPrompt(text: string): { row: number } | null {
  const match = text.match(/^📸 REGEN \[(\d+)\]/);
  if (!match) return null;
  return { row: parseInt(match[1], 10) };
}

export async function answerCallbackQuery(id: string, text: string, env: Env) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

// Sends image bytes directly via multipart — avoids Telegram trying to fetch a CDN URL.
export async function sendPhoto(
  imageBytes: ArrayBuffer,
  contentType: string,
  caption: string,
  env: Env,
  replyMarkup?: object,
) {
  const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const form = new FormData();
  form.append('chat_id', String(CHAT_ID));
  form.append('caption', caption);
  form.append('photo', new Blob([imageBytes], { type: contentType }), `quote.${ext}`);
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  const res = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendPhoto'), {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendPhoto failed: ${res.status} ${body}`);
  }
}

// ─── Dialog flow (steps 4-7) ──────────────────────────────────────────────────

// Theme selector — final step before generation.
export async function sendThemeSelector(
  state: {
    childName: string; quoteText: string; dateStr: string; sceneHint: string;
    tag: string; uploadedFileId: string;
    secondChildName?: string; secondQuoteText?: string; dialogOrder?: string;
  },
  replyToMessageId: number,
  env: Env,
) {
  const {
    childName, quoteText, dateStr, sceneHint, tag, uploadedFileId,
    secondChildName = '', secondQuoteText = '', dialogOrder = '',
  } = state;
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🎨 THEME [${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}||${secondChildName}||${secondQuoteText}||${dialogOrder}]\nChoose an illustration style:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎨 Watercolor', callback_data: 'theme:watercolor' },
            { text: '💥 Comic',      callback_data: 'theme:comic'      },
            { text: '🌸 Anime',      callback_data: 'theme:anime'      },
          ],
          [
            { text: '✏️ Pencil',     callback_data: 'theme:pencil'     },
            { text: '🎮 Pixel Art',  callback_data: 'theme:pixel'      },
            { text: '📖 Storybook',  callback_data: 'theme:storybook'  },
          ],
        ],
      },
    }),
  });
}

export function parseThemeSelectorMessage(text: string): {
  childName: string; quoteText: string; dateStr: string; sceneHint: string;
  tag: string; uploadedFileId: string;
  secondChildName: string; secondQuoteText: string; dialogOrder: string;
} | null {
  const m = text.match(/^🎨 THEME \[([^|]+)\|(.+?)\|\|([^|]*)\|\|([^|]*)\|\|(eggcorn|lie|none|true|false)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^\]]*)\]/);
  if (!m) return null;
  return {
    childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4],
    tag: decodeTag(m[5]), uploadedFileId: m[6],
    secondChildName: m[7], secondQuoteText: m[8], dialogOrder: m[9],
  };
}

interface ThemedState {
  childName: string; quoteText: string; dateStr: string; sceneHint: string;
  tag: string; uploadedFileId: string;
  secondChildName?: string; secondQuoteText?: string; dialogOrder?: string;
  theme: string;
}

function encodeThemedState(state: ThemedState): string {
  const {
    childName, quoteText, dateStr, sceneHint, tag, uploadedFileId,
    secondChildName = '', secondQuoteText = '', dialogOrder = '', theme,
  } = state;
  return `${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}||${secondChildName}||${secondQuoteText}||${dialogOrder}||${theme}`;
}

// Step: after a theme is chosen, offer an optional scene reference image. The user replies
// to this message with a photo (handled in handleMessage) or taps Skip.
export async function sendSceneRefSelector(state: ThemedState, replyToMessageId: number, env: Env) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🖼️ SCENE REF [${encodeThemedState(state)}]\nWant an image to inspire the scene (setting, objects, mood)? ↩️ Reply to THIS message with a photo — people will still look like their own photos. Or skip:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'sceneref:skip' }]] },
    }),
  });
}

export function parseSceneRefSelectorMessage(text: string): (ThemedState & {
  secondChildName: string; secondQuoteText: string; dialogOrder: string;
}) | null {
  const m = text.match(/^🖼️ SCENE REF \[([^|]+)\|(.+?)\|\|([^|]*)\|\|([^|]*)\|\|(eggcorn|lie|none|true|false)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^\]]*)\]/);
  if (!m) return null;
  return {
    childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4],
    tag: decodeTag(m[5]), uploadedFileId: m[6],
    secondChildName: m[7], secondQuoteText: m[8], dialogOrder: m[9], theme: m[10],
  };
}

// Step: ask which engine to render with — final step before generation.
// sceneRefFileId is the optional scene-inspiration photo from the previous step.
export async function sendModelSelector(
  state: ThemedState & { sceneRefFileId?: string },
  replyToMessageId: number,
  env: Env,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🤖 MODEL [${encodeThemedState(state)}||${state.sceneRefFileId ?? ''}]\nChoose quality:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '✨ Premium', callback_data: 'model:gpt' },
          { text: '⚡ Budget',  callback_data: 'model:flux' },
        ]],
      },
    }),
  });
}

export function parseModelSelectorMessage(text: string): {
  childName: string; quoteText: string; dateStr: string; sceneHint: string;
  tag: string; uploadedFileId: string;
  secondChildName: string; secondQuoteText: string; dialogOrder: string; theme: string;
  sceneRefFileId: string;
} | null {
  // Trailing sceneRefFileId is optional so buttons on messages sent before it existed still work.
  const m = text.match(/^🤖 MODEL \[([^|]+)\|(.+?)\|\|([^|]*)\|\|([^|]*)\|\|(eggcorn|lie|none|true|false)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|]*)\|\|([^|\]]*)(?:\|\|([^\]]*))?\]/);
  if (!m) return null;
  return {
    childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4],
    tag: decodeTag(m[5]), uploadedFileId: m[6],
    secondChildName: m[7], secondQuoteText: m[8], dialogOrder: m[9], theme: m[10],
    sceneRefFileId: m[11] ?? '',
  };
}

// Regen equivalent of sendModelSelector — asked after a regen theme is chosen.
// `ref` carries the already-resolved reference photo, prefixed 'up:<fileId>' or
// 'url:<photoUrl>', or '' for auto.
export async function sendRegenModelSelector(
  row: number,
  theme: string,
  ref: string,
  replyToMessageId: number,
  env: Env,
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `🤖 REGEN MODEL [${row}||${theme}||${ref}]\nChoose quality:`,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '✨ Premium', callback_data: 'regen_model:gpt' },
          { text: '⚡ Budget',  callback_data: 'regen_model:flux' },
        ]],
      },
    }),
  });
}

export function parseRegenModelSelectorMessage(text: string): {
  row: number; theme: string; ref: string;
} | null {
  const m = text.match(/^🤖 REGEN MODEL \[(\d+)\|\|([^|]*)\|\|([^\]]*)\]/);
  if (!m) return null;
  return { row: parseInt(m[1], 10), theme: m[2], ref: m[3] };
}

// Step 4: after tagging, ask if user wants to add a second quote.
export async function sendDialogSelector(
  childName: string, quoteText: string, dateStr: string, sceneHint: string,
  tag: string, replyToMessageId: number, env: Env, uploadedFileId = '',
) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `💬 [${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}]\nAdd another quote to make this a dialog?`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: [[
        { text: '💬 Add quote', callback_data: 'dialog:add' },
        { text: '🎨 Just generate', callback_data: 'dialog:solo' },
      ]] },
    }),
  });
}

export function parseDialogSelectorMessage(text: string): {
  childName: string; quoteText: string; dateStr: string;
  sceneHint: string; tag: string; uploadedFileId: string;
} | null {
  const m = text.match(/^💬 \[([^|]+)\|(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)\|\|(eggcorn|lie|none|true|false)\|\|([^\]]*)\]/);
  if (!m) return null;
  return { childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4], tag: decodeTag(m[5]), uploadedFileId: m[6] };
}

// Step 5: child selector for the second speaker. Uses same 💬 prefix so parseDialogSelectorMessage works.
export async function sendDialogChildSelector(
  childNames: string[],
  primaryState: { childName: string; quoteText: string; dateStr: string; sceneHint: string; tag: string; uploadedFileId: string },
  replyToMessageId: number,
  env: Env,
) {
  const { childName, quoteText, dateStr, sceneHint, tag, uploadedFileId } = primaryState;
  const buttons = childNames
    .filter(n => n !== childName)
    .map(n => ({ text: n, callback_data: `dialog_child:${n}` }));
  const rows: typeof buttons[] = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `💬 [${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}]\nWho said the other quote?`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: rows },
    }),
  });
}

// Step 6: prompt for the second quote text.
export async function sendDialogQuotePrompt(
  state: { childName: string; quoteText: string; dateStr: string; sceneHint: string; tag: string; uploadedFileId: string },
  secondChildName: string, replyToMessageId: number, env: Env,
) {
  const { childName, quoteText, dateStr, sceneHint, tag, uploadedFileId } = state;
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `✏️ DIALOG QUOTE [${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}||${secondChildName}]\nWhat did ${secondChildName} say?`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

export function parseDialogQuotePrompt(text: string): {
  childName: string; quoteText: string; dateStr: string; sceneHint: string;
  tag: string; uploadedFileId: string; secondChildName: string;
} | null {
  const m = text.match(/^✏️ DIALOG QUOTE \[([^|]+)\|(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)\|\|(eggcorn|lie|none|true|false)\|\|([^\]]*?)\|\|([^\]]+)\]/);
  if (!m) return null;
  return { childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4], tag: decodeTag(m[5]), uploadedFileId: m[6], secondChildName: m[7] };
}

// Step 7: ask whether the second quote came before or after the first.
export async function sendDialogOrderSelector(
  state: { childName: string; quoteText: string; dateStr: string; sceneHint: string; tag: string; uploadedFileId: string },
  secondChildName: string, secondQuoteText: string, replyToMessageId: number, env: Env,
) {
  const { childName, quoteText, dateStr, sceneHint, tag, uploadedFileId } = state;
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `⏱️ DIALOG ORDER [${childName}|${quoteText}||${dateStr}||${sceneHint}||${tag || 'none'}||${uploadedFileId}||${secondChildName}||${secondQuoteText}]\nDid ${secondChildName} say this before or after ${childName}?`,
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: [[
        { text: '⬅️ Before', callback_data: 'dialog_order:before' },
        { text: '➡️ After',  callback_data: 'dialog_order:after'  },
      ]] },
    }),
  });
}

export function parseDialogOrderMessage(text: string): {
  childName: string; quoteText: string; dateStr: string; sceneHint: string;
  tag: string; uploadedFileId: string; secondChildName: string; secondQuoteText: string;
} | null {
  const m = text.match(/^⏱️ DIALOG ORDER \[([^|]+)\|(.+?)\|\|([^|\]]*?)\|\|([^|\]]*?)\|\|(eggcorn|lie|none|true|false)\|\|([^\]]*?)\|\|([^|\]]+)\|\|(.+?)\]/);
  if (!m) return null;
  return { childName: m[1], quoteText: m[2], dateStr: m[3], sceneHint: m[4], tag: decodeTag(m[5]), uploadedFileId: m[6], secondChildName: m[7], secondQuoteText: m[8] };
}

export async function sendMessage(text: string, env: Env, replyToMessageId?: number, replyMarkup?: object) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}
