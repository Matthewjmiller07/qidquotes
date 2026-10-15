import { handleUpdate, handleRerun, handleRegenBatch, handleArchiveRows, handleReplicateWebhook, handleSyncPeople, handleSubmitQuote } from './handler';
import { handleWeatherWebhook, handleZmanimWebhook } from './weather';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return new Response('OK');

    const url = new URL(request.url);
    const workerOrigin = url.origin;

    if (url.pathname === '/rerun') {
      return handleRerun(request, env);
    }

    if (url.pathname === '/regen') {
      return handleRegenBatch(request, env, workerOrigin);
    }

    if (url.pathname === '/archive') {
      return handleArchiveRows(request, env);
    }

    if (url.pathname === '/submit-quote') {
      return handleSubmitQuote(request, env, workerOrigin);
    }

    if (url.pathname === '/sync-people') {
      return handleSyncPeople(request, env);
    }

    if (url.pathname === '/webhook/weather') {
      let bodyText = '';
      try { bodyText = await request.text(); } catch { return new Response('Bad Request', { status: 400 }); }
      ctx.waitUntil(handleWeatherWebhook(bodyText, env));
      return new Response('OK');
    }

    if (url.pathname === '/webhook/zmanim') {
      let bodyText = '';
      try { bodyText = await request.text(); } catch { return new Response('Bad Request', { status: 400 }); }
      ctx.waitUntil(handleZmanimWebhook(bodyText, env));
      return new Response('OK');
    }

    // Replicate calls this when image generation completes.
    // Read the body synchronously so we can return 200 quickly; process in background.
    if (url.pathname === '/webhook/replicate') {
      let bodyText = '';
      try {
        bodyText = await request.text();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      ctx.waitUntil(handleReplicateWebhook(bodyText, url, env));
      return new Response('OK');
    }

    try {
      const body = await request.json();
      ctx.waitUntil(handleUpdate(body as import('./types').TelegramUpdate, env, workerOrigin));
    } catch {
      // ignore malformed payloads
    }

    return new Response('OK');
  },
};
