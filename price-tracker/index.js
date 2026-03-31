const express = require('express');
const cron = require('node-cron');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

// ── Firebase Init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Telegram Bot ──
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// ── Express health check ──
const app = express();
const PORT = process.env.PORT || 3001;
app.get('/', (req, res) => res.json({ service: 'price-tracker', status: 'running', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Price Tracker running on port ${PORT}`));

// ── User Agent rotation ──
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── Scrape price from URL ──
async function scrapePrice(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA() },
      timeout: 15000,
    });
    const $ = cheerio.load(data);

    // Shopee
    if (url.includes('shopee')) {
      // Shopee uses dynamic rendering, price might not be in static HTML
      // For production: use Shopee API instead of scraping
      const priceText = $('[class*="price"]').first().text().replace(/[^\d]/g, '');
      return priceText ? parseInt(priceText) : null;
    }
    // Lazada
    if (url.includes('lazada')) {
      const priceText = $('[class*="price"]').first().text().replace(/[^\d]/g, '');
      return priceText ? parseInt(priceText) : null;
    }
    return null;
  } catch (err) {
    console.error(`Scrape error for ${url}:`, err.message);
    return null;
  }
}

// ── Send price alert via Telegram ──
async function sendPriceAlert(chatId, data) {
  const direction = data.change > 0 ? '🔴 TĂNG' : '🟢 GIẢM';
  const msg = [
    `${direction} GIÁ!`,
    `📦 ${data.productName}`,
    `💰 ${data.oldPrice.toLocaleString()}đ → *${data.newPrice.toLocaleString()}đ*`,
    `📊 Thay đổi: ${data.change > 0 ? '+' : ''}${data.changePercent}%`,
    `🔗 [Xem SP](${data.url})`,
  ].join('\n');
  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    console.error(`Telegram alert error:`, err.message);
  }
}

// ── Main cron job: every hour ──
cron.schedule('0 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Price Tracker running...`);
  try {
    // Get all tracking items from all users
    const usersSnap = await db.collection('users').get();
    let totalChecked = 0;

    for (const userDoc of usersSnap.docs) {
      const itemsSnap = await db.collection(`users/${userDoc.id}/price_tracking`).where('active', '==', true).get();

      for (const itemDoc of itemsSnap.docs) {
        const item = itemDoc.data();
        const currentPrice = await scrapePrice(item.url);

        if (currentPrice && currentPrice !== item.currentPrice) {
          const lastPrice = item.currentPrice || currentPrice;
          const change = currentPrice - lastPrice;
          const changePercent = ((change / lastPrice) * 100).toFixed(1);

          // Alert via Telegram
          if (item.telegramChatId) {
            await sendPriceAlert(item.telegramChatId, {
              productName: item.name,
              oldPrice: lastPrice,
              newPrice: currentPrice,
              change,
              changePercent,
              url: item.url,
            });
          }

          // Update Firestore
          const history = item.priceHistory || [];
          history.push({ price: currentPrice, timestamp: new Date().toISOString() });
          if (history.length > 90) history.shift(); // Keep max 90 data points

          await itemDoc.ref.update({
            lastPrice: item.currentPrice || 0,
            currentPrice,
            priceHistory: history,
          });
          totalChecked++;
        }

        // Delay between requests to avoid blocking
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }
    console.log(`Checked ${totalChecked} price changes`);
  } catch (err) {
    console.error('Price Tracker cron error:', err);
  }
});

console.log('Price Tracker started. Checking every hour.');
