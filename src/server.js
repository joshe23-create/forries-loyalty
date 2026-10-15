require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const auth = require('./auth');
const L = require('./loyalty');
const notify = require('./notify');

const env = process.env;
const BRAND = env.BRAND_NAME || 'Forries';
const DEMO = env.DEMO_MODE === 'true';
const MAX_STAMPS = Number(env.MAX_STAMPS_PER_SCAN || 10);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));

const baseUrl = (req) => env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

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
function newMemberCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!db.prepare('SELECT 1 FROM members WHERE code = ?').get(code)) return code;
  }
}

function findMember(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) return db.prepare('SELECT * FROM members WHERE email = ?').get(normalizeEmail(id));
  const phone = normalizePhone(id);
  if (phone) {
    const m = db.prepare('SELECT * FROM members WHERE phone = ?').get(phone);
    if (m) return m;
  }
  return db.prepare('SELECT * FROM members WHERE code = ?').get(id.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

// Simple in-memory limiter for login-code requests.
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

function activeSpecials() {
  const t = L.today().iso;
  return db
    .prepare(
      `SELECT id, title, body, image_url, starts_on, ends_on, pinned FROM specials
       WHERE (starts_on IS NULL OR starts_on <= ?) AND (ends_on IS NULL OR ends_on >= ?)
       ORDER BY pinned DESC, COALESCE(starts_on, created_at) DESC`
    )
    .all(t, t);
}

const publicMember = (m) => ({
  code: m.code, name: m.name, email: m.email, phone: m.phone,
  birthday: m.birth_month ? `${String(m.birth_month).padStart(2, '0')}-${String(m.birth_day).padStart(2, '0')}` : null,
  marketing_email: !!m.marketing_email, marketing_whatsapp: !!m.marketing_whatsapp, created_at: m.created_at,
});

// ------------------------------------------------------------------ public
app.get('/healthz', (_req, res) => res.json({ ok: !!db.prepare('SELECT 1 ok').get() }));
app.get('/api/brand', (_req, res) =>
  res.json({
    name: BRAND,
    tagline: env.BRAND_TAGLINE || 'Collect stamps, earn rewards.',
    demo: DEMO,
    loginVia: { email: notify.emailEnabled(), whatsapp: notify.whatsappEnabled() && !!env.WHATSAPP_OTP_TEMPLATE },
    privacyUrl: env.PRIVACY_URL || null,
  })
);
app.get('/api/specials', (_req, res) => res.json(activeSpecials()));

app.get('/unsubscribe', (req, res) => {
  const { c, t } = req.query;
  const m = c && db.prepare('SELECT * FROM members WHERE code = ?').get(String(c));
  const ok = m && t && crypto.timingSafeEqual(Buffer.from(String(t).padEnd(24).slice(0, 24)), Buffer.from(auth.unsubToken(m.code)));
  if (ok) db.prepare('UPDATE members SET marketing_email = 0 WHERE id = ?').run(m.id);
  res.type('html').send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${BRAND}</title>
     <body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center">
     <h1>${ok ? "You're unsubscribed" : 'Link not valid'}</h1>
     <p>${ok ? `You won't get marketing emails from ${BRAND} any more. Your stamps and rewards are unaffected.` : 'Please manage your preferences in the app.'}</p>
     <p><a href="/">Open my card</a></p></body>`
  );
});
// One-click unsubscribe (RFC 8058) posts here.
app.post('/unsubscribe', express.urlencoded({ extended: false }), (req, res) => {
  const { c, t } = req.query;
  const m = c && db.prepare('SELECT * FROM members WHERE code = ?').get(String(c));
  if (m && t === auth.unsubToken(m.code)) db.prepare('UPDATE members SET marketing_email = 0 WHERE id = ?').run(m.id);
  res.sendStatus(200);
});

// ------------------------------------------------------------------ member API
app.post('/api/m/signup', (req, res) => {
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
  if (db.prepare('SELECT 1 FROM members WHERE email = ? OR (phone IS NOT NULL AND phone = ?)').get(email, phone))
    return bad(res, "You're already a member — sign in instead", 409);

  const id = db
    .prepare(
      `INSERT INTO members (code, name, email, phone, birth_month, birth_day, marketing_email, marketing_whatsapp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newMemberCode(), name, email, phone, birthday?.month ?? null, birthday?.day ?? null, b.marketing_email ? 1 : 0, b.marketing_whatsapp && phone ? 1 : 0)
    .lastInsertRowid;
  L.issueBirthdayVoucher(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
  auth.startMemberSession(res, id);
  res.json({ ok: true });
});

app.post('/api/m/login', async (req, res) => {
  const identifier = String(req.body?.identifier || '');
  if (rateLimited('ip:' + req.ip, 20, 15 * 60e3) || rateLimited('id:' + identifier.toLowerCase(), 5, 15 * 60e3))
    return bad(res, 'Too many attempts — please wait a few minutes', 429);
  const m = findMember(identifier);
  if (!m) return bad(res, "We couldn't find a membership with that email or number", 404);
  const code = auth.issueLoginCode(m.id);
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
  if (!sentVia) console.log(`[demo] login code for ${m.email}: ${code}`);
  const where = sentVia === 'email' ? m.email.replace(/^(.).*(@.*)$/, '$1•••$2') : sentVia === 'whatsapp' ? 'WhatsApp •••' + m.phone.slice(-4) : null;
  res.json({ ok: true, sentVia, where, demoCode: DEMO && !sentVia ? code : undefined });
});

app.post('/api/m/verify', (req, res) => {
  const m = findMember(req.body?.identifier);
  if (!m || !auth.checkLoginCode(m.id, String(req.body?.code || '').trim())) return bad(res, 'That code is wrong or has expired', 401);
  auth.startMemberSession(res, m.id);
  res.json({ ok: true });
});

app.post('/api/m/logout', (req, res) => {
  auth.endMemberSession(req, res);
  res.json({ ok: true });
});

const m = express.Router();
m.use(auth.requireMember);
app.use('/api/m', m);

m.get('/me', (req, res) => res.json({ member: publicMember(req.member), ...L.memberSummary(req.member.id), specials: activeSpecials() }));

m.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(req.member.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=86400').send(svg);
});

m.get('/history', (req, res) =>
  res.json(
    db
      .prepare(
        `SELECT t.type, t.qty, t.created_at, p.name program, p.emoji, v.title voucher FROM transactions t
         LEFT JOIN programs p ON p.id = t.program_id LEFT JOIN vouchers v ON v.id = t.voucher_id
         WHERE t.member_id = ? AND t.undone = 0 ORDER BY t.id DESC LIMIT 50`
      )
      .all(req.member.id)
  )
);

m.patch('/me', (req, res) => {
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
  if (b.marketing_email !== undefined) f.marketing_email = b.marketing_email ? 1 : 0;
  if (b.marketing_whatsapp !== undefined) f.marketing_whatsapp = b.marketing_whatsapp ? 1 : 0;
  // Birthday can be added once by the member (stops month-hopping for extra rewards); staff can fix it later.
  if (b.birthday && !req.member.birth_month) {
    const bd = parseBirthday(b.birthday);
    if (!bd) return bad(res, "That birthday doesn't look right");
    Object.assign(f, { birth_month: bd.month, birth_day: bd.day });
  }
  if (!Object.keys(f).length) return bad(res, 'Nothing to update');
  try {
    db.prepare(`UPDATE members SET ${Object.keys(f).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: req.member.id });
  } catch {
    return bad(res, 'That phone number belongs to another member');
  }
  const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id);
  if (updated.marketing_whatsapp && !updated.phone) db.prepare('UPDATE members SET marketing_whatsapp = 0 WHERE id = ?').run(updated.id);
  if (f.birth_month) L.issueBirthdayVoucher(updated);
  res.json({ ok: true });
});

// POPIA: members can delete their data themselves.
m.delete('/me', (req, res) => {
  db.prepare('DELETE FROM members WHERE id = ?').run(req.member.id);
  auth.endMemberSession(req, res);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ staff API
const noStaff = () => db.prepare('SELECT COUNT(*) n FROM staff').get().n === 0;
app.get('/api/s/setup', (_req, res) => res.json({ needed: noStaff() }));
app.post('/api/s/setup', (req, res) => {
  if (!noStaff()) return bad(res, 'Already set up');
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return bad(res, 'Name, email and an 8+ character password are required');
  auth.createStaff({ name, email, password, role: 'admin' });
  auth.staffLogin(res, email, password);
  res.json({ ok: true });
});
app.post('/api/s/login', (req, res) => {
  if (rateLimited('staff:' + req.ip, 20, 15 * 60e3)) return bad(res, 'Too many attempts — wait a few minutes', 429);
  if (!auth.staffLogin(res, req.body?.email || '', req.body?.password || '')) return bad(res, 'Wrong email or password', 401);
  res.json({ ok: true });
});
app.post('/api/s/logout', (req, res) => {
  auth.staffLogout(req, res);
  res.json({ ok: true });
});

const s = express.Router();
s.use(auth.requireStaff);
app.use('/api/s', s);
const admin = auth.requireAdmin;

s.get('/me', (req, res) => res.json(req.staff));

s.get('/members', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const phone = normalizePhone(q) || '-';
  res.json(
    db
      .prepare(
        `SELECT code, name, email, phone, last_visit_at, created_at FROM members
         WHERE ? = '' OR name LIKE ? OR email LIKE ? OR phone LIKE ? OR phone = ? OR code = ?
         ORDER BY COALESCE(last_visit_at, created_at) DESC LIMIT 50`
      )
      .all(q, like, like, like, phone, q.toUpperCase())
  );
});

function memberByCode(req, res, next) {
  req.target = db.prepare('SELECT * FROM members WHERE code = ?').get(String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (!req.target) return bad(res, 'No member with that code', 404);
  next();
}

function staffMemberView(member) {
  const recent = db
    .prepare(
      `SELECT t.id, t.type, t.qty, t.created_at, t.undone, t.program_id, p.name program, p.emoji, v.title voucher, st.name staff
       FROM transactions t LEFT JOIN programs p ON p.id = t.program_id LEFT JOIN vouchers v ON v.id = t.voucher_id
       LEFT JOIN staff st ON st.id = t.staff_id WHERE t.member_id = ? ORDER BY t.id DESC LIMIT 15`
    )
    .all(member.id);
  const latestByCard = {};
  for (const t of recent) {
    if (t.type !== 'stamp' || t.undone) continue;
    if (latestByCard[t.program_id] === undefined) latestByCard[t.program_id] = t.id;
    const ageMin = (Date.now() - Date.parse(t.created_at.replace(' ', 'T') + 'Z')) / 60e3;
    t.can_undo = latestByCard[t.program_id] === t.id && ageMin < L.UNDO_MINUTES;
  }
  return { member: publicMember(member), ...L.memberSummary(member.id), recent };
}

s.get('/members/:code', memberByCode, (req, res) => res.json(staffMemberView(req.target)));

s.post('/members/:code/stamp', memberByCode, (req, res) => {
  const qty = Number(req.body?.qty || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_STAMPS) return bad(res, `You can add 1–${MAX_STAMPS} stamps at a time`);
  try {
    const r = L.addStamps(req.target.id, Number(req.body?.program_id), qty, req.staff.id);
    res.json({ ...r, view: staffMemberView(req.target) });
  } catch (e) {
    bad(res, e.message);
  }
});

s.post('/tx/:id/undo', (req, res) => {
  try {
    L.undoStamp(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});

s.post('/members/:code/redeem', memberByCode, (req, res) => {
  try {
    const v = L.redeemVoucher(Number(req.body?.voucher_id), req.target.id, req.staff.id);
    res.json({ ok: true, title: v.title, view: staffMemberView(req.target) });
  } catch (e) {
    bad(res, e.message);
  }
});

s.post('/members/:code/gift', admin, memberByCode, (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return bad(res, 'Describe the reward');
  L.giftVoucher(req.target.id, title.slice(0, 120), Number(req.body?.valid_days || 30), req.staff.id);
  res.json({ ok: true, view: staffMemberView(req.target) });
});

s.patch('/members/:code', admin, memberByCode, (req, res) => {
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
    Object.assign(f, { birth_month: bd?.month ?? null, birth_day: bd?.day ?? null });
  }
  if (!Object.keys(f).length) return bad(res, 'Nothing to update');
  try {
    db.prepare(`UPDATE members SET ${Object.keys(f).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: req.target.id });
  } catch {
    return bad(res, 'Another member already has that email or phone');
  }
  const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(req.target.id);
  L.issueBirthdayVoucher(updated);
  res.json({ ok: true, view: staffMemberView(updated) });
});

// --- stamp cards
s.get('/programs', (_req, res) => res.json(db.prepare('SELECT * FROM programs ORDER BY active DESC, sort, id').all()));
function programFields(b) {
  const f = {};
  if (b.name !== undefined) f.name = String(b.name).trim();
  if (b.reward !== undefined) f.reward = String(b.reward).trim();
  if (b.emoji !== undefined) f.emoji = String(b.emoji).trim().slice(0, 8) || '⭐';
  if (b.stamps_required !== undefined) f.stamps_required = Number(b.stamps_required);
  if (b.reward_valid_days !== undefined) f.reward_valid_days = Number(b.reward_valid_days);
  if (b.active !== undefined) f.active = b.active ? 1 : 0;
  if (b.sort !== undefined) f.sort = Number(b.sort) || 0;
  if ('name' in f && !f.name) throw new Error('Name is required');
  if ('reward' in f && !f.reward) throw new Error('Reward is required');
  if ('stamps_required' in f && !(f.stamps_required >= 2 && f.stamps_required <= 50)) throw new Error('Stamps needed must be 2–50');
  if ('reward_valid_days' in f && !(f.reward_valid_days >= 1 && f.reward_valid_days <= 3650)) throw new Error('Reward validity must be 1–3650 days');
  return f;
}
s.post('/programs', admin, (req, res) => {
  try {
    const f = { emoji: '⭐', reward_valid_days: 90, ...programFields(req.body || {}) };
    if (!f.name || !f.reward || !f.stamps_required) return bad(res, 'Name, stamps needed and reward are required');
    const cols = Object.keys(f);
    res.json({ id: db.prepare(`INSERT INTO programs (${cols}) VALUES (${cols.map((c) => '@' + c)})`).run(f).lastInsertRowid });
  } catch (e) {
    bad(res, e.message);
  }
});
s.patch('/programs/:id', admin, (req, res) => {
  try {
    const f = programFields(req.body || {});
    if (!Object.keys(f).length) return bad(res, 'Nothing to update');
    db.prepare(`UPDATE programs SET ${Object.keys(f).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});

// --- specials
s.get('/specials', (_req, res) => res.json(db.prepare('SELECT * FROM specials ORDER BY pinned DESC, COALESCE(starts_on, created_at) DESC').all()));
function specialFields(b) {
  const date = (v) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : (() => { throw new Error('Dates must be YYYY-MM-DD'); })()) : null);
  const url = b.image_url ? String(b.image_url).trim() : null;
  if (url && !/^https:\/\//.test(url)) throw new Error('Image link must start with https://');
  return { title: String(b.title || '').trim(), body: String(b.body || '').trim(), image_url: url, starts_on: date(b.starts_on), ends_on: date(b.ends_on), pinned: b.pinned ? 1 : 0 };
}
s.post('/specials', admin, (req, res) => {
  try {
    const f = specialFields(req.body || {});
    if (!f.title) return bad(res, 'Title is required');
    res.json({ id: db.prepare('INSERT INTO specials (title, body, image_url, starts_on, ends_on, pinned) VALUES (@title, @body, @image_url, @starts_on, @ends_on, @pinned)').run(f).lastInsertRowid });
  } catch (e) {
    bad(res, e.message);
  }
});
s.put('/specials/:id', admin, (req, res) => {
  try {
    const f = specialFields(req.body || {});
    if (!f.title) return bad(res, 'Title is required');
    db.prepare('UPDATE specials SET title=@title, body=@body, image_url=@image_url, starts_on=@starts_on, ends_on=@ends_on, pinned=@pinned WHERE id=@id').run({ ...f, id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});
s.delete('/specials/:id', admin, (req, res) => {
  db.prepare('DELETE FROM specials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- dashboard
s.get('/stats', admin, (_req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).n || 0;
  // '+2 hours' = South African time (no daylight saving), so days split at local midnight.
  const daily = db
    .prepare(
      `SELECT date(created_at, '+2 hours') day, SUM(CASE WHEN type='stamp' THEN qty ELSE 0 END) stamps, SUM(type='redeem') redeemed
       FROM transactions WHERE undone = 0 AND created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day`
    )
    .all();
  res.json({
    members: one('SELECT COUNT(*) n FROM members'),
    new30: one(`SELECT COUNT(*) n FROM members WHERE created_at >= datetime('now', '-30 days')`),
    active30: one(`SELECT COUNT(*) n FROM members WHERE last_visit_at >= datetime('now', '-30 days')`),
    stamps30: one(`SELECT SUM(qty) n FROM transactions WHERE type='stamp' AND undone=0 AND created_at >= datetime('now', '-30 days')`),
    redeemed30: one(`SELECT COUNT(*) n FROM transactions WHERE type='redeem' AND created_at >= datetime('now', '-30 days')`),
    optEmail: one('SELECT COUNT(*) n FROM members WHERE marketing_email = 1'),
    optWhatsApp: one('SELECT COUNT(*) n FROM members WHERE marketing_whatsapp = 1'),
    outstanding: one(`SELECT COUNT(*) n FROM vouchers WHERE redeemed_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`, L.today().iso),
    daily,
    programs: db
      .prepare(
        `SELECT p.name, p.emoji, p.active,
           (SELECT COALESCE(SUM(qty),0) FROM transactions t WHERE t.program_id = p.id AND t.type='stamp' AND t.undone=0 AND t.created_at >= datetime('now','-30 days')) stamps30,
           (SELECT COUNT(*) FROM transactions t WHERE t.program_id = p.id AND t.type='redeem' AND t.created_at >= datetime('now','-30 days')) redeemed30
         FROM programs p ORDER BY p.active DESC, p.sort, p.id`
      )
      .all(),
    top: db
      .prepare(
        `SELECT m.name, m.code, SUM(t.qty) stamps FROM transactions t JOIN members m ON m.id = t.member_id
         WHERE t.type='stamp' AND t.undone=0 AND t.created_at >= datetime('now','-90 days') GROUP BY m.id ORDER BY stamps DESC LIMIT 10`
      )
      .all(),
  });
});

s.get('/export.csv', admin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT m.code, m.name, m.email, m.phone, m.birth_month, m.birth_day, m.marketing_email, m.marketing_whatsapp, m.created_at, m.last_visit_at,
         (SELECT COALESCE(SUM(qty),0) FROM transactions t WHERE t.member_id = m.id AND t.type='stamp' AND t.undone=0) total_stamps,
         (SELECT COUNT(*) FROM transactions t WHERE t.member_id = m.id AND t.type='redeem') rewards_redeemed
       FROM members m ORDER BY m.id`
    )
    .all();
  const cols = Object.keys(rows[0] || { code: 0 });
  // Prefix cells that Excel would treat as formulas.
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.attachment(`members-${L.today().iso}.csv`).type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
});

// --- staff accounts
s.get('/staff', admin, (_req, res) => res.json(db.prepare('SELECT id, name, email, role FROM staff ORDER BY name').all()));
s.post('/staff', admin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || password.length < 8) return bad(res, 'Name, email and an 8+ character password are required');
  try {
    res.json({ id: auth.createStaff({ name, email, password, role }) });
  } catch {
    bad(res, 'That email is already in use');
  }
});
s.delete('/staff/:id', admin, (req, res) => {
  if (Number(req.params.id) === req.staff.id) return bad(res, "You can't remove yourself");
  db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- settings
s.get('/settings', admin, (_req, res) =>
  res.json({
    birthday_enabled: L.birthdayEnabled(),
    birthday_reward: L.birthdayReward(),
    channels: { email: notify.emailEnabled(), whatsapp: notify.whatsappEnabled() },
    whatsapp_templates: { otp: env.WHATSAPP_OTP_TEMPLATE || null, birthday: env.WHATSAPP_BIRTHDAY_TEMPLATE || null },
    signup_url: env.PUBLIC_URL || null,
  })
);
s.patch('/settings', admin, (req, res) => {
  const b = req.body || {};
  if (b.birthday_enabled !== undefined) L.setSetting('birthday_enabled', b.birthday_enabled ? '1' : '0');
  if (b.birthday_reward) L.setSetting('birthday_reward', String(b.birthday_reward).trim().slice(0, 120));
  res.json({ ok: true });
});

// --- marketing campaigns (only to members who opted in on that channel)
const AUDIENCES = {
  all: '1 = 1',
  active30: `last_visit_at >= datetime('now', '-30 days')`,
  lapsed60: `(last_visit_at IS NULL OR last_visit_at < datetime('now', '-60 days'))`,
  birthday_month: `birth_month = CAST(strftime('%m', 'now', '+2 hours') AS INTEGER)`,
};
function audienceQuery(channel, audience) {
  const where = AUDIENCES[audience];
  if (!where) throw new Error('Unknown audience');
  return channel === 'email'
    ? `SELECT * FROM members WHERE marketing_email = 1 AND email IS NOT NULL AND ${where}`
    : `SELECT * FROM members WHERE marketing_whatsapp = 1 AND phone IS NOT NULL AND ${where}`;
}

s.get('/campaigns', admin, (req, res) => {
  const counts = {};
  for (const ch of ['email', 'whatsapp']) for (const a of Object.keys(AUDIENCES)) counts[`${ch}:${a}`] = db.prepare(audienceQuery(ch, a).replace('SELECT *', 'SELECT COUNT(*) n')).get().n;
  res.json({
    counts,
    history: db.prepare('SELECT c.*, st.name staff FROM campaigns c LEFT JOIN staff st ON st.id = c.staff_id ORDER BY c.id DESC LIMIT 30').all(),
  });
});

s.post('/campaigns', admin, (req, res) => {
  const { channel, audience, subject, body, template } = req.body || {};
  if (!['email', 'whatsapp'].includes(channel)) return bad(res, 'Choose email or WhatsApp');
  if (channel === 'email' && (!subject || !body)) return bad(res, 'Subject and message are required');
  if (channel === 'whatsapp' && !template) return bad(res, 'Enter the approved WhatsApp template name');
  if (channel === 'email' && !notify.emailEnabled()) return bad(res, 'Email is not configured on the server');
  if (channel === 'whatsapp' && !notify.whatsappEnabled()) return bad(res, 'WhatsApp is not configured on the server');
  let recipients;
  try {
    recipients = db.prepare(audienceQuery(channel, audience)).all();
  } catch (e) {
    return bad(res, e.message);
  }
  if (!recipients.length) return bad(res, 'No opted-in members in that audience');
  const id = db
    .prepare('INSERT INTO campaigns (channel, subject, body, template, audience, staff_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channel, subject || null, body || null, template || null, audience, req.staff.id).lastInsertRowid;
  res.json({ ok: true, id, recipients: recipients.length });

  // Send in the background, gently, so we don't trip provider rate limits.
  const base = baseUrl(req);
  (async () => {
    let sent = 0, failed = 0;
    for (const r of recipients) {
      const first = r.name.split(' ')[0];
      try {
        if (channel === 'email') {
          const unsub = `${base}/unsubscribe?c=${r.code}&t=${auth.unsubToken(r.code)}`;
          await notify.sendEmail({
            to: r.email,
            subject: subject.replace(/\{\{\s*name\s*\}\}/g, first),
            text: `${body.replace(/\{\{\s*name\s*\}\}/g, first)}\n\n—\nView your loyalty card: ${base}\nUnsubscribe from ${BRAND} emails: ${unsub}`,
            unsubscribeUrl: unsub,
          });
        } else {
          await notify.sendWhatsAppTemplate({ to: r.phone, template, params: req.body.uses_name ? [first] : [] });
        }
        sent++;
      } catch (e) {
        failed++;
        console.error(`[campaign ${id}] ${channel} to member ${r.id} failed:`, e.message);
      }
      db.prepare('UPDATE campaigns SET sent = ?, failed = ? WHERE id = ?').run(sent, failed, id);
      await new Promise((ok) => setTimeout(ok, channel === 'email' ? 300 : 100));
    }
  })();
});

// --- printable sign-up poster with a QR code that opens the join page
s.get('/poster', admin, async (req, res) => {
  const url = baseUrl(req);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1f4d3a', light: '#ffffff' } });
  const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${e(BRAND)} Rewards poster</title>
  <style>@page{size:A4;margin:0}body{margin:0;font-family:system-ui,sans-serif;color:#1e2420}
  .p{width:210mm;min-height:297mm;box-sizing:border-box;padding:22mm 18mm;text-align:center;background:#f6f1e7;display:flex;flex-direction:column;align-items:center}
  h1{font-family:Georgia,serif;font-size:58px;color:#1f4d3a;margin:0}.sub{letter-spacing:.3em;text-transform:uppercase;color:#a8862f;font-weight:700;margin:6px 0 26px}
  .big{font-size:30px;font-weight:700;margin:0 0 24px}.qr{background:#fff;padding:22px;border-radius:24px;width:110mm;border:3px solid #c8a24a}.qr svg{display:block;width:100%;height:auto}
  ol{text-align:left;font-size:20px;line-height:1.7;margin:28px auto 0;max-width:140mm}.url{margin-top:auto;color:#6c736e;font-size:16px}
  @media screen{body{background:#ddd}.p{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.2)}}</style></head>
  <body onload="setTimeout(()=>print(),300)"><div class="p"><h1>${e(BRAND)}</h1><div class="sub">Rewards</div>
  <p class="big">Scan to join — it's free!</p><div class="qr">${qr}</div>
  <ol><li>Scan the code with your phone camera</li><li>Show your card every time you order</li><li>Fill a card &rarr; get a reward 🎁 &nbsp;Plus a birthday treat 🎂</li></ol>
  <div class="url">${e(url.replace(/^https?:\/\//, ''))}</div></div></body></html>`);
});

// ------------------------------------------------------------------ static
app.get('/manifest.webmanifest', (_req, res) =>
  res.type('application/manifest+json').json({
    name: `${BRAND} Rewards`,
    short_name: BRAND,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f1e7',
    theme_color: '#1f4d3a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
);
app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
app.get('/staff', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'staff.html')));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`${BRAND} loyalty running on http://localhost:${port}  (staff: /staff)`);
  console.log(`[email] ${notify.emailEnabled() ? 'enabled' : 'not configured'}; [whatsapp] ${notify.whatsappEnabled() ? 'enabled' : 'not configured'}${DEMO ? '; DEMO_MODE on' : ''}`);
  const birthdays = () => L.runBirthdays(env.PUBLIC_URL || `http://localhost:${port}`).catch((e) => console.error('[birthday]', e));
  birthdays();
  setInterval(birthdays, 6 * 3600e3);
});
