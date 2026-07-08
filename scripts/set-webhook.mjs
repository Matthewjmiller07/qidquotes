// Run after deploying: node scripts/set-webhook.mjs <WORKER_URL> <BOT_TOKEN>
// Example:
//   node scripts/set-webhook.mjs https://qid-quotes.your-subdomain.workers.dev 8911549744:AAH...

const [workerUrl, botToken] = process.argv.slice(2);

if (!workerUrl || !botToken) {
  console.error('Usage: node scripts/set-webhook.mjs <WORKER_URL> <BOT_TOKEN>');
  process.exit(1);
}

const res = await fetch(
  `https://api.telegram.org/bot${botToken}/setWebhook`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: workerUrl,
      allowed_updates: ['message', 'callback_query'],
    }),
  },
);

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
