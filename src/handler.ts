import { appendQuote, updateQuoteImage, loadChildren, addNameToSheet, addPhotoToNamesTab, readQuoteRow, updatePersonSceneHint } from './sheets';
import { submitQuoteImageAsync, submitBudgetQuoteImageAsync, generateQuoteImage, resubmitPrediction } from './replicate';
import { uploadToGooglePhotos } from './photos';
import { getAge, isAdult } from './age';
import {
  sendFamilyWeather,
  sendFamilyZmanim,
  handleWeatherStyleCallback,
  handleWeatherLabelsCallback,
  handleZmanimStyleCallback,
  handleZmanimLabelsCallback,
  handleMoveCommand,
  handleWeatherLocationsCommand,
} from './weather';
import {
  sendChildSelector,
  sendDateSelector,
  parseDateSelectorMessage,
  sendTagSelector,
  parseTagSelectorMessage,
  sendCalendarPicker,
  editCalendarMonth,
  parseCalendarMessage,
  sendDialogSelector,
  parseDialogSelectorMessage,
  sendDialogChildSelector,
  sendDialogQuotePrompt,
  parseDialogQuotePrompt,
  sendDialogOrderSelector,
  parseDialogOrderMessage,
  sendThemeSelector,
  parseThemeSelectorMessage,
  sendSceneRefSelector,
  parseSceneRefSelectorMessage,
  sendSceneRefStrengthSelector,
  parseSceneRefStrengthMessage,
  sendModelSelector,
  parseModelSelectorMessage,
  sendRegenThemeSelector,
  parseRegenThemeSelectorMessage,
  sendRegenModelSelector,
  parseRegenModelSelectorMessage,
  sendCustomNamePrompt,
  parseCustomNamePrompt,
  sendBirthdayPrompt,
  parseBirthdayPrompt,
  sendPhotosPreview,
  sendRegenPicker,
  sendRegenUploadPrompt,
  parseRegenUploadPrompt,
  answerCallbackQuery,
  sendPhoto,
  sendMessage,
} from './telegram';
import type { Env, ChildInfo, TelegramUpdate } from './types';

const CHAT_ID = -1003932140533;

export async function handleUpdate(update: TelegramUpdate, env: Env, workerOrigin: string) {
  const children = await loadChildren(env).catch((err) => {
    console.error('Failed to load children from sheets:', err);
    return [] as ChildInfo[];
  });

  try {
    if (update.message) {
      await handleMessage(update.message, env, children);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, children, workerOrigin);
    }
  } catch (err) {
    console.error('handleUpdate error:', err);
  }
}

// ─── Incoming messages ────────────────────────────────────────────────────────

async function handleMessage(
  message: NonNullable<TelegramUpdate['message']>,
  env: Env,
  children: ChildInfo[],
) {
  if (message.from?.is_bot) return;
  if (message.chat.id !== CHAT_ID) return;

  // Support photos with captions (caption plays the role of text)
  const text = (message.text ?? message.caption ?? '').trim();

  // Largest photo size has the best quality; used as uploaded reference image
  const uploadedFileId = message.photo?.length
    ? message.photo[message.photo.length - 1].file_id
    : '';
  const repliedText = message.reply_to_message?.text ?? '';

  // ── Photo replies — usually sent without a caption, so handled before the text check ──
  // Flow G: regen reference photo upload reply
  if (repliedText.startsWith('📸 REGEN [') && uploadedFileId) {
    const parsed = parseRegenUploadPrompt(repliedText);
    if (!parsed) return;
    await sendRegenThemeSelector(parsed.row, 'uploaded', uploadedFileId, message.message_id, env);
    return;
  }
  // Flow I: scene reference photo reply — inspires the scene, not the people
  if (repliedText.startsWith('🖼️ SCENE REF [') && uploadedFileId) {
    const parsed = parseSceneRefSelectorMessage(repliedText);
    if (!parsed) return;
    await sendSceneRefStrengthSelector({ ...parsed, sceneRefFileId: uploadedFileId }, message.message_id, env);
    return;
  }

  if (!text) return;

  // Weather + zmanim commands
  if (text === '/weather' || text.startsWith('/weather@')) {
    await sendFamilyWeather(env);
    return;
  }
  if (text === '/zmanim' || text.startsWith('/zmanim@')) {
    await sendFamilyZmanim(env);
    return;
  }
  if (text === '/weather-locations' || text.startsWith('/weather-locations@')) {
    await handleWeatherLocationsCommand(env);
    return;
  }
  if (text.startsWith('/move ')) {
    await handleMoveCommand(text, env);
    return;
  }

  // ── Flow A: pre-tagged  Aviya||quote  or  Aviya|dd/mm/yyyy|quote ──────────
  if (text.includes('||')) {
    const pipeIdx = text.indexOf('||');
    const rawChild = text.slice(0, pipeIdx).trim();

    let childName = rawChild;
    let customDate: string | undefined;
    if (rawChild.includes('|')) {
      const parts = rawChild.split('|');
      childName = parts[0].trim();
      customDate = parts[1].trim();
    }

    const rawQuote = text.slice(pipeIdx + 2).trim();
    const { quote: quoteText, sceneHint } = extractSceneHint(rawQuote);
    let child = children.find((c) => c.name === childName);
    if (!child) {
      if (!uploadedFileId) {
        const known = children.map((c) => c.name).join(', ');
        await sendMessage(`❓ Unknown name "${childName}". Known names: ${known || '(none loaded)'}`, env, message.message_id);
        return;
      }
      // Custom name with uploaded photo — treat as adult with no sheet photos
      child = { name: childName, birthday: null, defaultSceneHint: '', photoUrls: [] };
    }

    await sendTagSelector(childName, quoteText, customDate ?? '', sceneHint, message.message_id, env, uploadedFileId);
    return;
  }

  // ── Flow D: date reply ───────────────────────────────────────────────────
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text) && repliedText.startsWith('📅 [')) {
    const parsed = parseDateSelectorMessage(repliedText);
    if (!parsed) return;
    const child = children.find((c) => c.name === parsed.childName);
    if (!child) return;

    await sendTagSelector(parsed.childName, parsed.quoteText, text, parsed.sceneHint, message.message_id, env, parsed.uploadedFileId);
    return;
  }

  // ── Flow H: dialog second quote reply ────────────────────────────────────
  if (repliedText.startsWith('✏️ DIALOG QUOTE [')) {
    const parsed = parseDialogQuotePrompt(repliedText);
    if (!parsed || !text) return;
    await sendDialogOrderSelector(parsed, parsed.secondChildName, text.trim(), message.message_id, env);
    return;
  }

  // ── Flow E: custom name reply ─────────────────────────────────────────────
  if (repliedText.startsWith('✏️ CUSTOM [')) {
    const parsed = parseCustomNamePrompt(repliedText);
    if (!parsed || !text) return;
    await sendBirthdayPrompt(text, parsed.quoteText, parsed.sceneHint, parsed.uploadedFileId, parsed.originalMsgId, env, message.message_id);
    return;
  }

  // ── Flow F: birthday reply ────────────────────────────────────────────────
  if (repliedText.startsWith('🎂 BDAY [')) {
    const parsed = parseBirthdayPrompt(repliedText);
    if (!parsed) return;
    const birthday = text.toLowerCase() === 'skip' ? '' : text;

    try {
      await addNameToSheet(parsed.customName, birthday, env);
    } catch (err) {
      console.error('addNameToSheet error:', err);
    }
    await sendDateSelector(parsed.customName, parsed.quoteText, parsed.sceneHint, parsed.originalMsgId, env, parsed.uploadedFileId);
    return;
  }

  // ── Flow B: plain message — ask who said it ───────────────────────────────
  await sendChildSelector(children.map((c) => c.name), message.message_id, env, uploadedFileId);
}

// ─── Callback queries (button presses) ───────────────────────────────────────

async function handleCallbackQuery(
  cb: NonNullable<TelegramUpdate['callback_query']>,
  env: Env,
  children: ChildInfo[],
  workerOrigin: string,
) {
  const data = cb.data ?? '';

  if (data === 'child:custom') {
    const replyMsg = cb.message?.reply_to_message;
    const rawQuote = (replyMsg?.text ?? replyMsg?.caption ?? '').trim();
    if (!rawQuote) return;
    const { quote: quoteText, sceneHint } = extractSceneHint(rawQuote);
    const uploadedFileId = replyMsg?.photo?.length
      ? replyMsg.photo[replyMsg.photo.length - 1].file_id
      : '';
    const originalMsgId = replyMsg?.message_id ?? 0;
    await answerCallbackQuery(cb.id, '✏️ Reply with a name!', env);
    await sendCustomNamePrompt(quoteText, sceneHint, uploadedFileId, originalMsgId, env, originalMsgId);
    return;
  }

  if (data.startsWith('child:')) {
    const childName = data.replace('child:', '').trim();
    const child = children.find((c) => c.name === childName);
    if (!child) {
      await answerCallbackQuery(cb.id, `❓ Unknown child "${childName}"`, env);
      return;
    }

    await answerCallbackQuery(cb.id, `${childName} selected!`, env);

    const replyMsg = cb.message?.reply_to_message;
    const rawQuote = (replyMsg?.text ?? replyMsg?.caption ?? '').trim();
    if (!rawQuote) return;
    const { quote: quoteText, sceneHint } = extractSceneHint(rawQuote);

    const originalMsgId = replyMsg?.message_id;
    if (!originalMsgId) return;

    // Carry forward any photo the user attached to the original message
    const uploadedFileId = replyMsg?.photo?.length
      ? replyMsg.photo[replyMsg.photo.length - 1].file_id
      : '';

    await sendDateSelector(childName, quoteText, sceneHint, originalMsgId, env, uploadedFileId);
    return;
  }

  if (data.startsWith('date:')) {
    const msgText = cb.message?.text ?? '';
    const parsed = parseDateSelectorMessage(msgText);
    if (!parsed) return;

    if (data === 'date:other') {
      const msgId = cb.message?.message_id;
      if (!msgId) return;
      await answerCallbackQuery(cb.id, '📅 Pick a date', env);
      await sendCalendarPicker(parsed, msgId, env);
      return;
    }

    const child = children.find((c) => c.name === parsed.childName);
    if (!child) return;

    let dateStr = '';
    if (data === 'date:yesterday') {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      const pad = (n: number) => String(n).padStart(2, '0');
      dateStr = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
    }

    const tagMsgId = cb.message?.message_id;
    if (!tagMsgId) return;
    await answerCallbackQuery(cb.id, '🥚 One more question!', env);
    await sendTagSelector(parsed.childName, parsed.quoteText, dateStr, parsed.sceneHint, tagMsgId, env, parsed.uploadedFileId);
    return;
  }

  if (data === 'cal_noop') {
    await answerCallbackQuery(cb.id, '', env);
    return;
  }

  if (data.startsWith('cal_nav:')) {
    const [yearStr, monthStr] = data.replace('cal_nav:', '').split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1; // 0-based
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, '', env);
    await editCalendarMonth(msgId, year, month, env);
    return;
  }

  if (data.startsWith('cal_pick:')) {
    const dateStr = data.replace('cal_pick:', ''); // MM/DD/YYYY
    const msgText = cb.message?.text ?? '';
    const parsed = parseCalendarMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, `📅 ${dateStr}`, env);
    await sendTagSelector(parsed.childName, parsed.quoteText, dateStr, parsed.sceneHint, msgId, env, parsed.uploadedFileId);
    return;
  }

  if (data.startsWith('regen:')) {
    const row = parseInt(data.replace('regen:', ''), 10);
    if (!row) return;

    await answerCallbackQuery(cb.id, '🎨 Choose a reference...', env);

    let childName = '';
    try {
      const rowData = await readQuoteRow(row, env);
      childName = rowData[2]?.trim() ?? '';
    } catch (err) {
      console.error('regen picker: readQuoteRow error:', err);
    }
    if (!childName) {
      await sendMessage('⚠️ Could not load quote for regeneration.', env);
      return;
    }

    const child = children.find((c) => c.name === childName);
    const photoUrls = child?.photoUrls ?? [];

    if (photoUrls.length > 0) {
      const photos: Array<{ bytes: ArrayBuffer; contentType: string; caption: string }> = [];
      for (let i = 0; i < photoUrls.length; i++) {
        try {
          const { bytes, contentType } = await fetchImageBytes(photoUrls[i]);
          photos.push({ bytes, contentType, caption: `📷 Photo ${i + 1}` });
        } catch (err) {
          console.error(`regen picker: could not fetch photo ${i + 1}:`, err);
        }
      }
      if (photos.length > 0) {
        await sendPhotosPreview(photos, env).catch(
          (err) => console.error('sendPhotosPreview error:', err),
        );
      }
    }
    await sendRegenPicker(childName, photoUrls.length, row, env);
    return;
  }

  if (data.startsWith('regen_pick:')) {
    const parts = data.split(':');
    const row = parseInt(parts[1], 10);
    const choice = parts[2];
    if (!row || !choice) return;
    const msgId = cb.message?.message_id ?? 0;

    if (choice === 'upload') {
      await answerCallbackQuery(cb.id, '📸 Reply with a photo!', env);
      await sendRegenUploadPrompt(row, env, msgId);
      return;
    }

    await answerCallbackQuery(cb.id, '🎨 Pick a style!', env);
    await sendRegenThemeSelector(row, choice, '', msgId, env);
    return;
  }

  // 'tag:' is the current callback; 'eggcorn:' handles buttons on messages sent before the tag selector existed.
  if (data.startsWith('tag:') || data.startsWith('eggcorn:')) {
    const msgText = cb.message?.text ?? '';
    const parsed = parseTagSelectorMessage(msgText);
    if (!parsed) return;
    const tagMsgId = cb.message?.message_id;
    if (!tagMsgId) return;
    const tag = data === 'tag:eggcorn' || data === 'eggcorn:yes' ? 'eggcorn'
      : data === 'tag:lie' ? 'lie'
      : '';
    await answerCallbackQuery(cb.id, '✅ Got it!', env);
    await sendDialogSelector(parsed.childName, parsed.quoteText, parsed.dateStr, parsed.sceneHint, tag, tagMsgId, env, parsed.uploadedFileId);
    return;
  }

  // ── Dialog: solo (skip adding second quote) → pick a theme ───────────────
  if (data === 'dialog:solo') {
    const msgText = cb.message?.text ?? '';
    const parsed = parseDialogSelectorMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, '🎨 Pick a style!', env);
    await sendThemeSelector(parsed, msgId, env);
    return;
  }

  // ── Dialog: add second quote ──────────────────────────────────────────────
  if (data === 'dialog:add') {
    const msgText = cb.message?.text ?? '';
    const parsed = parseDialogSelectorMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, '💬 Who said the other quote?', env);
    await sendDialogChildSelector(children.map(c => c.name), parsed, msgId, env);
    return;
  }

  // ── Dialog: second child selected ────────────────────────────────────────
  if (data.startsWith('dialog_child:')) {
    const secondChildName = data.replace('dialog_child:', '').trim();
    const msgText = cb.message?.text ?? '';
    const parsed = parseDialogSelectorMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, `${secondChildName} selected!`, env);
    await sendDialogQuotePrompt(parsed, secondChildName, msgId, env);
    return;
  }

  // ── Dialog: before/after order selected → pick a theme ──────────────────
  if (data.startsWith('dialog_order:')) {
    const order = data.replace('dialog_order:', '') as 'before' | 'after';
    const msgText = cb.message?.text ?? '';
    const parsed = parseDialogOrderMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, '🎨 Pick a style!', env);
    await sendThemeSelector({
      ...parsed,
      secondChildName: parsed.secondChildName,
      secondQuoteText: parsed.secondQuoteText,
      dialogOrder: order,
    }, msgId, env);
    return;
  }

  // ── Weather: style picker → label picker → generate ──────────────────────
  if (data.startsWith('weather_style:')) {
    const style = data.replace('weather_style:', '');
    await handleWeatherStyleCallback(style, cb.id, env);
    return;
  }

  if (data.startsWith('weather_labels:')) {
    const labelPeople = data === 'weather_labels:yes';
    const msgText = cb.message?.text ?? '';
    await handleWeatherLabelsCallback(labelPeople, msgText, cb.id, env, workerOrigin);
    return;
  }

  // ── Zmanim: style picker → label picker → generate ────────────────────────
  if (data.startsWith('zmanim_style:')) {
    const style = data.replace('zmanim_style:', '');
    await handleZmanimStyleCallback(style, cb.id, env);
    return;
  }

  if (data.startsWith('zmanim_labels:')) {
    const labelPeople = data === 'zmanim_labels:yes';
    const msgText = cb.message?.text ?? '';
    await handleZmanimLabelsCallback(labelPeople, msgText, cb.id, env, workerOrigin);
    return;
  }

  // ── Regen: theme selected → resolve ref, then ask which engine to use ────
  if (data.startsWith('theme_regen:')) {
    const theme = data.replace('theme_regen:', '');
    const msgText = cb.message?.text ?? '';
    const parsed = parseRegenThemeSelectorMessage(msgText);
    if (!parsed) return;

    const themeLabels: Record<string, string> = {
      watercolor: '🎨 Watercolor', comic: '💥 Comic', anime: '🌸 Anime',
      pencil: '✏️ Pencil', pixel: '🎮 Pixel Art', storybook: '📖 Storybook',
    };
    const themeLabel = themeLabels[theme] ?? theme;

    let ref = '';
    if (parsed.choice === 'uploaded') {
      ref = parsed.uploadedFileId ? `up:${parsed.uploadedFileId}` : '';
    } else if (parsed.choice !== 'auto') {
      const idx = parseInt(parsed.choice, 10);
      const rowData = await readQuoteRow(parsed.row, env).catch(() => [] as string[]);
      const childName = rowData[2]?.trim() ?? '';
      const child = children.find((c) => c.name === childName);
      const url = child?.photoUrls[idx];
      if (!url) {
        await sendMessage('⚠️ Could not find that photo. Try a different option.', env);
        return;
      }
      ref = `url:${url}`;
    }

    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, `${themeLabel} — choose quality...`, env);
    await sendRegenModelSelector(parsed.row, theme, ref, msgId, env);
    return;
  }

  // ── Regen: engine selected → regenerate ──────────────────────────────────
  if (data.startsWith('regen_model:')) {
    const model = data.replace('regen_model:', '') as 'gpt' | 'flux';
    const msgText = cb.message?.text ?? '';
    const parsed = parseRegenModelSelectorMessage(msgText);
    if (!parsed) return;

    const modelLabel = model === 'flux' ? '⚡ Budget' : '✨ Premium';
    await answerCallbackQuery(cb.id, `${modelLabel} — regenerating...`, env);

    let uploadedFileId: string | undefined;
    let refImageUrl: string | undefined;
    if (parsed.ref.startsWith('up:')) uploadedFileId = parsed.ref.slice(3);
    else if (parsed.ref.startsWith('url:')) refImageUrl = parsed.ref.slice(4);

    await triggerRegen(parsed.row, env, children, workerOrigin, uploadedFileId, refImageUrl, parsed.theme, model);
    return;
  }

  // ── Theme selected → offer an optional scene reference image ─────────────
  if (data.startsWith('theme:')) {
    const theme = data.replace('theme:', '');
    const msgText = cb.message?.text ?? '';
    const parsed = parseThemeSelectorMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;

    const themeLabels: Record<string, string> = {
      watercolor: '🎨 Watercolor', comic: '💥 Comic', anime: '🌸 Anime',
      pencil: '✏️ Pencil', pixel: '🎮 Pixel Art', storybook: '📖 Storybook',
    };
    const themeLabel = themeLabels[theme] ?? theme;
    await answerCallbackQuery(cb.id, `${themeLabel} selected!`, env);
    await sendSceneRefSelector({ ...parsed, theme }, msgId, env);
    return;
  }

  // ── Scene reference strength chosen → ask which engine to use ───────────
  if (data.startsWith('sceneref_strength:')) {
    const strength = data === 'sceneref_strength:exact' ? 'exact' : 'loose';
    const msgText = cb.message?.text ?? '';
    const parsed = parseSceneRefStrengthMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, strength === 'exact' ? '🏠 Matching closely' : '✨ Loose inspiration', env);
    await sendModelSelector({ ...parsed, sceneRefFileId: `${strength}:${parsed.sceneRefFileId}` }, msgId, env);
    return;
  }

  // ── Scene reference skipped → ask which engine to use ────────────────────
  if (data === 'sceneref:skip') {
    const msgText = cb.message?.text ?? '';
    const parsed = parseSceneRefSelectorMessage(msgText);
    if (!parsed) return;
    const msgId = cb.message?.message_id;
    if (!msgId) return;
    await answerCallbackQuery(cb.id, '⏭️ No scene image', env);
    await sendModelSelector(parsed, msgId, env);
    return;
  }

  // ── Engine selected → generate ────────────────────────────────────────────
  if (data.startsWith('model:')) {
    const model = data.replace('model:', '') as 'gpt' | 'flux';
    const msgText = cb.message?.text ?? '';
    const parsed = parseModelSelectorMessage(msgText);
    if (!parsed) return;

    const themeLabels: Record<string, string> = {
      watercolor: '🎨 Watercolor', comic: '💥 Comic', anime: '🌸 Anime',
      pencil: '✏️ Pencil', pixel: '🎮 Pixel Art', storybook: '📖 Storybook',
    };
    const themeLabel = themeLabels[parsed.theme] ?? parsed.theme;
    const modelLabel = model === 'flux' ? '⚡ Budget' : '✨ Premium';

    if (parsed.secondChildName) {
      const child = children.find(c => c.name === parsed.childName)
        ?? { name: parsed.childName, birthday: null, defaultSceneHint: '', photoUrls: [] };
      const secondChild = children.find(c => c.name === parsed.secondChildName)
        ?? { name: parsed.secondChildName, birthday: null, defaultSceneHint: '', photoUrls: [] };
      await answerCallbackQuery(cb.id, `${modelLabel} — generating dialog card!`, env);
      await sendMessage(`✅ Generating dialog card for ${parsed.childName} & ${parsed.secondChildName} (${themeLabel}, ${modelLabel})...`, env);
      await processDialogQuote(child, parsed.quoteText, secondChild, parsed.secondQuoteText, parsed.dialogOrder as 'before' | 'after', env, workerOrigin, parsed.dateStr || undefined, children, parsed.tag, parsed.sceneHint || undefined, parsed.uploadedFileId, parsed.theme, model, parsed.sceneRefFileId || undefined);
    } else {
      const child: ChildInfo = children.find(c => c.name === parsed.childName)
        ?? (parsed.uploadedFileId ? { name: parsed.childName, birthday: null, defaultSceneHint: '', photoUrls: [] } : null as never);
      if (!child) return;
      await answerCallbackQuery(cb.id, `${modelLabel} selected!`, env);
      await sendMessage(`✅ Generating ${parsed.childName}'s quote card (${themeLabel}, ${modelLabel})...`, env);
      await processQuote(child, parsed.quoteText, env, workerOrigin, parsed.dateStr || undefined, children, parsed.tag, parsed.sceneHint || undefined, parsed.uploadedFileId, parsed.theme, model, parsed.sceneRefFileId || undefined);
    }
    return;
  }
}

// ─── Imgur helpers ────────────────────────────────────────────────────────────

async function fetchTelegramPhotoBytes(fileId: string, env: Env): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json() as { ok: boolean; result?: { file_path?: string } };
  if (!data.ok || !data.result?.file_path) throw new Error(`getFile failed for fileId ${fileId}`);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Photo fetch failed: ${imgRes.status}`);
  const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const bytes = await imgRes.arrayBuffer();
  return { bytes, contentType };
}

async function uploadToImgur(bytes: ArrayBuffer, contentType: string, clientId: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: contentType }));
  const res = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: { Authorization: `Client-ID ${clientId}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Imgur upload failed: ${res.status}`);
  const data = await res.json() as { data: { link: string } };
  return data.data.link;
}

// Upload by URL — lets Imgur fetch from the source CDN, avoiding CF IP blocks.
async function uploadUrlToImgur(sourceUrl: string, clientId: string): Promise<string> {
  const res = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: {
      Authorization: `Client-ID ${clientId}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ image: sourceUrl, type: 'url' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Imgur URL upload failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { data: { link: string } };
  return data.data.link;
}

// ─── Regen: re-run image generation for an existing quote row ────────────────

async function triggerRegen(
  row: number,
  env: Env,
  children: ChildInfo[],
  workerOrigin: string,
  uploadedFileId?: string,
  referenceImageUrl?: string,
  theme?: string,
  model: 'gpt' | 'flux' = 'gpt',
): Promise<void> {
  let rowData: string[];
  try {
    rowData = await readQuoteRow(row, env);
  } catch (err) {
    console.error('triggerRegen readQuoteRow error:', err);
    await sendMessage('⚠️ Could not read quote data for regeneration.', env);
    return;
  }

  const childName = rowData[2]?.trim();
  const quoteText = rowData[3]?.trim();
  if (!childName || !quoteText) {
    await sendMessage('⚠️ Could not parse quote data for regeneration.', env);
    return;
  }

  // Col E holds the tag — 'eggcorn'/'lie' in new rows, 'yes' (meaning eggcorn) in old rows.
  const tagRaw = rowData[4]?.trim().toLowerCase() ?? '';
  const tag = tagRaw === 'yes' ? 'eggcorn' : tagRaw === 'eggcorn' || tagRaw === 'lie' ? tagRaw : '';

  // Col F is scene hint in new rows; in old rows F held the generated image URL.
  const colF = rowData[5]?.trim() ?? '';
  const isOldLayout = colF.startsWith('https://');
  const sceneHint = isOldLayout ? '' : colF;

  // Reference image: col H in new layout, col G in old layout
  const refCol = isOldLayout ? 6 : 7;
  const regenRef = referenceImageUrl ?? (rowData[refCol]?.trim() || undefined);

  // Image columns start at G (index 6) in new layout, F (index 5) in old layout
  const imageStartIdx = isOldLayout ? 5 : 6;
  let lastFilledIdx = imageStartIdx - 1;
  for (let i = imageStartIdx; i < rowData.length; i++) {
    if (rowData[i]?.trim()) lastFilledIdx = i;
  }
  const nextColIdx = Math.max(imageStartIdx, lastFilledIdx + 1);
  const nextCol = String.fromCharCode(65 + nextColIdx);

  const child = children.find((c) => c.name === childName) ?? { name: childName, birthday: null, defaultSceneHint: '', photoUrls: [] };

  const params = new URLSearchParams({ child: childName, quote: quoteText, row: String(row), col: nextCol, model });
  const webhookUrl = `${workerOrigin}/webhook/replicate?${params}`;

  await sendMessage(`🔄 Regenerating ${childName}'s quote card...`, env);

  try {
    if (model === 'flux') {
      await submitBudgetQuoteImageAsync(child, quoteText, webhookUrl, env, new Date(), children, tag, sceneHint || undefined, uploadedFileId, regenRef, undefined, undefined, undefined, theme);
    } else {
      await submitQuoteImageAsync(child, quoteText, webhookUrl, env, new Date(), children, tag, sceneHint || undefined, uploadedFileId, regenRef, undefined, undefined, undefined, theme);
    }
  } catch (err) {
    console.error('triggerRegen submit error:', err);
    await sendMessage('⚠️ Failed to start regeneration. Check Replicate credits.', env);
  }
}

// ─── Shared: log quote immediately, then kick off async image generation ─────

function extractSceneHint(text: string): { quote: string; sceneHint: string } {
  const match = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { quote: text, sceneHint: '' };
  return { quote: match[1].trim(), sceneHint: match[2].trim() };
}

function parseDDMMYYYY(s: string): Date {
  const [mm, dd, yyyy] = s.split('/').map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

async function processQuote(
  child: ChildInfo,
  quoteText: string,
  env: Env,
  workerOrigin: string,
  customDate?: string,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  uploadedFileId?: string,
  theme?: string,
  model: 'gpt' | 'flux' = 'gpt',
  sceneRefFileId?: string,
) {
  const quoteDate = customDate ? parseDDMMYYYY(customDate) : new Date();
  void quoteDate; // used below via customDate string

  const effectiveSceneHint = sceneHint || child.defaultSceneHint || undefined;

  if (sceneHint) {
    updatePersonSceneHint(child.name, sceneHint, env).catch(
      (err) => console.error('updatePersonSceneHint error:', err),
    );
  }

  let row = 0;
  try {
    row = await appendQuote(child.name, quoteText, '', env, customDate, tag, effectiveSceneHint);
  } catch (err) {
    console.error('Sheets append error:', err);
    await sendMessage(`⚠️ Failed to save quote to sheet. Please try again.`, env);
  }

  let referenceImgurUrl: string | undefined;
  if (uploadedFileId && env.IMGUR_CLIENT_ID && row > 0) {
    try {
      const { bytes, contentType } = await fetchTelegramPhotoBytes(uploadedFileId, env);
      referenceImgurUrl = await uploadToImgur(bytes, contentType, env.IMGUR_CLIENT_ID);
      await updateQuoteImage(row, 'H', referenceImgurUrl, env);
      if (!allPeople.some(p => p.name === child.name)) {
        await addNameToSheet(child.name, '', env).catch(err => console.error('addNameToSheet error:', err));
      }
      await addPhotoToNamesTab(child.name, referenceImgurUrl, env);
    } catch (err) {
      console.error('Imgur ref image upload error:', err);
    }
  }

  const params = new URLSearchParams({ child: child.name, quote: quoteText, row: String(row), col: 'G', model, src: 'api' });
  if (customDate) params.set('date', customDate);
  if (tag) params.set('tag', tag);
  if (effectiveSceneHint) params.set('sceneHint', effectiveSceneHint);
  if (referenceImgurUrl) params.set('referenceUrl', referenceImgurUrl);
  const webhookUrl = `${workerOrigin}/webhook/replicate?${params}`;

  try {
    if (model === 'flux') {
      await submitBudgetQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, allPeople, tag, effectiveSceneHint, uploadedFileId, undefined, undefined, undefined, undefined, theme, sceneRefFileId);
    } else {
      await submitQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, allPeople, tag, effectiveSceneHint, uploadedFileId, undefined, undefined, undefined, undefined, theme, sceneRefFileId);
    }
  } catch (err) {
    console.error('Image generation submit error:', err);
    await sendMessage(`⚠️ Quote saved but image generation failed to start. Check Replicate credits.`, env);
  }
}

// ─── Dialog: save both quotes, submit one combined image to Replicate ────────

async function processDialogQuote(
  child: ChildInfo,
  quoteText: string,
  secondChild: ChildInfo,
  secondQuoteText: string,
  dialogOrder: 'before' | 'after',
  env: Env,
  workerOrigin: string,
  customDate?: string,
  allPeople: ChildInfo[] = [],
  tag?: string,
  sceneHint?: string,
  uploadedFileId?: string,
  theme?: string,
  model: 'gpt' | 'flux' = 'gpt',
  sceneRefFileId?: string,
) {
  const quoteDate = customDate ? parseDDMMYYYY(customDate) : new Date();
  const effectiveSceneHint = sceneHint || child.defaultSceneHint || undefined;

  let row1 = 0, row2 = 0;
  try {
    row1 = await appendQuote(child.name, quoteText, '', env, customDate, tag, effectiveSceneHint);
  } catch (err) {
    console.error('Dialog Sheets append row1 error:', err);
    await sendMessage(`⚠️ Failed to save ${child.name}'s quote to sheet.`, env);
    return;
  }
  try {
    row2 = await appendQuote(secondChild.name, secondQuoteText, '', env, customDate, '', effectiveSceneHint);
  } catch (err) {
    console.error('Dialog Sheets append row2 error:', err);
  }

  let referenceImgurUrl: string | undefined;
  if (uploadedFileId && env.IMGUR_CLIENT_ID && row1 > 0) {
    try {
      const { bytes, contentType } = await fetchTelegramPhotoBytes(uploadedFileId, env);
      referenceImgurUrl = await uploadToImgur(bytes, contentType, env.IMGUR_CLIENT_ID);
      await updateQuoteImage(row1, 'H', referenceImgurUrl, env);
      // Create Names tab row first if this is a new person, so the photo saves correctly
      if (!allPeople.some(p => p.name === child.name)) {
        await addNameToSheet(child.name, '', env).catch(err => console.error('Dialog addNameToSheet error:', err));
      }
      await addPhotoToNamesTab(child.name, referenceImgurUrl, env);
    } catch (err) {
      console.error('Dialog Imgur ref upload error:', err);
    }
  }

  const params = new URLSearchParams({
    child: child.name, quote: quoteText, row: String(row1), col: 'G',
    child2: secondChild.name, quote2: secondQuoteText, row2: String(row2), col2: 'G',
    dialogOrder, model,
  });
  if (customDate) params.set('date', customDate);
  if (tag) params.set('tag', tag);
  if (effectiveSceneHint) params.set('sceneHint', effectiveSceneHint);
  if (referenceImgurUrl) params.set('referenceUrl', referenceImgurUrl);

  const webhookUrl = `${workerOrigin}/webhook/replicate?${params}`;
  try {
    if (model === 'flux') {
      await submitBudgetQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, allPeople, tag, effectiveSceneHint, uploadedFileId, undefined, secondChild, secondQuoteText, dialogOrder, theme, sceneRefFileId);
    } else {
      await submitQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, allPeople, tag, effectiveSceneHint, uploadedFileId, undefined, secondChild, secondQuoteText, dialogOrder, theme, sceneRefFileId);
    }
  } catch (err) {
    console.error('Dialog image generation submit error:', err);
    await sendMessage(`⚠️ Dialog quotes saved but image generation failed to start.`, env);
  }
}

// ─── Replicate webhook — called by Replicate when image generation completes ──

const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_DELAY_MS = 15_000;

export async function handleReplicateWebhook(bodyText: string, url: URL, env: Env): Promise<void> {
  const row = parseInt(url.searchParams.get('row') ?? '0', 10);
  const childName = url.searchParams.get('child') ?? '';
  const quoteText = url.searchParams.get('quote') ?? '';
  const dateStr = url.searchParams.get('date') ?? undefined;
  const col = url.searchParams.get('col') ?? 'F';
  // 'tag' is the current param; 'isEggcorn' covers webhooks registered before the tag change.
  const tag = url.searchParams.get('tag')
    ?? (url.searchParams.get('isEggcorn') === 'true' ? 'eggcorn' : '');
  const sceneHint = url.searchParams.get('sceneHint') ?? '';
  const referenceUrl = url.searchParams.get('referenceUrl') ?? '';
  const src = url.searchParams.get('src') ?? '';
  // Dialog params (only present for dialog cards)
  const child2Name = url.searchParams.get('child2') ?? '';
  const quote2Text = url.searchParams.get('quote2') ?? '';
  const row2 = parseInt(url.searchParams.get('row2') ?? '0', 10);
  const col2 = url.searchParams.get('col2') ?? 'G';
  const dialogOrder = (url.searchParams.get('dialogOrder') ?? '') as 'before' | 'after' | '';

  let body: { id?: string; status: string; output: string | string[] | null; error?: string; model?: string; input?: Record<string, unknown>; metrics?: { predict_time?: number } };
  try {
    body = JSON.parse(bodyText);
  } catch {
    console.error('Replicate webhook: failed to parse body');
    return;
  }

  const attempt = parseInt(url.searchParams.get('attempt') ?? '0', 10);
  console.log('Replicate webhook', JSON.stringify({
    id: body.id, model: body.model, status: body.status, attempt,
    predictTime: body.metrics?.predict_time, error: body.error, child: childName, row,
  }));

  if (body.status !== 'succeeded' || !body.output) {
    // Capacity errors (E003 "high demand" etc.) — resubmit the same input after a pause.
    const transient = /E003|high demand|unavailable|try again later/i.test(body.error ?? '');
    if (transient && attempt < MAX_TRANSIENT_RETRIES && body.input && body.model) {
      const nextAttempt = attempt + 1;
      const retryUrl = new URL(url);
      retryUrl.searchParams.set('attempt', String(nextAttempt));
      try {
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
        const newId = await resubmitPrediction(body.model, body.input, retryUrl.toString(), env);
        console.log(`Replicate webhook: retry ${nextAttempt} submitted as ${newId} on ${body.model}`);
        return;
      } catch (err) {
        console.error('Replicate webhook: retry submit failed', err);
      }
    }

    const errDetail = (body.error ? ` — ${body.error}` : '') +
      ` [${body.id ?? '?'}, attempt ${attempt}]`;
    const regenMarkup = row > 0
      ? { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `regen:${row}` }]] }
      : undefined;
    await sendMessage(
      `⚠️ Image generation failed for ${childName}'s quote "${quoteText}"${errDetail}`,
      env,
      undefined,
      regenMarkup,
    ).catch(() => {});
    return;
  }

  const rawOutput = body.output;
  const replicateUrl = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;
  if (!replicateUrl) {
    console.error('Replicate webhook: empty output');
    return;
  }

  // Download image (handles both HTTPS URLs and data URIs)
  let imageBytes: ArrayBuffer;
  let imageContentType = 'image/png';
  try {
    const result = await fetchImageBytes(replicateUrl);
    imageBytes = result.bytes;
    imageContentType = result.contentType;
  } catch (err) {
    console.error('Webhook image download error:', err);
    return;
  }

  // Build caption — load children to get birthday for age/adult check
  const children = await loadChildren(env).catch(() => [] as ChildInfo[]);
  const child = children.find((c) => c.name === childName);
  const child2 = child2Name ? children.find((c) => c.name === child2Name) : undefined;
  const quoteDate = dateStr ? parseDDMMYYYY(dateStr) : new Date();
  const adultSayer = !child || isAdult(child.birthday);

  const caption = child2Name && quote2Text
    ? `💬 "${dialogOrder === 'before' ? quote2Text : quoteText}" — ${dialogOrder === 'before' ? child2Name : childName} / "${dialogOrder === 'before' ? quoteText : quote2Text}" — ${dialogOrder === 'before' ? childName : child2Name}`
    : adultSayer
      ? `✨ "${quoteText}" — ${childName}`
      : `✨ "${quoteText}" — ${childName} (${getAge(child!.birthday, quoteDate)})`;

  // Send image to Telegram group with a regen button when we have a row to write back to
  const regenMarkup = row > 0
    ? { inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regen:${row}` }]] }
    : undefined;
  await sendPhoto(imageBytes, imageContentType, caption, env, regenMarkup).catch(
    (err) => console.error('Webhook Telegram sendPhoto error:', err),
  );

  // Upload to Imgur for Base44 (Photos URLs require auth and can't be used as <img> src)
  // and as a permanent fallback in case Google Photos fails.
  // Use byte-based upload (not URL-based) so WebP is accepted.
  let imgurUrl: string | null = null;
  if (env.IMGUR_CLIENT_ID) {
    try {
      imgurUrl = await uploadToImgur(imageBytes, imageContentType, env.IMGUR_CLIENT_ID);
    } catch (err) {
      console.error('Webhook Imgur upload error:', err);
    }
  }

  // Upload to Google Photos for permanent archive; fall back to Imgur so the sheet
  // never stores an expiring Replicate URL.
  let finalUrl = imgurUrl ?? replicateUrl;
  try {
    finalUrl = await uploadToGooglePhotos(imageBytes, imageContentType, caption, env);
  } catch (err) {
    console.error('Webhook Google Photos upload error:', err);
  }

  // Update both sheet rows with the image URL
  if (row > 0) {
    await updateQuoteImage(row, col, finalUrl, env).catch(
      (err) => console.error('Webhook sheet update error:', err),
    );
    // API submissions (/submit-quote): also store the public Imgur copy of the
    // card in the next column — Photos URLs need a Google login, Imgur doesn't.
    // (Telegram-flow rows keep H for the reference image; API rows never use it.)
    if (src === 'api' && imgurUrl && imgurUrl !== finalUrl) {
      const nextCol = String.fromCharCode(col.charCodeAt(0) + 1);
      await updateQuoteImage(row, nextCol, imgurUrl, env).catch(
        (err) => console.error('Webhook sheet Imgur update error:', err),
      );
    }
  }
  if (row2 > 0) {
    await updateQuoteImage(row2, col2, finalUrl, env).catch(
      (err) => console.error('Webhook sheet update row2 error:', err),
    );
  }

  // Notify Base44 app with the completed quote data
  if (env.QIDQUOTES_BASE44_WEBHOOK_URL && env.QIDQUOTES_BASE44_SECRET) {
    const base44ImageUrl = imgurUrl ?? replicateUrl;

    try {
      const b44Res = await fetch(env.QIDQUOTES_BASE44_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: env.QIDQUOTES_BASE44_SECRET,
          childName,
          quoteText,
          date: dateStr || null,
          isEggcorn: tag === 'eggcorn',
          tag: tag || null,
          sceneHint: sceneHint || null,
          illustrationUrl: base44ImageUrl,
          referencePhotoUrl: referenceUrl || null,
          allReferencePhotoUrls: child?.photoUrls ?? [],
          capturedBy: 'Telegram Bot',
        }),
      });
      if (!b44Res.ok) {
        const errBody = await b44Res.text().catch(() => '');
        console.error(`Base44 webhook failed ${b44Res.status}:`, errBody);
      } else {
        console.log('Base44 webhook ok:', await b44Res.text().catch(() => ''));
      }

      // For dialog cards, also create a Base44 record for the second person
      if (child2Name && quote2Text) {
        fetch(env.QIDQUOTES_BASE44_WEBHOOK_URL!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: env.QIDQUOTES_BASE44_SECRET,
            childName: child2Name,
            quoteText: quote2Text,
            date: dateStr || null,
            isEggcorn: false,
            tag: null,
            sceneHint: sceneHint || null,
            illustrationUrl: base44ImageUrl,
            referencePhotoUrl: null,
            allReferencePhotoUrls: child2?.photoUrls ?? [],
            capturedBy: 'Telegram Bot',
          }),
        }).catch((err) => console.error('Base44 dialog second quote error:', err));
      }
    } catch (err) {
      console.error('Base44 webhook error:', err);
    }
  }
}

async function fetchImageBytes(source: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  if (source.startsWith('data:')) {
    const commaIdx = source.indexOf(',');
    const header = source.slice(5, commaIdx); // e.g. "image/png;base64"
    const contentType = header.split(';')[0];
    const b64 = source.slice(commaIdx + 1);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes: bytes.buffer, contentType };
  }
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') ?? 'image/png';
  return { bytes, contentType };
}

// ─── /regen — batch-regenerate sheet rows through the normal async webhook flow ──
// Same as tapping 🔄 Regenerate with default reference/theme; cards post to Telegram.

export async function handleRegenBatch(request: Request, env: Env, workerOrigin: string): Promise<Response> {
  const json = await request.json() as { secret?: string; rows?: number[]; model?: 'gpt' | 'flux' };
  if (!env.RERUN_SECRET || json.secret !== env.RERUN_SECRET) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const rows = (json.rows ?? []).filter((r) => Number.isInteger(r) && r > 1);
  if (rows.length === 0) {
    return Response.json({ ok: false, error: 'No rows' }, { status: 400 });
  }
  const children = await loadChildren(env);
  for (const row of rows) {
    await triggerRegen(row, env, children, workerOrigin, undefined, undefined, undefined, json.model ?? 'gpt');
  }
  return Response.json({ ok: true, submitted: rows });
}

// ─── /submit-quote — programmatic quote submission (no Telegram needed) ──────
// Appends a new Quotes row, then runs the normal async generation flow: the
// existing /webhook/replicate completion handler posts the card to Telegram,
// archives it to Google Photos, and writes the image URL into the sheet.
// Body: { secret, childName, quoteText, date? (dd/mm/yyyy), tag?, sceneHint?,
//         refImageUrl?, refImageBase64?, theme?, model? ('gpt' | 'flux') }
// The reference image overrides the child's default sheet photos for this card.

async function uploadBase64ToImgur(base64: string, clientId: string): Promise<string> {
  const res = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: {
      Authorization: `Client-ID ${clientId}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ image: base64, type: 'base64' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Imgur base64 upload failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { data: { link: string } };
  return data.data.link;
}

export async function handleSubmitQuote(request: Request, env: Env, workerOrigin: string): Promise<Response> {
  const json = await request.json() as {
    secret?: string;
    childName?: string;
    quoteText?: string;
    date?: string; // dd/mm/yyyy
    tag?: string; // 'eggcorn' | 'lie' | ''
    sceneHint?: string;
    refImageUrl?: string;
    refImageBase64?: string;
    sceneRefImageUrl?: string;
    sceneRefImageBase64?: string;
    sceneRefStrength?: 'exact' | 'loose';
    theme?: string;
    model?: 'gpt' | 'flux';
  };
  const headerSecret = request.headers.get('X-Rerun-Secret') ?? '';
  if (!env.RERUN_SECRET || (json.secret !== env.RERUN_SECRET && headerSecret !== env.RERUN_SECRET)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { childName, quoteText } = json;
  if (!childName || !quoteText) {
    return Response.json({ ok: false, error: 'Missing childName or quoteText' }, { status: 400 });
  }
  const tag = json.tag ?? '';
  const sceneHint = json.sceneHint ?? '';
  const theme = json.theme;
  const model = json.model ?? 'gpt';

  let children: ChildInfo[];
  try {
    children = await loadChildren(env);
  } catch (err) {
    return Response.json({ ok: false, error: 'Failed to load children from sheets' }, { status: 500 });
  }
  const child = children.find((c) => c.name === childName);
  if (!child) {
    return Response.json({ ok: false, error: `Unknown child: ${childName}` }, { status: 400 });
  }

  // Resolve the reference image: explicit URL wins; base64 gets hosted on Imgur
  // (server-side, using the worker's IMGUR_CLIENT_ID) so generation can fetch it.
  let refImageUrl = (json.refImageUrl ?? '').trim() || undefined;
  if (!refImageUrl && json.refImageBase64) {
    if (!env.IMGUR_CLIENT_ID) {
      return Response.json({ ok: false, error: 'refImageBase64 needs IMGUR_CLIENT_ID' }, { status: 400 });
    }
    try {
      refImageUrl = await uploadBase64ToImgur(json.refImageBase64, env.IMGUR_CLIENT_ID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: `Reference image upload failed: ${msg}` }, { status: 502 });
    }
  }
  if (refImageUrl) {
    await addPhotoToNamesTab(childName, refImageUrl, env).catch((err) =>
      console.error('submit-quote addPhotoToNamesTab error:', err),
    );
  }

  // Optional scene reference (background inspiration, like the Telegram flow's
  // scene ref): base64 gets hosted on Imgur; passed as "<strength>:<url>".
  let sceneRef: string | undefined;
  {
    let sceneRefUrl = (json.sceneRefImageUrl ?? '').trim() || undefined;
    if (!sceneRefUrl && json.sceneRefImageBase64) {
      if (!env.IMGUR_CLIENT_ID) {
        return Response.json({ ok: false, error: 'sceneRefImageBase64 needs IMGUR_CLIENT_ID' }, { status: 400 });
      }
      try {
        sceneRefUrl = await uploadBase64ToImgur(json.sceneRefImageBase64, env.IMGUR_CLIENT_ID);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ ok: false, error: `Scene ref image upload failed: ${msg}` }, { status: 502 });
      }
    }
    if (sceneRefUrl) {
      const strength = json.sceneRefStrength === 'exact' ? 'exact' : 'loose';
      sceneRef = `${strength}:${sceneRefUrl}`;
    }
  }

  // 1. New sheet row (images start at col G in the new layout).
  let row: number;
  try {
    row = await appendQuote(childName, quoteText, '', env, json.date, tag, sceneHint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: `Sheets append failed: ${msg}` }, { status: 502 });
  }
  if (!row) {
    return Response.json({ ok: false, error: 'Sheets append returned no row' }, { status: 502 });
  }

  // 2. Fire the normal async generation flow (same params as triggerRegen).
  const quoteDate = json.date ? parseDDMMYYYY(json.date) : new Date();
  const params = new URLSearchParams({
    child: childName,
    quote: quoteText,
    row: String(row),
    col: 'G',
    model,
    date: json.date ?? '',
    tag,
    sceneHint,
    referenceUrl: refImageUrl ?? '',
  });
  const webhookUrl = `${workerOrigin}/webhook/replicate?${params}`;

  await sendMessage(`🎨 Generating ${childName}'s quote card...`, env).catch(() => {});
  try {
    if (model === 'flux') {
      await submitBudgetQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, children, tag, sceneHint || undefined, undefined, refImageUrl, undefined, undefined, undefined, theme, sceneRef);
    } else {
      await submitQuoteImageAsync(child, quoteText, webhookUrl, env, quoteDate, children, tag, sceneHint || undefined, undefined, refImageUrl, undefined, undefined, undefined, theme, sceneRef);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: `Replicate submit failed: ${msg}`, row }, { status: 502 });
  }

  return Response.json({ ok: true, row, refImageUrl: refImageUrl ?? null });
}

// ─── /quote-status — poll a Quotes row for its generated card image ─────────
// Lets an API client fetch the finished card without Telegram/Sheets access.
// GET /quote-status?row=465 — auth via X-Rerun-Secret header or ?secret=.
// Response: { ok, row, child, quote, status: 'pending'|'done', cardUrl, images[] }
// cardUrl is the public Imgur copy when the row came from /submit-quote
// (Photos URLs need a Google login); images lists every image cell, Imgur first.

export async function handleQuoteStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secret = request.headers.get('X-Rerun-Secret') ?? url.searchParams.get('secret') ?? '';
  if (!env.RERUN_SECRET || secret !== env.RERUN_SECRET) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const row = parseInt(url.searchParams.get('row') ?? '0', 10);
  if (!Number.isInteger(row) || row < 2) {
    return Response.json({ ok: false, error: 'Missing row' }, { status: 400 });
  }

  let rowData: string[];
  try {
    rowData = await readQuoteRow(row, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: `Sheets read failed: ${msg}` }, { status: 502 });
  }

  // New layout: image columns start at G (index 6). Imgur URLs on API rows are
  // the public generated-card copies (the webhook stores one next to the Photos
  // URL); list them first so clients grab the login-free one.
  const allImages = rowData
    .slice(6)
    .map((s) => (s ?? '').trim())
    .filter((s) => s.startsWith('https://'));
  const images = [
    ...allImages.filter((s) => s.includes('imgur.com')),
    ...allImages.filter((s) => !s.includes('imgur.com')),
  ];
  const cardUrl = images[0] ?? null;

  return Response.json({
    ok: true,
    row,
    child: rowData[2]?.trim() ?? '',
    quote: rowData[3]?.trim() ?? '',
    status: cardUrl ? 'done' : 'pending',
    cardUrl,
    images,
  });
}

// ─── /archive — move expiring Replicate URLs in a row into Google Photos ──────
// For cards whose Photos upload failed (e.g. 429) and got a replicate.delivery URL
// written to the sheet instead; those links die after about an hour.

export async function handleArchiveRows(request: Request, env: Env): Promise<Response> {
  const json = await request.json() as { secret?: string; rows?: number[] };
  if (!env.RERUN_SECRET || json.secret !== env.RERUN_SECRET) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const results: Record<number, string> = {};
  for (const row of json.rows ?? []) {
    try {
      const rowData = await readQuoteRow(row, env);
      // Newest image is the rightmost; older columns may hold long-dead Replicate links.
      let idx = -1;
      rowData.forEach((v, i) => { if (v?.includes('replicate.delivery')) idx = i; });
      if (idx < 0) { results[row] = 'no replicate URL'; continue; }
      const { bytes, contentType } = await fetchImageBytes(rowData[idx].trim());
      const caption = `✨ "${rowData[3]?.trim() ?? ''}" — ${rowData[2]?.trim() ?? ''}`;
      const photosUrl = await uploadToGooglePhotos(bytes, contentType, caption, env);
      await updateQuoteImage(row, String.fromCharCode(65 + idx), photosUrl, env);
      results[row] = 'archived';
    } catch (err) {
      results[row] = err instanceof Error ? err.message : String(err);
    }
  }
  return Response.json({ ok: true, results });
}

// ─── /rerun endpoint — called from Google Sheets Apps Script ─────────────────

export async function handleRerun(request: Request, env: Env): Promise<Response> {
  const json = await request.json() as {
    secret?: string;
    childName?: string;
    quoteText?: string;
    date?: string;
    row?: number;
    col?: string;
    isEggcorn?: boolean;
    tag?: string;
    sceneHint?: string;
  };

  if (!env.RERUN_SECRET || json.secret !== env.RERUN_SECRET) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { childName, quoteText, date, row, col = 'F', sceneHint } = json;
  const tag = json.tag ?? (json.isEggcorn ? 'eggcorn' : '');
  if (!childName || !quoteText || !row) {
    return Response.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
  }

  let children: ChildInfo[];
  try {
    children = await loadChildren(env);
  } catch (err) {
    return Response.json({ ok: false, error: 'Failed to load children from sheets' }, { status: 500 });
  }

  const child = children.find((c) => c.name === childName);
  if (!child) {
    return Response.json({ ok: false, error: `Unknown child: ${childName}` }, { status: 400 });
  }

  try {
    const quoteDate = date ? parseDDMMYYYY(date) : new Date();
    const replicateUrl = await generateQuoteImage(child, quoteText, env, quoteDate, children, tag, sceneHint);

    const { bytes: imageBytes, contentType } = await fetchImageBytes(replicateUrl);
    const age = getAge(child.birthday, quoteDate);
    const caption = `✨ "${quoteText}" — ${child.name} (${age})`;

    // Imgur as permanent fallback; Google Photos as primary archive.
    let finalUrl = replicateUrl;
    if (env.IMGUR_CLIENT_ID) {
      try {
        finalUrl = await uploadUrlToImgur(replicateUrl, env.IMGUR_CLIENT_ID);
      } catch (err) {
        console.error('Rerun Imgur upload error:', err);
      }
    }
    try {
      finalUrl = await uploadToGooglePhotos(imageBytes, contentType, caption, env);
    } catch (err) {
      console.error('Rerun Google Photos upload error:', err);
    }

    await updateQuoteImage(row, col, finalUrl, env);
    return Response.json({ ok: true, imageUrl: finalUrl, col });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Rerun error:', err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── /sync-people — push all Sheets people+photos to Base44 ──────────────────

export async function handleSyncPeople(request: Request, env: Env): Promise<Response> {
  const json = await request.json() as { secret?: string };
  if (!env.RERUN_SECRET || json.secret !== env.RERUN_SECRET) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!env.QIDQUOTES_BASE44_WEBHOOK_URL || !env.QIDQUOTES_BASE44_SECRET) {
    return Response.json({ ok: false, error: 'Base44 not configured' }, { status: 500 });
  }

  let children: ChildInfo[];
  try {
    children = await loadChildren(env);
  } catch (err) {
    return Response.json({ ok: false, error: 'Failed to load children' }, { status: 500 });
  }

  const base44Origin = new URL(env.QIDQUOTES_BASE44_WEBHOOK_URL).origin;
  const syncUrl = `${base44Origin}/functions/syncPeople`;

  try {
    const res = await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.QIDQUOTES_BASE44_SECRET,
        people: children.map(c => ({
          name: c.name,
          referencePhotoUrls: c.photoUrls,
        })),
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) return Response.json({ ok: false, error: `Base44 sync failed ${res.status}: ${body}` }, { status: 500 });
    return Response.json({ ok: true, count: children.length, result: body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
