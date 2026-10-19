// Web Push notifications (works for Android/desktop browsers and home-screen iPhone apps, iOS 16.4+).
// The VAPID key pair is generated on first use and kept server-side in Firestore, so there's nothing to configure.
const crypto = require('crypto');
const webpush = require('web-push');
const { db, col, Timestamp } = require('./db');

let vapid = null;
async function keys() {
  if (vapid) return vapid;
  const ref = col('settings').doc('push');
  vapid = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.exists && s.data().publicKey) return s.data();
    const k = webpush.generateVAPIDKeys();
    t.set(ref, { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: Timestamp.now() });
    return k;
  });
  return vapid;
}

const publicKey = async () => (await keys()).publicKey;
const subId = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 40);

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth;
}

/** Save (or move) a browser's subscription to this member. prefs: { updates, marketing } */
async function subscribe(code, sub, prefs) {
  await col('pushSubs').doc(subId(sub.endpoint)).set({
    memberCode: code,
    sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    updates: prefs.updates !== false,
    marketing: !!prefs.marketing,
    createdAt: Timestamp.now(),
  });
}

async function unsubscribe(code, endpoint) {
  const ref = col('pushSubs').doc(subId(endpoint));
  const s = await ref.get();
  if (s.exists && s.data().memberCode === code) await ref.delete();
}

async function memberSubs(code) {
  return (await col('pushSubs').where('memberCode', '==', code).get()).docs;
}

/**
 * Send to every device a member has subscribed. kind: 'updates' (card/reward news) or 'marketing'.
 * Dead subscriptions (404/410) are removed. Returns the number of devices reached.
 */
async function sendToMember(code, payload, kind = 'updates') {
  const docs = (await memberSubs(code)).filter((d) => d.data()[kind]);
  if (!docs.length) return 0;
  const k = await keys();
  const opts = {
    vapidDetails: { subject: `mailto:${process.env.MAIL_FROM || 'rewards@forries.co.za'}`, publicKey: k.publicKey, privateKey: k.privateKey },
    TTL: kind === 'marketing' ? 6 * 3600 : 24 * 3600,
    urgency: kind === 'marketing' ? 'low' : 'normal',
  };
  let reached = 0;
  await Promise.all(
    docs.map(async (d) => {
      try {
        await webpush.sendNotification(d.data().sub, JSON.stringify(payload), opts);
        reached++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete();
        else console.error('[push] send failed', code, e.statusCode || '', e.body || e.message);
      }
    })
  );
  return reached;
}

module.exports = { publicKey, validSubscription, subscribe, unsubscribe, memberSubs, sendToMember };
