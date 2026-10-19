// The HTTP API, served as one Cloud Function behind Firebase Hosting (/api/**, /unsubscribe, /manifest.webmanifest).
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { db, col, iso, daysAgo, seedDefaults, Timestamp } = require('./db');
const auth = require('./auth');
const L = require('./loyalty');
const notify = require('./notify');
const integrity = require('./integrity');

const env = process.env;
const BRAND = env.BRAND_NAME || 'Forries';
const DEMO = env.DEMO_MODE === 'true';
const MAX_STAMPS = Number(env.MAX_STAMPS_PER_SCAN || 10);
// Venue logo (dark version) for the printable poster.
const LOGO_INK = require('fs').readFileSync(require('path').join(__dirname, 'assets', 'logo-ink.svg'), 'utf8');

const app = express();
app.set('trust proxy', true);
// Cloud Functions has already parsed JSON bodies; only parse when running elsewhere.
app.use((req, res, next) => (req.rawBody ? next() : express.json({ limit: '200kb' })(req, res, next)));
app.use(async (_req, _res, next) => {
  try {
    await seedDefaults();
    next();
  } catch (e) {
    next(e);
  }
});

const baseUrl = (req) => env.PUBLIC_URL || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
// Wrap async handlers so thrown errors reach the error handler; UserErrors become 400s.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => (e instanceof L.UserError ? bad(res, e.message) : next(e)));

// ------------------------------------------------------------------ helpers
// "082 123 4567", "+27 82 123 4567", "27821234567" -> "27821234567"
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = (env.DEFAULT_COUNTRY_CODE || '27') + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : undefined;
}
const normalizeEmail = (e) => (e ? String(e).trim().toLowerCase() : null);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function parseBirthday(b) {
  if (!b) return null;
  const m = String(b).match(/^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/);
  if (!m) return undefined;
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) return undefined;
  return { month, day };
}

// Unambiguous characters only, so staff can type a code if the camera won't scan.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newMemberCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

async function getMember(code) {
  if (!code) return null;
  const s = await col('members').doc(code).get();
  return s.exists ? { code: s.id, ...s.data() } : null;
}

async function findMember(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) {
    const idx = await col('memberEmails').doc(normalizeEmail(id)).get();
    return idx.exists ? getMember(idx.data().code) : null;
  }
  const phone = normalizePhone(id);
  if (phone) {
    const idx = await col('memberPhones').doc(phone).get();
    if (idx.exists) return getMember(idx.data().code);
  }
  return /^[A-Z2-9]{8}$/.test(cleanCode(id)) ? getMember(cleanCode(id)) : null;
}

// Best-effort limiter for login-code requests (per function instance).
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

async function activeSpecials() {
  const t = L.today().iso;
  const snap = await col('specials').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => (!s.startsOn || s.startsOn <= t) && (!s.endsOn || s.endsOn >= t))
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.startsOn || iso(b.createdAt)).localeCompare(a.startsOn || iso(a.createdAt)))
    .map(specialOut);
}
const specialOut = (s) => ({ id: s.id, title: s.title, body: s.body || '', image_url: s.imageUrl || null, starts_on: s.startsOn || null, ends_on: s.endsOn || null, pinned: !!s.pinned });

const publicMember = (m) => ({
  code: m.code, name: m.name, email: m.email || null, phone: m.phone || null,
  birthday: m.birthMonth ? `${String(m.birthMonth).padStart(2, '0')}-${String(m.birthDay).padStart(2, '0')}` : null,
  marketing_email: !!m.marketingEmail, marketing_whatsapp: !!m.marketingWhatsapp, created_at: iso(m.createdAt),
});

/** Update a member's profile fields, keeping the email/phone uniqueness indexes in step. */
async function updateMember(code, fields) {
  const ref = col('members').doc(code);
  await db.runTransaction(async (t) => {
    const cur = (await t.get(ref)).data();
    const ops = [];
    for (const [key, idxCol] of [['email', 'memberEmails'], ['phone', 'memberPhones']]) {
      if (!(key in fields) || fields[key] === cur[key]) continue;
      if (fields[key]) {
        const idx = col(idxCol).doc(fields[key]);
        const s = await t.get(idx);
        if (s.exists && s.data().code !== code) throw new L.UserError(`Another member already has that ${key === 'email' ? 'email' : 'phone number'}`);
        ops.push(() => t.set(idx, { code }));
      }
      if (cur[key]) ops.push(() => t.delete(col(idxCol).doc(cur[key])));
    }
    ops.forEach((op) => op());
    if (fields.name) fields.nameLower = fields.name.toLowerCase();
    t.update(ref, fields);
  });
  return getMember(code);
}

// ------------------------------------------------------------------ public
app.get('/api/brand', (_req, res) =>
  res.json({
    name: BRAND,
    tagline: env.BRAND_TAGLINE || 'Collect stamps, earn rewards.',
    demo: DEMO,
    loginVia: { email: notify.emailEnabled(), whatsapp: notify.whatsappEnabled() && !!env.WHATSAPP_OTP_TEMPLATE },
    privacyUrl: env.PRIVACY_URL || null,
  })
);
app.get('/api/specials', h(async (_req, res) => res.json(await activeSpecials())));

app.get('/manifest.webmanifest', (_req, res) =>
  res.type('application/manifest+json').json({
    name: `${BRAND} Rewards`, short_name: BRAND, start_url: '/', scope: '/', display: 'standalone', background_color: '#f6f1e7', theme_color: '#1f4d3a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
);

async function unsubscribe(req) {
  const c = cleanCode(req.query.c);
  const t = String(req.query.t || '');
  const m = c && (await getMember(c));
  const ok = !!m && t.length === 24 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(auth.unsubToken(m.code)));
  if (ok) await col('members').doc(m.code).update({ marketingEmail: false });
  return ok;
}
app.get('/unsubscribe', h(async (req, res) => {
  const ok = await unsubscribe(req);
  res.type('html').send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${BRAND}</title>
     <body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center">
     <h1>${ok ? "You're unsubscribed" : 'Link not valid'}</h1>
     <p>${ok ? `You won't get marketing emails from ${BRAND} any more. Your stamps and rewards are unaffected.` : 'Please manage your preferences in the app.'}</p>
     <p><a href="/">Open my card</a></p></body>`
  );
}));
// One-click unsubscribe (RFC 8058) posts here.
app.post('/unsubscribe', h(async (req, res) => {
  await unsubscribe(req);
  res.sendStatus(200);
}));

// ------------------------------------------------------------------ member API
app.post('/api/m/signup', h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const email = normalizeEmail(b.email);
  const phone = normalizePhone(b.phone);
  const birthday = parseBirthday(b.birthday);
  if (!name) return bad(res, 'Please enter your name');
  if (!email || !validEmail(email)) return bad(res, 'Please enter a valid email address');
  if (phone === undefined) return bad(res, "That phone number doesn't look right");
  if (birthday === undefined) return bad(res, "That birthday doesn't look right");
  if (!b.accept_terms) return bad(res, 'Please accept the terms to join');

  let code;
  try {
    code = await db.runTransaction(async (t) => {
      const emailIdx = col('memberEmails').doc(email);
      const phoneIdx = phone ? col('memberPhones').doc(phone) : null;
      const [e, p] = await Promise.all([t.get(emailIdx), phoneIdx ? t.get(phoneIdx) : null]);
      if (e.exists || p?.exists) throw new Error('DUPLICATE');
      let c, ref;
      for (;;) {
        c = newMemberCode();
        ref = col('members').doc(c);
        if (!(await t.get(ref)).exists) break;
      }
      t.set(ref, {
        name, nameLower: name.toLowerCase(), email, phone, birthMonth: birthday?.month ?? null, birthDay: birthday?.day ?? null,
        marketingEmail: !!b.marketing_email, marketingWhatsapp: !!(b.marketing_whatsapp && phone),
        cards: {}, lastStampTx: {}, totalStamps: 0, rewardsRedeemed: 0,
        createdAt: Timestamp.now(), activityAt: Timestamp.now(), lastVisitAt: null,
      });
      t.set(emailIdx, { code: c });
      if (phoneIdx) t.set(phoneIdx, { code: c });
      return c;
    });
  } catch (e) {
    if (e.message === 'DUPLICATE') return bad(res, "You're already a member — sign in instead", 409);
    throw e;
  }
  await L.issueBirthdayVoucher(await getMember(code));
  await auth.startMemberSession(req, res, code);
  res.json({ ok: true });
}));

app.post('/api/m/login', h(async (req, res) => {
  const identifier = String(req.body?.identifier || '');
  if (rateLimited('ip:' + req.ip, 20, 15 * 60e3) || rateLimited('id:' + identifier.toLowerCase(), 5, 15 * 60e3))
    return bad(res, 'Too many attempts — please wait a few minutes', 429);
  const m = await findMember(identifier);
  if (!m) return bad(res, "We couldn't find a membership with that email or number", 404);
  const code = await auth.issueLoginCode(m.code);
  let sentVia = null;
  try {
    if (m.email && notify.emailEnabled()) {
      await notify.sendEmail({
        to: m.email,
        subject: `Your ${BRAND} sign-in code: ${code}`,
        text: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for this, you can ignore this email.`,
      });
      sentVia = 'email';
    } else if (m.phone && notify.whatsappEnabled() && env.WHATSAPP_OTP_TEMPLATE) {
      await notify.sendWhatsAppCode(m.phone, code);
      sentVia = 'whatsapp';
    }
  } catch (e) {
    console.error('[login] could not send code:', e.message);
    if (!DEMO) return bad(res, "We couldn't send your code right now — please ask the team for help", 502);
  }
  if (!sentVia && !DEMO) return bad(res, 'Sign-in codes are not set up yet — please ask the team for help', 503);
  const where = sentVia === 'email' ? m.email.replace(/^(.).*(@.*)$/, '$1•••$2') : sentVia === 'whatsapp' ? 'WhatsApp •••' + m.phone.slice(-4) : null;
  res.json({ ok: true, sentVia, where, demoCode: DEMO && !sentVia ? code : undefined });
}));

app.post('/api/m/verify', h(async (req, res) => {
  const m = await findMember(req.body?.identifier);
  if (!m || !(await auth.checkLoginCode(m.code, String(req.body?.code || '').trim()))) return bad(res, 'That code is wrong or has expired', 401);
  await auth.startMemberSession(req, res, m.code);
  res.json({ ok: true });
}));

app.post('/api/m/logout', h(async (req, res) => {
  await auth.endMemberSession(req, res);
  res.json({ ok: true });
}));

const m = express.Router();
m.use(auth.requireMember);
app.use('/api/m', m);

m.get('/me', h(async (req, res) => {
  // Also issues the birthday reward lazily, so it appears even before the daily job runs.
  await L.issueBirthdayVoucher(req.member);
  const [summary, specials] = await Promise.all([L.memberSummary(req.member), activeSpecials()]);
  res.json({ member: publicMember(req.member), ...summary, specials });
}));

m.get('/qr.svg', h(async (req, res) => {
  const svg = await QRCode.toString(req.member.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=86400').send(svg);
}));

async function recentTransactions(code, limit) {
  const snap = await col('transactions').where('memberCode', '==', code).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

m.get('/history', h(async (req, res) => {
  const rows = (await recentTransactions(req.member.code, 60)).filter((t) => !t.undone).slice(0, 50);
  res.json(rows.map((t) => ({ type: t.type, qty: t.qty, created_at: iso(t.createdAt), program: t.programName || null, emoji: t.emoji || null, voucher: t.voucherTitle || null })));
}));

m.patch('/me', h(async (req, res) => {
  const b = req.body || {};
  const f = {};
  if (b.name !== undefined) {
    f.name = String(b.name).trim().slice(0, 80);
    if (!f.name) return bad(res, 'Name cannot be empty');
  }
  if (b.phone !== undefined) {
    f.phone = normalizePhone(b.phone);
    if (f.phone === undefined) return bad(res, "That phone number doesn't look right");
  }
  if (b.marketing_email !== undefined) f.marketingEmail = !!b.marketing_email;
  if (b.marketing_whatsapp !== undefined) f.marketingWhatsapp = !!b.marketing_whatsapp;
  // Birthday can be added once by the member (stops month-hopping for extra rewards); staff can fix it later.
  if (b.birthday && !req.member.birthMonth) {
    const bd = parseBirthday(b.birthday);
    if (!bd) return bad(res, "That birthday doesn't look right");
    Object.assign(f, { birthMonth: bd.month, birthDay: bd.day });
  }
  if (!Object.keys(f).length) return bad(res, 'Nothing to update');
  const updated = await updateMember(req.member.code, f);
  if (updated.marketingWhatsapp && !updated.phone) await col('members').doc(updated.code).update({ marketingWhatsapp: false });
  if (f.birthMonth) await L.issueBirthdayVoucher(updated);
  res.json({ ok: true });
}));

// POPIA: members can delete their data themselves.
m.delete('/me', h(async (req, res) => {
  const mem = req.member;
  const refs = [col('members').doc(mem.code), col('loginCodes').doc(mem.code)];
  if (mem.email) refs.push(col('memberEmails').doc(mem.email));
  if (mem.phone) refs.push(col('memberPhones').doc(mem.phone));
  for (const name of ['vouchers', 'transactions', 'memberSessions']) {
    const snap = await col(name).where(name === 'memberSessions' ? 'code' : 'memberCode', '==', mem.code).select().get();
    refs.push(...snap.docs.map((d) => d.ref));
  }
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  await auth.endMemberSession(req, res);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ staff API
const noStaff = async () => (await col('staff').limit(1).get()).empty;
app.get('/api/s/setup', h(async (_req, res) => res.json({ needed: await noStaff() })));
app.post('/api/s/setup', h(async (req, res) => {
  if (!(await noStaff())) return bad(res, 'Already set up');
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return bad(res, 'Name, email and an 8+ character password are required');
  await auth.createStaff({ name, email, password, role: 'admin' });
  await auth.staffLogin(req, res, email, password);
  res.json({ ok: true });
}));
app.post('/api/s/login', h(async (req, res) => {
  if (rateLimited('staff:' + req.ip, 20, 15 * 60e3)) return bad(res, 'Too many attempts — wait a few minutes', 429);
  if (!(await auth.staffLogin(req, res, req.body?.email || '', req.body?.password || ''))) return bad(res, 'Wrong email or password', 401);
  res.json({ ok: true });
}));
app.post('/api/s/logout', h(async (req, res) => {
  await auth.staffLogout(req, res);
  res.json({ ok: true });
}));

const s = express.Router();
s.use(auth.requireStaff);
app.use('/api/s', s);
const admin = auth.requireAdmin;

s.get('/me', h(async (req, res) => {
  const st = await L.getSettings();
  // Stamp rules the staff screen needs (managers aren't bound by the per-scan limit).
  const rules = { require_bill: st.requireBill, max_per_scan: req.staff.role === 'admin' ? MAX_STAMPS : Math.min(st.staffMaxPerScan, MAX_STAMPS), max_per_card_per_day: st.maxPerCardPerDay, visit_hours: st.visitHours };
  res.json({ ...req.staff, rules });
}));

const memberRow = (m) => ({ code: m.code, name: m.name, email: m.email || null, phone: m.phone || null, last_visit_at: iso(m.lastVisitAt), created_at: iso(m.createdAt) });

s.get('/members', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    const snap = await col('members').orderBy('activityAt', 'desc').limit(50).get();
    return res.json(snap.docs.map((d) => memberRow({ code: d.id, ...d.data() })));
  }
  const found = new Map();
  const exact = await findMember(q);
  if (exact) found.set(exact.code, exact);
  // Name search: prefix match on the full name (e.g. "an" finds "Anna Smith").
  const lq = q.toLowerCase();
  const snap = await col('members').where('nameLower', '>=', lq).where('nameLower', '<', lq + '').limit(50).get();
  snap.docs.forEach((d) => found.set(d.id, { code: d.id, ...d.data() }));
  res.json([...found.values()].map(memberRow));
}));

async function memberByCode(req, res, next) {
  try {
    req.target = await getMember(cleanCode(req.params.code));
    if (!req.target) return bad(res, 'No member with that code', 404);
    next();
  } catch (e) {
    next(e);
  }
}

async function staffMemberView(code) {
  const member = await getMember(code);
  await L.issueBirthdayVoucher(member);
  const [summary, recent] = await Promise.all([L.memberSummary(member), recentTransactions(code, 15)]);
  return {
    member: publicMember(member),
    ...summary,
    recent: recent.map((t) => ({
      id: t.id, type: t.type, qty: t.qty, created_at: iso(t.createdAt), undone: t.undone ? 1 : 0, program_id: t.programId || null,
      program: t.programName || null, emoji: t.emoji || null, voucher: t.voucherTitle || null, staff: t.staffName || null,
      bill_ref: t.billRef || null, outside_hours: !!t.outsideHours,
      can_undo: t.type === 'stamp' && !t.undone && member.lastStampTx?.[t.programId] === t.id && Date.now() - t.createdAt.toMillis() < L.UNDO_MINUTES * 60e3,
    })),
  };
}

s.get('/members/:code', memberByCode, h(async (req, res) => res.json(await staffMemberView(req.target.code))));

s.post('/members/:code/stamp', memberByCode, h(async (req, res) => {
  const qty = Number(req.body?.qty || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_STAMPS) return bad(res, `You can add 1–${MAX_STAMPS} stamps at a time`);
  const r = await L.addStamps(req.target.code, String(req.body?.program_id), qty, req.staff, { billRef: req.body?.bill_ref });
  res.json({ ...r, view: await staffMemberView(req.target.code) });
}));

s.post('/tx/:id/undo', h(async (req, res) => {
  await L.undoStamp(req.params.id);
  res.json({ ok: true });
}));

s.post('/members/:code/redeem', memberByCode, h(async (req, res) => {
  const v = await L.redeemVoucher(String(req.body?.voucher_id), req.target.code, req.staff);
  res.json({ ok: true, title: v.title, view: await staffMemberView(req.target.code) });
}));

s.post('/members/:code/gift', admin, memberByCode, h(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return bad(res, 'Describe the reward');
  await L.giftVoucher(req.target.code, title.slice(0, 120), Number(req.body?.valid_days || 30), req.staff);
  res.json({ ok: true, view: await staffMemberView(req.target.code) });
}));

s.patch('/members/:code', admin, memberByCode, h(async (req, res) => {
  const b = req.body || {};
  const f = {};
  if (b.name !== undefined) f.name = String(b.name).trim() || req.target.name;
  if (b.email !== undefined) {
    f.email = normalizeEmail(b.email);
    if (!f.email || !validEmail(f.email)) return bad(res, 'Enter a valid email');
  }
  if (b.phone !== undefined) {
    f.phone = normalizePhone(b.phone);
    if (f.phone === undefined) return bad(res, "That phone number doesn't look right");
  }
  if (b.birthday !== undefined) {
    const bd = parseBirthday(b.birthday);
    if (bd === undefined) return bad(res, "That birthday doesn't look right");
    Object.assign(f, { birthMonth: bd?.month ?? null, birthDay: bd?.day ?? null });
  }
  if (!Object.keys(f).length) return bad(res, 'Nothing to update');
  await updateMember(req.target.code, f);
  res.json({ ok: true, view: await staffMemberView(req.target.code) });
}));

// --- stamp cards
const programOut = (p) => ({ id: p.id, name: p.name, emoji: p.emoji, stamps_required: p.stampsRequired, reward: p.reward, reward_valid_days: p.rewardValidDays, active: p.active ? 1 : 0, sort: p.sort || 0 });
s.get('/programs', h(async (_req, res) => res.json((await L.listPrograms()).map(programOut))));
function programFields(b) {
  const f = {};
  if (b.name !== undefined) f.name = String(b.name).trim();
  if (b.reward !== undefined) f.reward = String(b.reward).trim();
  if (b.emoji !== undefined) f.emoji = String(b.emoji).trim().slice(0, 8) || '⭐';
  if (b.stamps_required !== undefined) f.stampsRequired = Number(b.stamps_required);
  if (b.reward_valid_days !== undefined) f.rewardValidDays = Number(b.reward_valid_days);
  if (b.active !== undefined) f.active = !!b.active;
  if (b.sort !== undefined) f.sort = Number(b.sort) || 0;
  if ('name' in f && !f.name) throw new L.UserError('Name is required');
  if ('reward' in f && !f.reward) throw new L.UserError('Reward is required');
  if ('stampsRequired' in f && !(f.stampsRequired >= 2 && f.stampsRequired <= 50)) throw new L.UserError('Stamps needed must be 2–50');
  if ('rewardValidDays' in f && !(f.rewardValidDays >= 1 && f.rewardValidDays <= 3650)) throw new L.UserError('Reward validity must be 1–3650 days');
  return f;
}
s.post('/programs', admin, h(async (req, res) => {
  const f = { emoji: '⭐', rewardValidDays: 90, active: true, sort: 0, ...programFields(req.body || {}) };
  if (!f.name || !f.reward || !f.stampsRequired) return bad(res, 'Name, stamps needed and reward are required');
  res.json({ id: (await col('programs').add(f)).id });
}));
s.patch('/programs/:id', admin, h(async (req, res) => {
  const f = programFields(req.body || {});
  if (!Object.keys(f).length) return bad(res, 'Nothing to update');
  await col('programs').doc(req.params.id).update(f);
  res.json({ ok: true });
}));

// --- specials
s.get('/specials', h(async (_req, res) => {
  const snap = await col('specials').get();
  res.json(
    snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.startsOn || iso(b.createdAt)).localeCompare(a.startsOn || iso(a.createdAt)))
      .map(specialOut)
  );
}));
function specialFields(b) {
  const date = (v) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new L.UserError('Dates must be YYYY-MM-DD');
    return v;
  };
  const url = b.image_url ? String(b.image_url).trim() : null;
  if (url && !/^https:\/\//.test(url)) throw new L.UserError('Image link must start with https://');
  const f = { title: String(b.title || '').trim(), body: String(b.body || '').trim(), imageUrl: url, startsOn: date(b.starts_on), endsOn: date(b.ends_on), pinned: !!b.pinned };
  if (!f.title) throw new L.UserError('Title is required');
  return f;
}
s.post('/specials', admin, h(async (req, res) => res.json({ id: (await col('specials').add({ ...specialFields(req.body || {}), createdAt: Timestamp.now() })).id })));
s.put('/specials/:id', admin, h(async (req, res) => {
  await col('specials').doc(req.params.id).update(specialFields(req.body || {}));
  res.json({ ok: true });
}));
s.delete('/specials/:id', admin, h(async (req, res) => {
  await col('specials').doc(req.params.id).delete();
  res.json({ ok: true });
}));

// --- dashboard
s.get('/stats', admin, h(async (_req, res) => {
  const count = async (q) => (await q.count().get()).data().count;
  const members = col('members');
  const [total, new30, active30, optEmail, optWhatsApp, txSnap, openSnap, programs] = await Promise.all([
    count(members),
    count(members.where('createdAt', '>=', daysAgo(30))),
    count(members.where('lastVisitAt', '>=', daysAgo(30))),
    count(members.where('marketingEmail', '==', true)),
    count(members.where('marketingWhatsapp', '==', true)),
    col('transactions').where('createdAt', '>=', daysAgo(90)).get(),
    col('vouchers').where('redeemedAt', '==', null).select('expiresAt').get(),
    L.listPrograms(),
  ]);
  const cutoff30 = daysAgo(30).toMillis();
  const daily = {}, perProgram = {}, perMember = {};
  let stamps30 = 0, redeemed30 = 0;
  for (const d of txSnap.docs) {
    const t = d.data();
    if (t.undone) continue;
    const ms = t.createdAt.toMillis();
    if (t.type === 'stamp') perMember[t.memberCode] = (perMember[t.memberCode] || 0) + t.qty;
    if (ms < cutoff30) continue;
    const day = (daily[L.localDay(t.createdAt.toDate())] ??= { stamps: 0, redeemed: 0 });
    const prog = t.programId ? (perProgram[t.programId] ??= { stamps30: 0, redeemed30: 0 }) : null;
    if (t.type === 'stamp') {
      stamps30 += t.qty;
      day.stamps += t.qty;
      if (prog) prog.stamps30 += t.qty;
    } else if (t.type === 'redeem') {
      redeemed30++;
      day.redeemed++;
      if (prog) prog.redeemed30++;
    }
  }
  const topCodes = Object.entries(perMember).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topDocs = topCodes.length ? await db.getAll(...topCodes.map(([c]) => col('members').doc(c))) : [];
  const t = L.today().iso;
  res.json({
    members: total, new30, active30, stamps30, redeemed30, optEmail, optWhatsApp,
    outstanding: openSnap.docs.filter((d) => !d.data().expiresAt || d.data().expiresAt >= t).length,
    daily: Object.entries(daily).sort().map(([day, v]) => ({ day, ...v })),
    programs: programs.map((p) => ({ name: p.name, emoji: p.emoji, active: p.active ? 1 : 0, ...(perProgram[p.id] || { stamps30: 0, redeemed30: 0 }) })),
    top: topCodes.map(([code, stamps], i) => ({ code, stamps, name: topDocs[i].exists ? topDocs[i].data().name : '(deleted)' })).filter((x) => x.name !== '(deleted)'),
  });
}));

s.get('/export.csv', admin, h(async (_req, res) => {
  const snap = await col('members').orderBy('createdAt').get();
  const cols = ['code', 'name', 'email', 'phone', 'birth_month', 'birth_day', 'marketing_email', 'marketing_whatsapp', 'created_at', 'last_visit_at', 'total_stamps', 'rewards_redeemed'];
  const rows = snap.docs.map((d) => {
    const m = d.data();
    return [d.id, m.name, m.email, m.phone, m.birthMonth, m.birthDay, m.marketingEmail ? 1 : 0, m.marketingWhatsapp ? 1 : 0, iso(m.createdAt), iso(m.lastVisitAt), m.totalStamps || 0, m.rewardsRedeemed || 0];
  });
  // Prefix cells that Excel would treat as formulas.
  const cell = (v) => {
    let x = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(x)) x = "'" + x;
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  res.attachment(`members-${L.today().iso}.csv`).type('text/csv').send([cols.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n'));
}));

// --- staff accounts
s.get('/staff', admin, h(async (_req, res) => {
  const snap = await col('staff').get();
  res.json(snap.docs.map((d) => ({ id: d.id, name: d.data().name, email: d.data().email, role: d.data().role })).sort((a, b) => a.name.localeCompare(b.name)));
}));
s.post('/staff', admin, h(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || password.length < 8) return bad(res, 'Name, email and an 8+ character password are required');
  try {
    res.json({ id: await auth.createStaff({ name, email, password, role }) });
  } catch (e) {
    if (e.message === 'EMAIL_TAKEN') return bad(res, 'That email is already in use');
    throw e;
  }
}));
s.delete('/staff/:id', admin, h(async (req, res) => {
  if (req.params.id === req.staff.id) return bad(res, "You can't remove yourself");
  const ref = col('staff').doc(req.params.id);
  const st = await ref.get();
  if (st.exists) {
    const sessions = await col('staffSessions').where('staffId', '==', st.id).select().get();
    const batch = db.batch();
    batch.delete(ref);
    batch.delete(col('staffEmails').doc(st.data().email));
    sessions.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  res.json({ ok: true });
}));

// --- settings
s.get('/settings', admin, h(async (req, res) => {
  const st = await L.getSettings();
  res.json({
    birthday_enabled: st.birthdayEnabled,
    birthday_reward: st.birthdayReward,
    require_bill: st.requireBill,
    bill_resets_daily: st.billResetsDaily,
    max_per_card_per_day: st.maxPerCardPerDay,
    staff_max_per_scan: st.staffMaxPerScan,
    visit_hours: st.visitHours,
    open_time: st.openTime,
    close_time: st.closeTime,
    bonus_min_checks: st.bonusMinChecks,
    bonus_min_new_regulars: st.bonusMinNewRegulars,
    channels: { email: notify.emailEnabled(), whatsapp: notify.whatsappEnabled() },
    whatsapp_templates: { otp: env.WHATSAPP_OTP_TEMPLATE || null, birthday: env.WHATSAPP_BIRTHDAY_TEMPLATE || null },
    signup_url: baseUrl(req),
  });
}));
s.patch('/settings', admin, h(async (req, res) => {
  const b = req.body || {};
  const f = {};
  if (b.birthday_enabled !== undefined) f.birthdayEnabled = !!b.birthday_enabled;
  if (b.birthday_reward) f.birthdayReward = String(b.birthday_reward).trim().slice(0, 120);
  if (b.require_bill !== undefined) f.requireBill = !!b.require_bill;
  if (b.bill_resets_daily !== undefined) f.billResetsDaily = !!b.bill_resets_daily;
  const int = (key, field, min, max, label) => {
    if (b[key] === undefined) return;
    const v = Number(b[key]);
    if (!Number.isInteger(v) || v < min || v > max) throw new L.UserError(`${label} must be ${min}–${max}`);
    f[field] = v;
  };
  int('max_per_card_per_day', 'maxPerCardPerDay', 1, 50, 'Daily stamps per card');
  int('staff_max_per_scan', 'staffMaxPerScan', 1, MAX_STAMPS, 'Staff stamps per scan');
  int('visit_hours', 'visitHours', 0, 24, 'Hours between stamps on a card');
  int('bonus_min_checks', 'bonusMinChecks', 0, 100, 'Spot checks needed');
  int('bonus_min_new_regulars', 'bonusMinNewRegulars', 0, 500, 'New regulars needed');
  for (const [key, field] of [['open_time', 'openTime'], ['close_time', 'closeTime']]) {
    if (b[key] === undefined) continue;
    if (b[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b[key])) throw new L.UserError('Times must be HH:MM, e.g. 10:00');
    f[field] = b[key] || '';
  }
  await L.saveSettings(f);
  res.json({ ok: true });
}));

// --- marketing campaigns (only to members who opted in on that channel)
const AUDIENCES = {
  all: () => true,
  active30: (m) => m.lastVisitAt && m.lastVisitAt.toMillis() >= daysAgo(30).toMillis(),
  lapsed60: (m) => !m.lastVisitAt || m.lastVisitAt.toMillis() < daysAgo(60).toMillis(),
  birthday_month: (m) => m.birthMonth === L.today().m,
};
async function optedIn(channel) {
  const snap = await col('members').where(channel === 'email' ? 'marketingEmail' : 'marketingWhatsapp', '==', true).get();
  return snap.docs.map((d) => ({ code: d.id, ...d.data() })).filter((m) => (channel === 'email' ? m.email : m.phone));
}

s.get('/campaigns', admin, h(async (_req, res) => {
  const [email, whatsapp, history] = await Promise.all([optedIn('email'), optedIn('whatsapp'), col('campaigns').orderBy('createdAt', 'desc').limit(30).get()]);
  const counts = {};
  for (const [ch, list] of [['email', email], ['whatsapp', whatsapp]]) for (const [a, fn] of Object.entries(AUDIENCES)) counts[`${ch}:${a}`] = list.filter(fn).length;
  res.json({
    counts,
    history: history.docs.map((d) => {
      const c = d.data();
      return { id: d.id, channel: c.channel, subject: c.subject, template: c.template, audience: c.audience, sent: c.sent || 0, failed: c.failed || 0, status: c.status, staff: c.staffName, created_at: iso(c.createdAt) };
    }),
  });
}));

// Saving the campaign queues it; the sendCampaign function (index.js) does the sending.
s.post('/campaigns', admin, h(async (req, res) => {
  const { channel, audience, subject, body, template } = req.body || {};
  if (!['email', 'whatsapp'].includes(channel)) return bad(res, 'Choose email or WhatsApp');
  if (!AUDIENCES[audience]) return bad(res, 'Unknown audience');
  if (channel === 'email' && (!subject || !body)) return bad(res, 'Subject and message are required');
  if (channel === 'whatsapp' && !template) return bad(res, 'Enter the approved WhatsApp template name');
  if (channel === 'email' && !notify.emailEnabled()) return bad(res, 'Email is not configured on the server');
  if (channel === 'whatsapp' && !notify.whatsappEnabled()) return bad(res, 'WhatsApp is not configured on the server');
  const recipients = (await optedIn(channel)).filter(AUDIENCES[audience]);
  if (!recipients.length) return bad(res, 'No opted-in members in that audience');
  const ref = await col('campaigns').add({
    channel, audience, subject: subject || null, body: body || null, template: template || null, usesName: !!req.body.uses_name,
    baseUrl: baseUrl(req), staffId: req.staff.id, staffName: req.staff.name, status: 'queued', sent: 0, failed: 0, createdAt: Timestamp.now(),
  });
  res.json({ ok: true, id: ref.id, recipients: recipients.length });
}));

// --- staff integrity: scorecards, flags, bill spot checks
const periodDays = (q) => (Number(q) === 7 ? 7 : 30);
s.get('/integrity', admin, h(async (req, res) => res.json(await integrity.integrityReport(periodDays(req.query.days)))));
s.post('/bills/:id/audit', admin, h(async (req, res) => {
  await integrity.auditBill(req.params.id, req.body?.result, req.body?.note, req.staff);
  res.json({ ok: true });
}));
s.get('/bills.csv', admin, h(async (req, res) => {
  const days = periodDays(req.query.days);
  res.attachment(`bills-last-${days}-days-${L.today().iso}.csv`).type('text/csv').send(await integrity.billsCsv(days));
}));

// --- printable sign-up poster with a QR code that opens the join page
s.get('/poster', admin, h(async (req, res) => {
  const url = baseUrl(req);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1f4d3a', light: '#ffffff' } });
  const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${e(BRAND)} Rewards poster</title>
  <style>@page{size:A4;margin:0}body{margin:0;font-family:system-ui,sans-serif;color:#1e2420}
  .p{width:210mm;min-height:297mm;box-sizing:border-box;padding:22mm 18mm;text-align:center;background:#f6f1e7;display:flex;flex-direction:column;align-items:center}
  h1{font-family:Georgia,serif;font-size:58px;color:#1f4d3a;margin:0}.logo{width:150mm;margin:0 auto}.logo svg{display:block;width:100%;height:auto}.sub{letter-spacing:.3em;text-transform:uppercase;color:#a8862f;font-weight:700;margin:6px 0 26px}
  .big{font-size:30px;font-weight:700;margin:0 0 24px}.qr{background:#fff;padding:22px;border-radius:24px;width:110mm;border:3px solid #c8a24a}.qr svg{display:block;width:100%;height:auto}
  ol{text-align:left;font-size:20px;line-height:1.7;margin:28px auto 0;max-width:140mm}.url{margin-top:auto;color:#6c736e;font-size:16px}
  @media screen{body{background:#ddd}.p{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.2)}}</style></head>
  <body onload="setTimeout(()=>print(),300)"><div class="p"><div class="logo">${LOGO_INK}</div><div class="sub">Rewards</div>
  <p class="big">Scan to join — it's free!</p><div class="qr">${qr}</div>
  <ol><li>Scan the code with your phone camera</li><li>Show your card every time you order</li><li>Fill a card &rarr; get a reward 🎁 &nbsp;Plus a birthday treat 🎂</li></ol>
  <div class="url">${e(url.replace(/^https?:\/\//, ''))}</div></div></body></html>`);
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong — please try again' });
});

module.exports = { app };
