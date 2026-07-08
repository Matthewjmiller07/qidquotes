# QidQuotes — Telegram Bot for AI-Illustrated Kid Quotes

A serverless Telegram bot that turns kid quotes into watercolor storybook cards with AI-generated illustrations. Built entirely on Cloudflare Workers with no monthly infrastructure costs.

## How It Works

1. **Capture**: Family members type quotes into a Telegram group chat
2. **Generate**: The bot creates a watercolor-style quote card with the child's face and age
3. **Archive**: Images are automatically saved to Google Photos and logged in Google Sheets

## Stack

- **Cloudflare Workers** (TypeScript) — the entire backend
- **Telegram Bot API** — the user interface
- **Replicate → OpenAI `gpt-image-2`** (low quality) — image generation ($0.01 per image)
- **Google Sheets** — database & admin interface
- **Google Photos** — permanent image archive
- **Imgur** — reference photo hosting
- **Google Apps Script** — spreadsheet "Rerun" menu

## Getting Started

### Prerequisites

- A Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g @cloudflare/wrangler`
- Node.js 18+
- A Telegram Bot Token (create via [@BotFather](https://t.me/BotFather))
- A Replicate API token (free at [replicate.com](https://replicate.com))
- Google Cloud project with:
  - Sheets API enabled
  - Photos Library API enabled
  - Service account with appropriate permissions

### Setup

1. **Clone and install**:
   ```bash
   git clone https://github.com/Matthewjmiller07/qidquotes.git
   cd qidquotes
   npm install
   ```

2. **Create a Cloudflare KV namespace**:
   ```bash
   wrangler kv:namespace create "QIDQUOTES"
   ```
   Update the `id` in `wrangler.toml` with the namespace ID returned.

3. **Set Wrangler secrets**:
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put REPLICATE_API_TOKEN
   wrangler secret put GOOGLE_SHEETS_ID
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
   wrangler secret put GOOGLE_PRIVATE_KEY
   wrangler secret put GOOGLE_PHOTOS_CLIENT_ID
   wrangler secret put GOOGLE_PHOTOS_CLIENT_SECRET
   wrangler secret put GOOGLE_PHOTOS_REFRESH_TOKEN
   wrangler secret put GOOGLE_PHOTOS_ALBUM_ID
   ```

   **Note**: For `GOOGLE_PRIVATE_KEY`, paste the full PEM block when prompted. Wrangler stores newlines as `\n` — the worker converts them back.

4. **Deploy**:
   ```bash
   wrangler deploy
   ```

5. **Set the webhook**:
   ```bash
   npm run webhook:set
   ```

6. **Set up the Google Sheet**:
   Create a Google Sheet with two tabs:
   - **Quotes**: `date | time | name | quote | eggcorn | scene_hint | [image URLs]`
   - **Names**: `name | birthday (MM/DD/YYYY) | scene_hint | [photo URLs]`

   Share with your service account email.

7. **(Optional) Add the Rerun menu**:
   In Google Sheets, go to **Extensions → Apps Script** and add the function to call the `/rerun` endpoint with selected rows.

## Data Flow

1. User sends message/quote to Telegram group
2. Worker validates and logs to Google Sheets
3. Worker sends async request to Replicate (OpenAI gpt-image-2)
4. When image completes, Replicate calls worker's callback
5. Worker posts image to Telegram, archives to Google Photos, updates spreadsheet

## Cost

- **Cloudflare Workers**: Free tier covers most usage
- **Image Generation**: ~$0.01 per image via Replicate
- **Everything else**: Free (Telegram, Google APIs within free quotas, Cloudflare KV)

## Development

```bash
# Local development server
npm run dev

# Check webhook status
npm run webhook:info

# Deploy to production
npm deploy
```

## Project Structure

```
src/
├── index.ts          # Worker entry point & HTTP handlers
├── handler.ts        # Main quote processing logic
├── telegram.ts       # Telegram API client
├── sheets.ts         # Google Sheets integration
├── replicate.ts      # Replicate API client
├── photos.ts         # Google Photos integration
├── age.ts            # Age calculation
├── weather.ts        # Weather context (optional)
├── types.ts          # TypeScript interfaces
```

## License

MIT

## See Also

- Live at: [theothermatthewmiller.com/qidquotes](https://theothermatthewmiller.com/qidquotes)
- How it works: [theothermatthewmiller.com/qidquotes-explainer](https://theothermatthewmiller.com)
