const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');

// Johannesburg, next to a Firestore database created in africa-south1.
setGlobalOptions({ region: process.env.FUNCTION_REGION || 'africa-south1', maxInstances: 10 });

const { app } = require('./app');
const { col } = require('./db');
const L = require('./loyalty');
const auth = require('./auth');
const notify = require('./notify');
const push = require('./push');
const wallet = require('./wallet');
const { db } = require('./db');

const BRAND = process.env.BRAND_NAME || 'Forries';

// The API, in Johannesburg next to the database.
exports.api = onRequest({ memory: '512MiB', timeoutSeconds: 60 }, app);

// Firebase Hosting can't rewrite to functions in africa-south1, so Hosting sends /api/**, /unsubscribe and
// /manifest.webmanifest here (europe-west1) and this forwards each request, in one hop, to `api` above.
// That's one extra round trip per request instead of moving `api` away from the database.
const API_URL = process.env.API_UPSTREAM || `https://africa-south1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/api`;
const PASS_REQUEST = ['cookie', 'content-type', 'accept', 'user-agent', 'accept-language', 'authorization', 'if-modified-since'];
const PASS_RESPONSE = ['content-type', 'cache-control', 'content-disposition', 'location', 'last-modified'];

exports.web = onRequest({ region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60 }, async (req, res) => {
  const headers = {};
  for (const h of PASS_REQUEST) if (req.headers[h]) headers[h] = req.headers[h];
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.ip;
  try {
    const upstream = await fetch(API_URL + req.originalUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.rawBody,
      redirect: 'manual',
    });
    res.status(upstream.status);
    for (const h of PASS_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) res.set('set-cookie', cookies);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    console.error('[web] upstream error', e);
    res.status(502).json({ error: 'Something went wrong — please try again' });
  }
});

// Birthday rewards + notifications, every morning (rewards also appear lazily when a card is opened).
// Cloud Scheduler isn't offered in africa-south1, so this one job runs from Belgium.
exports.birthdays = onSchedule({ schedule: 'every day 08:00', timeZone: 'Africa/Johannesburg', region: process.env.SCHEDULER_REGION || 'europe-west1' }, async () => {
  await L.runBirthdays(process.env.PUBLIC_URL || '');
});

// Sends a campaign queued from the Messages tab. Runs separately from the web request so a
// large send isn't cut off when the HTTP response finishes.
exports.sendCampaign = onDocumentCreated({ document: 'campaigns/{id}', timeoutSeconds: 540, memory: '512MiB' }, async (event) => {
  const ref = event.data.ref;
  const c = event.data.data();
  if (c.status !== 'queued') return;
  await ref.update({ status: 'sending' });

  let members;
  if (c.channel === 'push') {
    const subs = await col('pushSubs').where('marketing', '==', true).select('memberCode').get();
    const codes = [...new Set(subs.docs.map((d) => d.data().memberCode))];
    members = codes.length ? (await db.getAll(...codes.map((x) => col('members').doc(x)))).filter((d) => d.exists) : [];
  } else {
    members = (await col('members').where(c.channel === 'email' ? 'marketingEmail' : 'marketingWhatsapp', '==', true).get()).docs;
  }
  const now = Date.now();
  const filters = {
    all: () => true,
    active30: (m) => m.lastVisitAt && m.lastVisitAt.toMillis() >= now - 30 * 86400e3,
    lapsed60: (m) => !m.lastVisitAt || m.lastVisitAt.toMillis() < now - 60 * 86400e3,
    birthday_month: (m) => m.birthMonth === L.today().m,
  };
  const recipients = members
    .map((d) => ({ code: d.id, ...d.data() }))
    .filter((m) => (c.channel === 'email' ? m.email : c.channel === 'whatsapp' ? m.phone : true))
    .filter(filters[c.audience] || (() => false));

  let sent = 0, failed = 0;
  for (const r of recipients) {
    const first = r.name.split(' ')[0];
    try {
      if (c.channel === 'email') {
        const unsub = `${c.baseUrl}/unsubscribe?c=${r.code}&t=${auth.unsubToken(r.code)}`;
        await notify.sendEmail({
          to: r.email,
          subject: c.subject.replace(/\{\{\s*name\s*\}\}/g, first),
          text: `${c.body.replace(/\{\{\s*name\s*\}\}/g, first)}\n\n—\nView your loyalty card: ${c.baseUrl}\nUnsubscribe from ${BRAND} emails: ${unsub}`,
          unsubscribeUrl: unsub,
        });
      } else if (c.channel === 'push') {
        const n = await push.sendToMember(r.code, { title: c.subject.replace(/\{\{\s*name\s*\}\}/g, first), body: c.body.replace(/\{\{\s*name\s*\}\}/g, first), url: '/?tab=specials', tag: `campaign-${ref.id}` }, 'marketing');
        if (!n) throw new Error('no reachable devices');
      } else {
        await notify.sendWhatsAppTemplate({ to: r.phone, template: c.template, params: c.usesName ? [first] : [] });
      }
      sent++;
    } catch (e) {
      failed++;
      console.error(`[campaign ${ref.id}] ${c.channel} to ${r.code} failed:`, e.message);
    }
    if ((sent + failed) % 20 === 0) await ref.update({ sent, failed });
    await new Promise((ok) => setTimeout(ok, c.channel === 'email' ? 150 : c.channel === 'push' ? 20 : 80));
  }
  await ref.update({ sent, failed, status: 'done' });
});

// Whenever a member's card changes (stamp, redemption, gift, or an undo): tell their phone(s) and refresh
// their Apple/Google Wallet card. Runs in the background so the staff screen stays fast.
exports.onCardActivity = onDocumentWritten({ document: 'transactions/{id}', timeoutSeconds: 60 }, async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const t = after || before;
  if (!t?.memberCode) return;
  const created = !before && after;
  const undone = before && after && !before.undone && after.undone;
  if (!created && !undone) return;

  const jobs = [wallet.refreshWallets(t.memberCode)];
  if (created) {
    let payload = null;
    if (t.type === 'stamp' && t.voucherIds?.length) {
      const v = await col('vouchers').doc(t.voucherIds[0]).get();
      payload = { title: '🎉 You earned a reward!', body: `${v.exists ? v.data().title : 'A reward'} — show your card to claim it.`, url: '/?tab=rewards', tag: 'reward' };
    } else if (t.type === 'stamp') {
      const m = await col('members').doc(t.memberCode).get();
      const p = await col('programs').doc(t.programId).get();
      const have = m.exists ? m.data().cards?.[t.programId] || 0 : 0;
      const need = p.exists ? p.data().stampsRequired : 0;
      payload = { title: `${t.emoji || '⭐'} +${t.qty} stamp${t.qty > 1 ? 's' : ''}`, body: need ? `${t.programName}: ${have} of ${need} — ${need - have} more to go` : t.programName, url: '/', tag: `card-${t.programId}` };
    } else if (t.type === 'gift') {
      payload = { title: '🎁 A gift from the team', body: `${t.voucherTitle} — it's waiting in your rewards.`, url: '/?tab=rewards', tag: 'reward' };
    } else if (t.type === 'redeem') {
      payload = { title: '✅ Reward redeemed', body: `${t.voucherTitle} — enjoy!`, url: '/', tag: 'redeemed' };
    }
    if (payload) jobs.push(push.sendToMember(t.memberCode, payload, 'updates').catch((e) => console.error('[push]', e.message)));
  }
  await Promise.all(jobs);
});
