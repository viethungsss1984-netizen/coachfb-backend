const express = require('express');
const cron = require('node-cron');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ── Firebase Init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Telegram Bot ──
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// ── Express health check (Railway needs a port) ──
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.json({ service: 'deal-scanner', status: 'running', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Deal Scanner running on port ${PORT}`));

// ── Get active addon users ──
async function getActiveAddonUsers(addonId) {
  // Query users where addon is active and not expired
  const usersSnap = await db.collection('users').get();
  const activeUsers = [];
  for (const userDoc of usersSnap.docs) {
    const userData = userDoc.data();
    const addons = userData.addonTools || {};
    const expiresAt = addons[addonId];
    if (expiresAt && new Date(expiresAt._seconds ? expiresAt._seconds * 1000 : expiresAt) > new Date()) {
      // Get addon config
      const configDoc = await db.doc(`users/${userDoc.id}/addon_configs/${addonId}`).get();
      if (configDoc.exists && configDoc.data().active) {
        activeUsers.push({ uid: userDoc.id, ...configDoc.data() });
      }
    }
  }
  return activeUsers;
}

// ── Scan Shopee deals (mock — replace with real Shopee API when approved) ──
async function scanShopeeDeals(niche, minDiscount) {
  // TODO: Replace with real Shopee Open Platform API
  // For now, use Shopee Affiliate API or web scraping
  try {
    // Example: Shopee Affiliate API endpoint
    // const response = await axios.get('https://affiliate.shopee.vn/api/deals', { params: { category: niche, discount_min: minDiscount } });
    // return response.data.deals;
    console.log(`[SCAN] Scanning Shopee deals for niche: ${niche}, min discount: ${minDiscount}%`);
    return []; // Return empty until API is connected
  } catch (err) {
    console.error('Shopee scan error:', err.message);
    return [];
  }
}

// ── Send deals to Telegram ──
async function sendToTelegram(chatId, deals) {
  for (const deal of deals) {
    const msg = [
      `🔥 *FLASH SALE!*`,
      `📦 ${deal.productName}`,
      `💰 ~~${deal.originalPrice}~~ → *${deal.salePrice}* (-${deal.discount}%)`,
      `🔗 [Mua ngay](${deal.affiliateUrl})`,
    ].join('\n');
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      console.error(`Telegram send error for chat ${chatId}:`, err.message);
    }
  }
}

// ── Save deal history to Firestore ──
async function saveDealHistory(uid, deals) {
  const batch = db.batch();
  for (const deal of deals) {
    const ref = db.collection(`users/${uid}/deal_history`).doc();
    batch.set(ref, {
      productName: deal.productName,
      originalPrice: deal.originalPrice,
      salePrice: deal.salePrice,
      discount: deal.discount,
      affiliateUrl: deal.affiliateUrl,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      platform: 'shopee',
    });
  }
  if (deals.length > 0) await batch.commit();
}

// ── Main cron job: every 15 minutes ──
cron.schedule('*/15 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Deal Scanner running...`);
  try {
    const users = await getActiveAddonUsers('deal_scanner');
    console.log(`Found ${users.length} active deal_scanner users`);

    for (const user of users) {
      const deals = await scanShopeeDeals(user.niche || 'all', user.minDiscount || 30);
      if (deals.length > 0) {
        await sendToTelegram(user.telegramChatId, deals);
        await saveDealHistory(user.uid, deals);
        console.log(`Sent ${deals.length} deals to user ${user.uid}`);
      }
    }
  } catch (err) {
    console.error('Deal Scanner cron error:', err);
  }
});

console.log('Deal Scanner Bot started. Scanning every 15 minutes.');
