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

// ── Admin Bot (for payment approval callbacks) ──
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8701480154:AAEQNrJeMDAIAUPhVZMA6mUzAWQFOkSnj1o';

// ── Express ──
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.json({ service: 'deal-scanner', status: 'running', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Helper: get or create Firebase app for multi-project ──
function getOrCreateApp(name, sa) {
  const existing = admin.apps.find(a => a && a.name === name);
  if (existing) return existing;
  return admin.initializeApp({ credential: admin.credential.cert(sa) }, name);
}

// ── Helper: answer Telegram callback query ──
async function answerCallback(callbackQueryId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId, text, show_alert: true,
    });
  } catch (err) { console.error('answerCallbackQuery failed:', err.message); }
}

// ── Helper: edit Telegram message ──
async function editMessage(chatId, messageId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/editMessageText`, {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    });
  } catch (err) { console.error('editMessageText failed:', err.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── POST /telegram-callback — Telegram webhook for admin payment approval ──
// ══════════════════════════════════════════════════════════════════════════════
app.post('/telegram-callback', async (req, res) => {
  try {
    const callbackQuery = req.body?.callback_query;
    if (!callbackQuery || !callbackQuery.data) {
      res.json({ ok: true });
      return;
    }

    const chatId = callbackQuery.message?.chat?.id;
    const messageId = callbackQuery.message?.message_id;
    const callbackId = callbackQuery.id;
    const data = callbackQuery.data;

    console.log(`[CALLBACK] Received: ${data}`);

    // Parse: "approve_REQUESTID_PROJECTID" or "reject_REQUESTID_PROJECTID"
    const parts = data.split('_');
    if (parts.length < 3) {
      await answerCallback(callbackId, 'Invalid data');
      res.json({ ok: true });
      return;
    }

    const action = parts[0]; // "approve" or "reject"
    const projectId = parts[parts.length - 1]; // last part
    const requestId = parts.slice(1, -1).join('_'); // middle parts

    if (action !== 'approve' && action !== 'reject') {
      await answerCallback(callbackId, 'Unknown action');
      res.json({ ok: true });
      return;
    }

    // Select correct Firebase project
    let targetDb = db; // default: current project
    if (projectId === 'coachfb' || projectId === 'coachfb2026') {
      const coachfbSA = process.env.FIREBASE_SERVICE_ACCOUNT_COACHFB;
      if (coachfbSA) {
        const fbApp = getOrCreateApp('coachfb', JSON.parse(coachfbSA));
        targetDb = fbApp.firestore();
      } else {
        console.warn('[CALLBACK] FIREBASE_SERVICE_ACCOUNT_COACHFB not set, using default');
      }
    } else if (projectId === 'coachtt' || projectId === 'coachtt2026') {
      const coachttSA = process.env.FIREBASE_SERVICE_ACCOUNT_COACHTT;
      if (coachttSA) {
        const fbApp = getOrCreateApp('coachtt', JSON.parse(coachttSA));
        targetDb = fbApp.firestore();
      } else {
        console.warn('[CALLBACK] FIREBASE_SERVICE_ACCOUNT_COACHTT not set, using default');
      }
    }

    // Read payment request
    const requestRef = targetDb.doc(`payment_requests/${requestId}`);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      await answerCallback(callbackId, 'Request not found!');
      if (chatId && messageId) await editMessage(chatId, messageId, `\u274C Request ${requestId} not found.`);
      res.json({ ok: true });
      return;
    }

    const reqData = requestDoc.data();
    const uid = reqData.uid;
    const planType = reqData.planType || reqData.type;
    const toolId = reqData.toolId;
    const amount = reqData.amount || 0;

    const now = admin.firestore.Timestamp.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const expiryDate = admin.firestore.Timestamp.fromMillis(now.toMillis() + thirtyDaysMs);

    if (action === 'approve') {
      // Update payment request
      await requestRef.update({
        status: 'approved',
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        autoApproved: false,
      });

      if (planType === 'premium') {
        await targetDb.doc(`users/${uid}`).set({
          isPremium: true,
          premiumSince: admin.firestore.FieldValue.serverTimestamp(),
          premiumExpiry: expiryDate,
          plan: 'monthly',
          planExpiresAt: expiryDate,
        }, { merge: true });
      } else if (planType === 'addon' && toolId) {
        await targetDb.doc(`users/${uid}`).set({
          addon_tools: {
            [toolId]: {
              active: true,
              purchased_at: admin.firestore.FieldValue.serverTimestamp(),
              expires: expiryDate,
            },
          },
        }, { merge: true });
      }

      const statusText = `\u2705 <b>APPROVED</b>\n\nRequest: <code>${requestId}</code>\nUser: <code>${uid}</code>\nType: ${planType}${toolId ? ' (' + toolId + ')' : ''}\nAmount: ${Number(amount).toLocaleString()}\u0111\nProject: ${projectId}`;
      await answerCallback(callbackId, '\u2705 Approved!');
      if (chatId && messageId) await editMessage(chatId, messageId, statusText);
      console.log(`[CALLBACK] APPROVED: ${requestId} (${projectId})`);
    } else {
      await requestRef.update({
        status: 'rejected',
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const statusText = `\u274C <b>REJECTED</b>\n\nRequest: <code>${requestId}</code>\nUser: <code>${uid}</code>\nType: ${planType}${toolId ? ' (' + toolId + ')' : ''}\nProject: ${projectId}`;
      await answerCallback(callbackId, '\u274C Rejected!');
      if (chatId && messageId) await editMessage(chatId, messageId, statusText);
      console.log(`[CALLBACK] REJECTED: ${requestId} (${projectId})`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[CALLBACK] Error:', err.message);
    res.json({ ok: true }); // Always 200 to Telegram
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Deal Scanner Logic ──
// ══════════════════════════════════════════════════════════════════════════════

async function getActiveAddonUsers(addonId) {
  const usersSnap = await db.collection('users').get();
  const activeUsers = [];
  for (const userDoc of usersSnap.docs) {
    const userData = userDoc.data();
    const addons = userData.addonTools || {};
    const expiresAt = addons[addonId];
    if (expiresAt && new Date(expiresAt._seconds ? expiresAt._seconds * 1000 : expiresAt) > new Date()) {
      const configDoc = await db.doc(`users/${userDoc.id}/addon_configs/${addonId}`).get();
      if (configDoc.exists && configDoc.data().active) {
        activeUsers.push({ uid: userDoc.id, ...configDoc.data() });
      }
    }
  }
  return activeUsers;
}

async function scanShopeeDeals(niche, minDiscount) {
  try {
    console.log(`[SCAN] Scanning Shopee deals for niche: ${niche}, min discount: ${minDiscount}%`);
    return []; // Return empty until Shopee API is connected
  } catch (err) {
    console.error('Shopee scan error:', err.message);
    return [];
  }
}

async function sendToTelegram(chatId, deals) {
  for (const deal of deals) {
    const msg = [
      `\uD83D\uDD25 *FLASH SALE!*`,
      `\uD83D\uDCE6 ${deal.productName}`,
      `\uD83D\uDCB0 ~~${deal.originalPrice}~~ \u2192 *${deal.salePrice}* (-${deal.discount}%)`,
      `\uD83D\uDD17 [Mua ngay](${deal.affiliateUrl})`,
    ].join('\n');
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      console.error(`Telegram send error for chat ${chatId}:`, err.message);
    }
  }
}

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

// ── Start server ──
app.listen(PORT, () => {
  console.log(`Deal Scanner Bot started. Scanning every 15 minutes.`);
  console.log(`Deal Scanner running on port ${PORT}`);
  console.log(`Telegram callback endpoint: POST /telegram-callback`);
});
