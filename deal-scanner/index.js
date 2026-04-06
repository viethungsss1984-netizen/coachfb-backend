const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const axios = require('axios');
const { admin, db } = require('../shared/firebase');
const { sendMessage } = require('../shared/telegram');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- Logging utility ---
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level.toUpperCase()}] [deal-scanner] ${message}`;
  if (data) {
    console[level === 'error' ? 'error' : 'log'](entry, JSON.stringify(data));
  } else {
    console[level === 'error' ? 'error' : 'log'](entry);
  }
}

// --- Shopee API helpers ---
function signRequest(path, timestamp) {
  const appId = process.env.SHOPEE_APP_ID;
  const appSecret = process.env.SHOPEE_APP_SECRET;
  if (!appId || !appSecret) return null;

  const baseString = `${appId}${path}${timestamp}`;
  const sign = crypto
    .createHmac('sha256', appSecret)
    .update(baseString)
    .digest('hex');
  return sign;
}

async function scanShopeeDeals(niche, minDiscount) {
  const appId = process.env.SHOPEE_APP_ID;
  const appSecret = process.env.SHOPEE_APP_SECRET;

  if (!appId || !appSecret) {
    log('warn', 'Shopee API not configured, using mock data');
    return getMockDeals(niche, minDiscount);
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/flash_sale/get_flash_sale_list';
    const sign = signRequest(path, timestamp);

    const response = await axios.get(`https://partner.shopeemobile.com${path}`, {
      params: {
        app_id: appId,
        timestamp,
        sign,
        category_id: niche,
        limit: 20,
        offset: 0,
      },
      timeout: 15000,
    });

    if (!response.data || !response.data.items) {
      log('warn', 'No items returned from Shopee API');
      return [];
    }

    return response.data.items
      .filter((item) => {
        const discount = Math.round(
          ((item.price - item.flash_sale_price) / item.price) * 100
        );
        return discount >= (minDiscount || 20);
      })
      .map((item) => ({
        itemId: item.item_id,
        shopId: item.shop_id,
        name: item.item_name,
        originalPrice: item.price,
        salePrice: item.flash_sale_price,
        discount: Math.round(
          ((item.price - item.flash_sale_price) / item.price) * 100
        ),
        stock: item.stock,
        sold: item.sold || 0,
        imageUrl: item.image ? `https://cf.shopee.vn/file/${item.image}` : null,
        productUrl: `https://shopee.vn/product/${item.shop_id}/${item.item_id}`,
      }));
  } catch (err) {
    log('error', 'Shopee API request failed', { error: err.message });
    return getMockDeals(niche, minDiscount);
  }
}

function getMockDeals(niche, minDiscount) {
  return [
    {
      itemId: 'mock_001',
      shopId: 'mock_shop',
      name: `[MOCK] San pham ${niche || 'general'} giam gia`,
      originalPrice: 500000,
      salePrice: 250000,
      discount: 50,
      stock: 100,
      sold: 45,
      imageUrl: null,
      productUrl: 'https://shopee.vn',
    },
    {
      itemId: 'mock_002',
      shopId: 'mock_shop',
      name: `[MOCK] Deal hot ${niche || 'general'}`,
      originalPrice: 300000,
      salePrice: 180000,
      discount: 40,
      stock: 50,
      sold: 22,
      imageUrl: null,
      productUrl: 'https://shopee.vn',
    },
  ].filter((d) => d.discount >= (minDiscount || 20));
}

async function generateAffiliateLinks(deals, affiliateId) {
  if (!affiliateId) {
    log('info', 'No affiliate ID configured, using direct links');
    return deals;
  }

  return deals.map((deal) => ({
    ...deal,
    affiliateUrl: `https://s.shopee.vn/af/${affiliateId}?url=${encodeURIComponent(deal.productUrl)}`,
  }));
}

function formatDealMessage(deal, isVi = true) {
  const priceFormat = (p) =>
    new Intl.NumberFormat('vi-VN').format(p) + (isVi ? 'đ' : ' VND');

  if (isVi) {
    return [
      `🔥 <b>${deal.name}</b>`,
      ``,
      `💰 Giá gốc: <s>${priceFormat(deal.originalPrice)}</s>`,
      `🏷 Giá sale: <b>${priceFormat(deal.salePrice)}</b>`,
      `📉 Giảm: <b>${deal.discount}%</b>`,
      deal.stock ? `📦 Còn lại: ${deal.stock - (deal.sold || 0)} sản phẩm` : '',
      ``,
      `🔗 <a href="${deal.affiliateUrl || deal.productUrl}">Mua ngay</a>`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `🔥 <b>${deal.name}</b>`,
    ``,
    `💰 Original: <s>${priceFormat(deal.originalPrice)}</s>`,
    `🏷 Sale: <b>${priceFormat(deal.salePrice)}</b>`,
    `📉 Discount: <b>${deal.discount}%</b>`,
    deal.stock ? `📦 Remaining: ${deal.stock - (deal.sold || 0)} items` : '',
    ``,
    `🔗 <a href="${deal.affiliateUrl || deal.productUrl}">Buy now</a>`,
  ]
    .filter(Boolean)
    .join('\n');
}

// --- Main scan function ---
async function scanDeals() {
  log('info', 'Starting deal scan...');
  const startTime = Date.now();

  try {
    // 1. Query all users with deal_scanner active
    const usersSnapshot = await db
      .collection('users')
      .where('addon_tools.deal_scanner.active', '==', true)
      .get();

    if (usersSnapshot.empty) {
      log('info', 'No active deal scanner users found');
      return;
    }

    log('info', `Found ${usersSnapshot.size} active user(s)`);

    for (const userDoc of usersSnapshot.docs) {
      const uid = userDoc.id;
      const userData = userDoc.data();

      try {
        // 2. Read addon config
        const configDoc = await db
          .collection('users')
          .doc(uid)
          .collection('addon_configs')
          .doc('deal_scanner')
          .get();

        if (!configDoc.exists) {
          log('warn', `No deal_scanner config for user ${uid}, skipping`);
          continue;
        }

        const config = configDoc.data();
        const chatId = config.telegram_chat_id || userData.telegram_chat_id;

        if (!chatId) {
          log('warn', `No Telegram chat ID for user ${uid}, skipping`);
          continue;
        }

        // 3. Scan for deals
        const deals = await scanShopeeDeals(config.niche, config.min_discount);

        if (deals.length === 0) {
          log('info', `No deals found for user ${uid}`);
          continue;
        }

        // 4. Generate affiliate links
        const dealsWithLinks = await generateAffiliateLinks(
          deals,
          config.affiliate_id
        );

        // 5. Send to Telegram
        const isVi = config.language !== 'en';
        const header = isVi
          ? `📢 <b>Tìm thấy ${dealsWithLinks.length} deal hot!</b>\n`
          : `📢 <b>Found ${dealsWithLinks.length} hot deals!</b>\n`;

        await sendMessage(chatId, header);

        for (const deal of dealsWithLinks.slice(0, 10)) {
          const message = formatDealMessage(deal, isVi);
          await sendMessage(chatId, message, { disable_web_page_preview: false });
          // Small delay to avoid Telegram rate limits
          await new Promise((r) => setTimeout(r, 500));
        }

        // 6. Save to deal history
        const historyRef = db
          .collection('users')
          .doc(uid)
          .collection('deal_history');

        await historyRef.add({
          scannedAt: new Date(),
          dealsFound: dealsWithLinks.length,
          niche: config.niche || 'general',
          deals: dealsWithLinks.slice(0, 10).map((d) => ({
            itemId: d.itemId,
            name: d.name,
            originalPrice: d.originalPrice,
            salePrice: d.salePrice,
            discount: d.discount,
            url: d.affiliateUrl || d.productUrl,
          })),
        });

        log('info', `Sent ${dealsWithLinks.length} deals to user ${uid}`);
      } catch (userErr) {
        log('error', `Error processing user ${uid}`, { error: userErr.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('info', `Deal scan completed in ${elapsed}s`);
  } catch (err) {
    log('error', 'Deal scan failed', { error: err.message, stack: err.stack });
  }
}

// --- Express routes ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'deal-scanner',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/scan-now', async (req, res) => {
  log('info', 'Manual scan triggered via /scan-now');
  res.json({ message: 'Scan started', timestamp: new Date().toISOString() });
  await scanDeals();
});

// --- Telegram Callback Handler ---
// Admin bot token (separate from deal scanner bot)
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8701480154:AAEQNrJeMDAIAUPhVZMA6mUzAWQFOkSnj1o';

app.post('/telegram-callback', async (req, res) => {
  try {
    const body = req.body;
    const callbackQuery = body.callback_query;

    if (!callbackQuery || !callbackQuery.data) {
      res.json({ ok: true });
      return;
    }

    const chatId = callbackQuery.message?.chat?.id;
    const messageId = callbackQuery.message?.message_id;
    const callbackId = callbackQuery.id;
    const data = callbackQuery.data; // format: "approve_REQUESTID_PROJECTID" or "reject_REQUESTID_PROJECTID"

    log('info', `Telegram callback received: ${data}`);

    // Parse callback data
    const parts = data.split('_');
    if (parts.length < 3) {
      await answerCallback(callbackId, 'Invalid callback data');
      res.json({ ok: true });
      return;
    }

    const action = parts[0]; // "approve" or "reject"
    const requestId = parts.slice(1, -1).join('_'); // everything between action and projectId
    const projectId = parts[parts.length - 1]; // last part: "coachtt" or "coachfb"

    if (action !== 'approve' && action !== 'reject') {
      await answerCallback(callbackId, 'Unknown action');
      res.json({ ok: true });
      return;
    }

    // Select correct Firebase project
    let targetDb;
    if (projectId === 'coachfb' || projectId === 'coachfb2026') {
      const coachfbSA = process.env.FIREBASE_SERVICE_ACCOUNT_COACHFB;
      if (coachfbSA) {
        const fbApp = getOrCreateApp('coachfb', JSON.parse(coachfbSA));
        targetDb = fbApp.firestore();
      } else {
        // Fallback: use default db (current project)
        targetDb = db;
        log('warn', 'FIREBASE_SERVICE_ACCOUNT_COACHFB not set, using default');
      }
    } else {
      // Default: coachtt (current project)
      targetDb = db;
    }

    // Read payment request
    const requestRef = targetDb.doc(`payment_requests/${requestId}`);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      await answerCallback(callbackId, 'Request not found!');
      if (chatId && messageId) {
        await editMessage(chatId, messageId, `❌ Request ${requestId} not found.`);
      }
      res.json({ ok: true });
      return;
    }

    const reqData = requestDoc.data();
    const uid = reqData.uid;
    const planType = reqData.planType || reqData.type;
    const toolId = reqData.toolId;
    const toolIds = reqData.toolIds || []; // For bundles: array of tool IDs
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
        // Activate premium
        await targetDb.doc(`users/${uid}`).set({
          isPremium: true,
          premiumSince: admin.firestore.FieldValue.serverTimestamp(),
          premiumExpiry: expiryDate,
          plan: 'monthly',
          planExpiresAt: expiryDate,
        }, { merge: true });
      } else if (planType === 'bundle' && toolIds.length > 0) {
        // Activate ALL tools in bundle
        const addonUpdate = {};
        for (const tid of toolIds) {
          addonUpdate[tid] = {
            active: true,
            purchased_at: admin.firestore.FieldValue.serverTimestamp(),
            expires: expiryDate,
          };
        }
        await targetDb.doc(`users/${uid}`).set({
          addon_tools: addonUpdate,
        }, { merge: true });
      } else if (planType === 'addon' && toolId) {
        // Activate single addon
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

      const toolInfo = toolIds.length > 0 ? ` (${toolIds.join(', ')})` : (toolId ? ` (${toolId})` : '');
      const statusText = `✅ APPROVED\n\nRequest: ${requestId}\nUser: ${uid}\nType: ${planType}${toolInfo}\nAmount: ${amount.toLocaleString()}đ\nProject: ${projectId}`;
      await answerCallback(callbackId, '✅ Đã duyệt!');
      if (chatId && messageId) {
        await editMessage(chatId, messageId, statusText);
      }
    } else {
      // Reject
      await requestRef.update({
        status: 'rejected',
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const statusText = `❌ REJECTED\n\nRequest: ${requestId}\nUser: ${uid}\nType: ${planType}${toolId ? ' (' + toolId + ')' : ''}\nProject: ${projectId}`;
      await answerCallback(callbackId, '❌ Đã từ chối!');
      if (chatId && messageId) {
        await editMessage(chatId, messageId, statusText);
      }
    }

    log('info', `Payment ${action}d: ${requestId} (${projectId})`);
    res.json({ ok: true });
  } catch (err) {
    log('error', 'Telegram callback error', { error: err.message, stack: err.stack });
    res.json({ ok: true }); // Always return 200 to Telegram
  }
});

// Helper: get or create Firebase app for multi-project
function getOrCreateApp(name, serviceAccount) {
  const existing = admin.apps.find(a => a && a.name === name);
  if (existing) return existing;
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  }, name);
}

// Helper: answer Telegram callback query
async function answerCallback(callbackQueryId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text,
      show_alert: true,
    });
  } catch (err) {
    log('error', 'answerCallbackQuery failed', { error: err.message });
  }
}

// Helper: edit Telegram message
async function editMessage(chatId, messageId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    log('error', 'editMessageText failed', { error: err.message });
  }
}

// --- Payment Notification Endpoint ---
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '5737101178';

app.post('/notify-payment', async (req, res) => {
  try {
    const { appName, userName, userEmail, planName, amount, requestId, projectId } = req.body;

    if (!requestId) {
      res.status(400).json({ error: 'Missing requestId' });
      return;
    }

    const fmtAmount = amount ? Number(amount).toLocaleString('vi-VN') : '0';
    const text = [
      `<b>PAYMENT REQUEST</b>`,
      ``,
      `<b>App:</b> ${appName || 'CoachTT2026'}`,
      `<b>User:</b> ${userName || 'Unknown'}`,
      `<b>Email:</b> ${userEmail || 'N/A'}`,
      `<b>Plan:</b> ${planName || 'N/A'}`,
      `<b>Amount:</b> ${fmtAmount}d`,
      `<b>Request ID:</b> <code>${requestId}</code>`,
      `<b>Project:</b> ${projectId || 'coachtt'}`,
      `<b>Time:</b> ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
    ].join('\n');

    const pid = projectId || 'coachtt';

    await axios.post(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `approve_${requestId}_${pid}` },
          { text: 'Reject', callback_data: `reject_${requestId}_${pid}` },
        ]],
      },
    });

    log('info', `Payment notification sent for ${requestId}`);
    res.json({ ok: true, message: 'Notification sent' });
  } catch (err) {
    log('error', 'notify-payment error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// --- Cron schedule: every 15 minutes ---
cron.schedule('*/15 * * * *', () => {
  log('info', 'Cron triggered: deal scan');
  scanDeals();
});

// --- Server start ---
const server = app.listen(PORT, () => {
  log('info', `Deal Scanner service running on port ${PORT}`);
});

// --- Graceful shutdown ---
function gracefulShutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    log('info', 'HTTP server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { reason: String(reason) });
});
