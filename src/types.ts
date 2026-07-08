export interface ChildInfo {
  name: string;
  birthday: [number, number, number] | null; // [year, month, day], or null if unknown
  defaultSceneHint: string;
  photoUrls: string[];
}

export interface LocationEntry {
  city: string;
  lat: number;
  lon: number;
  timezone?: string;
  people: string[];
}

export interface Env {
  QIDQUOTES: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  REPLICATE_API_TOKEN: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string; // full PEM with literal \n between lines
  GOOGLE_PHOTOS_CLIENT_ID: string;
  GOOGLE_PHOTOS_CLIENT_SECRET: string;
  GOOGLE_PHOTOS_REFRESH_TOKEN: string;
  GOOGLE_PHOTOS_ALBUM_ID: string;
  IMGUR_CLIENT_ID?: string;
  OPENAI_API_KEY?: string;
  RERUN_SECRET?: string;
  QIDQUOTES_BASE44_WEBHOOK_URL?: string;
  QIDQUOTES_BASE44_SECRET?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; is_bot: boolean };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
