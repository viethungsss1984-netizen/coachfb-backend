const express = require('express');
const cron = require('node-cron');
const admin = require('firebase-admin');
const axios = require('axios');

// ── Firebase Init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Express health check ──
const app = express();
const PORT = process.env.PORT || 3002;
app.get('/', (req, res) => res.json({ service: 'commission-sync', status: 'running', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Commission Sync running on port ${PORT}`));

// ── Sync Shopee commissions ──
async function syncShopeeCommissions(uid, config) {
  // TODO: Implement with Shopee Affiliate API
  // POST https://affiliate.shopee.vn/api/v1/report
  // Headers: { Authorization: `Bearer ${config.secretKey}` }
  console.log(`[SYNC] Shopee commissions for user ${uid}`);
  return [];
}

// ── Sync TikTok Shop commissions ──
async function syncTikTokCommissions(uid, config) {
  // TODO: Implement with TikTok Shop API
  console.log(`[SYNC] TikTok Shop commissions for user ${uid}`);
  return [];
}

// ── Sync Lazada commissions ──
async function syncLazadaCommissions(uid, config) {
  // TODO: Implement with Lazada Affiliate API
  console.log(`[SYNC] Lazada commissions for user ${uid}`);
  return [];
}

// ── Save commissions to Firestore ──
async function saveCommissions(uid, platform, commissions) {
  const batch = db.batch();
  for (const c of commissions) {
    const ref = db.collection(`users/${uid}/commissions`).doc(`${platform}_${c.orderId}`);
    batch.set(ref, {
      platform,
      orderId: c.orderId,
      productName: c.productName,
      orderAmount: c.orderAmount,
      commissionRate: c.commissionRate,
      commissionAmount: c.commissionAmount,
      status: c.status || 'pending',
      orderDate: c.orderDate ? admin.firestore.Timestamp.fromDate(new Date(c.orderDate)) : admin.firestore.FieldValue.serverTimestamp(),
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  if (commissions.length > 0) await batch.commit();
}

// ── Main cron job: every hour ──
cron.schedule('0 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] Commission Sync running...`);
  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const addons = userData.addonTools || {};
      const expires = addons['commission_dashboard'];

      // Check if addon is active
      if (!expires) continue;
      const expiresDate = new Date(expires._seconds ? expires._seconds * 1000 : expires);
      if (expiresDate <= new Date()) continue;

      const uid = userDoc.id;

      // Check each platform config
      const platforms = ['shopee', 'tiktok', 'lazada'];
      for (const platform of platforms) {
        const configDoc = await db.doc(`users/${uid}/commission_configs/${platform}`).get();
        if (!configDoc.exists || !configDoc.data().connected) continue;

        const config = configDoc.data();
        let commissions = [];

        switch (platform) {
          case 'shopee':
            commissions = await syncShopeeCommissions(uid, config);
            break;
          case 'tiktok':
            commissions = await syncTikTokCommissions(uid, config);
            break;
          case 'lazada':
            commissions = await syncLazadaCommissions(uid, config);
            break;
        }

        if (commissions.length > 0) {
          await saveCommissions(uid, platform, commissions);
          console.log(`Synced ${commissions.length} ${platform} commissions for user ${uid}`);
        }
      }
    }
  } catch (err) {
    console.error('Commission Sync cron error:', err);
  }
});

console.log('Commission Sync started. Syncing every hour.');
