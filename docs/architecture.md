# QidQuotes — Architecture & Flow Reference

## Overview

QidQuotes is a Telegram bot that captures quotes from family members, generates AI-illustrated quote cards, and archives everything to Google Sheets and Google Photos. The entire backend is a single **Cloudflare Worker** (free tier) with no database — Google Sheets is the store of record.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, `wrangler`) |
| Bot interface | Telegram Bot API |
| AI image generation | Replicate → OpenAI `gpt-image-2` |
| Primary data store | Google Sheets (Sheets API v4, service account auth) |
| Image archive | Google Photos (OAuth2 refresh token) |
| Reference image hosting | Imgur (anonymous upload via client ID) |
| Sheet-side automation | Google Apps Script (`rerun.gs`) |

---

## Secrets & Configuration

All sensitive values are Wrangler secrets (never in source control). One plain var is in `wrangler.toml`.

| Key | Where | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Wrangler secret | Bot authentication |
| `REPLICATE_API_TOKEN` | Wrangler secret | Image generation |
| `GOOGLE_SHEETS_ID` | Wrangler secret | Spreadsheet ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Wrangler secret | Sheets auth identity |
| `GOOGLE_PRIVATE_KEY` | Wrangler secret | Sheets auth key (full PEM) |
| `GOOGLE_PHOTOS_CLIENT_ID` | Wrangler secret | Photos OAuth client |
| `GOOGLE_PHOTOS_CLIENT_SECRET` | Wrangler secret | Photos OAuth secret |
| `GOOGLE_PHOTOS_REFRESH_TOKEN` | Wrangler secret | Photos long-lived token |
| `GOOGLE_PHOTOS_ALBUM_ID` | Wrangler secret | Target album |
| `IMGUR_CLIENT_ID` | `wrangler.toml` var | Reference image uploads |
| `RERUN_SECRET` | Wrangler secret | Auth for `/rerun` endpoint |

---

## HTTP Endpoints

The worker handles all traffic at `https://qid-quotes.parasha.workers.dev`.

### `POST /` — Telegram webhook
Receives all Telegram updates (messages and button presses). Dispatches to `handleUpdate`.

### `POST /webhook/replicate` — Replicate callback
Called by Replicate when image generation completes. Receives the generated image URL, uploads to Google Photos, sends the image to the Telegram group, and writes the final URL to the Quotes sheet.

### `POST /rerun` — Sheet-triggered bulk rerun
Authenticated with `RERUN_SECRET`. Called from the Google Apps Script menu in the sheet to synchronously regenerate image(s) for selected rows. Writes results to a specified column.

---

## Google Sheets Structure

### Quotes tab

| Col | Field | Notes |
|---|---|---|
| A | Date | `MM/DD/YYYY` (custom) or `DD/MM/YYYY` (auto from Chicago time) |
| B | Time | `HH:MM` Chicago time |
| C | Child name | |
| D | Quote text | Scene hint stripped out |
| E | Eggcorn flag | `yes` or empty |
| F | Scene hint | Text from `(…)` notation, or person's stored default if none given |
| G | Generated image URL | Google Photos URL (or Replicate fallback) — written async |
| H | Reference image URL | Imgur URL of uploaded photo — written async |
| I+ | Regen images | Each regeneration adds one column to the right |

> **Backward compat:** Rows written before the scene-hint column was added have a Google Photos URL in col F. The regen logic detects this (`https://` prefix) and treats F as the image column, G as reference, to stay compatible with old rows.

### Names tab

| Col | Field | Notes |
|---|---|---|
| A | Name | Must match exactly what's typed in quotes |
| B | Birthday | `MM/DD/YYYY`, optional |
| C | Default scene hint | Saved automatically when a quote with `(…)` is logged |
| D+ | Reference photo URLs | Imgur URLs, one per column, appended over time |

> **Backward compat:** Old rows have Imgur photo URLs starting in column C (no scene hint column). Detected by checking if col C starts with `https://`.

---

## Source Files

```
src/
  index.ts      — Worker entry point; routes requests to handlers
  handler.ts    — All message/callback logic; main orchestration
  sheets.ts     — All Google Sheets read/write operations
  replicate.ts  — Image generation (prompt building + Replicate API)
  telegram.ts   — All Telegram API calls (send messages, photos, pickers)
  age.ts        — Age calculation and adult detection
  photos.ts     — Google Photos upload
  types.ts      — Shared TypeScript types (ChildInfo, Env, TelegramUpdate, …)
```

---

## Quote Capture Flows

All flows converge at `processQuote`, which logs the quote and kicks off async image generation.

### Flow A — Pre-tagged message
**Format:** `Name||quote text` or `Name|MM/DD/YYYY|quote text` (optionally with `(scene hint)`)

User sends a message directly with the child's name. The worker finds the name in the Names tab, extracts any scene hint from `(…)`, and skips straight to the eggcorn selector. If the name is unknown but a photo is attached, it's treated as a new adult-like entry.

### Flow B — Plain message (button picker)
User sends a plain quote (no `||`). The worker asks "Who said this?" with one button per person from the Names tab, plus a "✏️ Custom" button (only shown if a photo was attached).

1. **Child button pressed** → date selector
2. **Date selected** (Today / Yesterday / reply with `MM/DD/YYYY`) → eggcorn selector
3. **Eggcorn selected** (Yes / No) → `processQuote`

### Flow C — Custom name (new person)
User presses "✏️ Custom" after attaching a photo:

1. Bot asks: reply with a name → **Flow E**
2. Bot asks: reply with birthday (or "skip") → **Flow F**
   - Person is added to Names tab: `[name, birthday, '']`
3. Continues to date selector → eggcorn selector → `processQuote`
   - `processQuote` uploads photo to Imgur, saves to Quotes col H and Names tab col D

### Flow D — Date text reply
User replies to the date selector message with a custom date (`MM/DD/YYYY`). Parsed and forwarded to the eggcorn selector.

### Flow E — Custom name text reply
User replies to the custom-name prompt message with a name. Forwarded to the birthday prompt.

### Flow F — Birthday text reply
User replies to the birthday prompt with `MM/DD/YYYY` or `skip`. Person added to Names tab. Flow continues to date selector.

### Flow G — Regen reference photo upload
User replies to the "📸 REGEN [ROW]" force-reply prompt with a photo. The photo is used as the reference image for a new generation of that quote row.

---

## processQuote — Core Logic

```
processQuote(child, quoteText, env, workerOrigin, customDate?, allPeople, isEggcorn?, sceneHint?, uploadedFileId?)
```

1. Resolve effective scene hint: `sceneHint || child.defaultSceneHint`
2. If explicit `sceneHint` given: fire-and-forget save to Names tab col C (`updatePersonSceneHint`)
3. Append row to Quotes sheet (cols A–F: date, time, name, quote, eggcorn, sceneHint)
4. If photo uploaded: fetch from Telegram → upload to Imgur → write to Quotes col H → append to Names tab photos
5. Build Replicate webhook URL: `…/webhook/replicate?child=…&quote=…&row=…&col=G`
6. Submit async image generation to Replicate (`gpt-image-2` via `submitQuoteImageAsync`)

---

## Image Generation (replicate.ts → buildInput)

Called with the child's info, quote text, and all people.

1. Determine if sayer is an adult (`isAdult(birthday)`) — null birthday → treated as adult
2. Build reference image list:
   - **Priority 1:** Uploaded Telegram photo (`uploadedFileId`) — fetched as base64 data URI
   - **Priority 2:** Regen reference URL (`referenceImageUrl`) — HTTP URL fetched as base64
   - **Priority 3:** Random photo from Names tab (`child.photoUrls`)
3. Find other people mentioned by name in the quote or scene hint; add their photos as additional references
4. Build prompt: watercolor storybook style, portrait clause, depiction line, scene hint, attribution
   - Adult / unknown birthday: attribution uses the formatted date (e.g. "June 3, 2026")
   - Child with birthday: attribution uses computed age (e.g. "4 years and 2 months old")
5. Submit to Replicate with `webhook` URL; worker returns immediately

---

## Replicate Webhook (handleReplicateWebhook)

Fires when Replicate finishes. URL params carry `row`, `col`, `child`, `quote`, `date`.

1. Parse body; bail on non-success
2. Download generated image bytes
3. Build Telegram caption (with age for children, date for adults/unknown)
4. Send photo to Telegram group with **🔄 Regenerate** inline button (`regen:ROW`)
5. Upload image to Google Photos; fall back to Replicate URL on failure
6. Write final URL to Quotes sheet at `col` (default `G`, or whichever col was specified)

---

## Regeneration Flow

### Step 1 — 🔄 Regenerate button pressed (`regen:ROW`)
1. Read Quotes row to get child name
2. Load child's photo URLs from Names tab
3. Fetch each photo's bytes from Imgur (worker fetches directly; avoids Telegram regional blocks)
4. Send photos as a Telegram media group preview (numbered "📷 Photo 1", "📷 Photo 2" …)
5. Send picker message with buttons: one per photo + **📸 Upload new** + **🎲 Auto**

### Step 2a — Photo button pressed (`regen_pick:ROW:IDX`)
- Looks up `child.photoUrls[idx]` from Names tab
- Calls `triggerRegen` with that URL as the explicit reference image

### Step 2b — Auto (`regen_pick:ROW:auto`)
- Calls `triggerRegen` with no explicit reference
- Falls back to Quotes col H (Imgur reference), then random Names tab photo

### Step 2c — Upload new (`regen_pick:ROW:upload`)
- Sends a force-reply prompt: "📸 REGEN [ROW]"
- User replies with a photo → **Flow G** → `triggerRegen` with uploaded file

### triggerRegen
1. Read Quotes row: detect old vs new column layout (col F URL check)
2. Extract scene hint from col F (new layout) or treat as absent (old layout)
3. Find next empty column after existing image columns
4. Build webhook URL with `col=<nextCol>`
5. Call `submitQuoteImageAsync` — new image arrives via `/webhook/replicate` and lands in that column

---

## Age Display Logic

| Condition | Attribution on image | Telegram caption |
|---|---|---|
| `birthday` is null (unknown) | Date of quote | Name only |
| `isAdult` (≥ 18 years) | Date of quote | Name only |
| Child with birthday | Age in years/months | Name + age |

Age is computed in Chicago timezone against the quote date.

---

## Google Apps Script (rerun.gs)

A menu item added to the Quotes sheet: **QidQuotes → Rerun selected row(s)**.

- Finds the first column that is empty across ALL selected rows (starting at F, now effectively G+ for new rows)
- Calls `POST /rerun` for each selected row with `{ secret, childName, quoteText, date, row, col }`
- The worker generates synchronously (Replicate `Prefer: wait`), uploads to Google Photos, updates the cell
- Shows a progress toast and final summary alert

---

## Data Flow Diagram

```
Telegram message
      │
      ▼
Cloudflare Worker ──── Sheets: load Names tab ────► Names tab
      │                (children + photos + scene hints)
      │
  Flow routing
      │
      ▼
  processQuote
      │
      ├── Sheets: append Quotes row (A–F)
      │
      ├── Imgur: upload reference photo (if any)
      │       └── Sheets: write col H + Names tab photo
      │
      └── Replicate: submit async generation
                │
                ▼  (webhook fires when done)
         handleReplicateWebhook
                │
                ├── Telegram: sendPhoto (with 🔄 button)
                │
                ├── Google Photos: upload
                │
                └── Sheets: write col G (or col specified by regen)
```

---

## Deployment

```bash
npm run deploy        # wrangler deploy — builds + pushes to Cloudflare
npm run dev           # local dev with wrangler dev
npm run webhook:set   # registers Telegram webhook URL with Bot API
npm run webhook:info  # inspect current webhook registration
```

Secrets are set once via `wrangler secret put <KEY>` and never re-deployed.
