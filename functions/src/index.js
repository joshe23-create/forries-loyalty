const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

// Johannesburg, next to a Firestore database created in africa-south1.
setGlobalOptions({ region: process.env.FUNCTION_REGION || 'africa-south1', maxInstances: 10 });

const { app } = require('./app');
const { col } = require('./db');
const L = require('./loyalty');
const auth = require('./auth');
const notify = require('./notify');

const BRAND = process.env.BRAND_NAME || 'Forries';

// The API, in Johannesburg next to the database.
exports.api = onRequest({ memory: '512MiB', timeoutSeconds: 60 }, app);

// Firebase Hosting can't rewrite to functions in africa-south1, so Hosting sends /api/**, /unsubscribe and
// /manifest.webmanifest here (europe-west1) and this forwards each request, in one hop, to `api` above.
// That's one extra round trip per request instead of moving `api` away from the database.
const API_URL = process.env.API_UPSTREAM || `https://africa-south1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/api`;
const PASS_REQUEST = ['cookie', 'content-type', 'accept', 'user-agent', 'accept-language'];
const PASS_RESPONSE = ['content-type', 'cache-control', 'content-disposition', 'location'];

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

  const field = c.channel === 'email' ? 'marketingEmail' : 'marketingWhatsapp';
  const snap = await col('members').where(field, '==', true).get();
  const now = Date.now();
  const filters = {
    all: () => true,
    active30: (m) => m.lastVisitAt && m.lastVisitAt.toMillis() >= now - 30 * 86400e3,
    lapsed60: (m) => !m.lastVisitAt || m.lastVisitAt.toMillis() < now - 60 * 86400e3,
    birthday_month: (m) => m.birthMonth === L.today().m,
  };
  const recipients = snap.docs
    .map((d) => ({ code: d.id, ...d.data() }))
    .filter((m) => (c.channel === 'email' ? m.email : m.phone))
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
      } else {
        await notify.sendWhatsAppTemplate({ to: r.phone, template: c.template, params: c.usesName ? [first] : [] });
      }
      sent++;
    } catch (e) {
      failed++;
      console.error(`[campaign ${ref.id}] ${c.channel} to ${r.code} failed:`, e.message);
    }
    if ((sent + failed) % 20 === 0) await ref.update({ sent, failed });
    await new Promise((ok) => setTimeout(ok, c.channel === 'email' ? 150 : 80));
  }
  await ref.update({ sent, failed, status: 'done' });
});
