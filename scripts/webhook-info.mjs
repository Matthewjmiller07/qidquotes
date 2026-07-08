// Check current webhook status: node scripts/webhook-info.mjs <BOT_TOKEN>

const [botToken] = process.argv.slice(2);

if (!botToken) {
  console.error('Usage: node scripts/webhook-info.mjs <BOT_TOKEN>');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
