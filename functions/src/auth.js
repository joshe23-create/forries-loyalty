const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, col, Timestamp } = require('./db');

// Firebase Hosting strips every cookie except "__session" before calling the function,
// so member and staff sessions share that one cookie: "m.<token>~s.<token>".
const COOKIE = '__session';

function readSessionCookie(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  const value = raw ? decodeURIComponent(raw.slice(COOKIE.length + 1)) : '';
  const out = {};
  for (const part of value.split('~')) {
    const [k, v] = [part.slice(0, 1), part.slice(2)];
    if ((k === 'm' || k === 's') && v) out[k] = v;
  }
  return out;
}

function writeSessionCookie(req, res, kind, token) {
  const parts = { ...readSessionCookie(req), ...(res.locals.session || {}) };
  if (token) parts[kind] = token;
  else delete parts[kind];
  res.locals.session = parts;
  const value = Object.entries(parts).map(([k, v]) => `${k}.${v}`).join('~');
  const secure = process.env.COOKIE_SECURE === 'false' ? '' : '; Secure';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 365 * 86400 : 0}${secure}`);
}

const newToken = () => crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const inDays = (d) => Timestamp.fromMillis(Date.now() + d * 86400e3);

// ------------------------------------------------------------------ members
// Members stay signed in for a year so the card is always one tap away.
async function startMemberSession(req, res, code) {
  const token = newToken();
  await col('memberSessions').doc(sha(token)).set({ code, expiresAt: inDays(365) });
  writeSessionCookie(req, res, 'm', token);
}

async function memberFromReq(req) {
  const token = readSessionCookie(req).m;
  if (!token) return null;
  const s = await col('memberSessions').doc(sha(token)).get();
  if (!s.exists || s.data().expiresAt.toMillis() < Date.now()) return null;
  const m = await col('members').doc(s.data().code).get();
  return m.exists ? { code: m.id, ...m.data() } : null;
}

async function endMemberSession(req, res) {
  const token = readSessionCookie(req).m;
  if (token) await col('memberSessions').doc(sha(token)).delete();
  writeSessionCookie(req, res, 'm', null);
}

async function requireMember(req, res, next) {
  try {
    req.member = await memberFromReq(req);
    if (!req.member) return res.status(401).json({ error: 'Please sign in' });
    next();
  } catch (e) {
    next(e);
  }
}

// One-time login codes (6 digits, 10 minutes, 5 attempts).
async function issueLoginCode(memberCode) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await col('loginCodes').doc(memberCode).set({ hash: sha(code), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60e3), attempts: 0 });
  return code;
}

async function checkLoginCode(memberCode, code) {
  const ref = col('loginCodes').doc(memberCode);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) return false;
    const row = s.data();
    if (row.expiresAt.toMillis() < Date.now() || row.attempts >= 5) return false;
    const ok = crypto.timingSafeEqual(Buffer.from(row.hash), Buffer.from(sha(code)));
    if (ok) t.delete(ref);
    else t.update(ref, { attempts: row.attempts + 1 });
    return ok;
  });
}

// ------------------------------------------------------------------ staff
async function staffLogin(req, res, email, password) {
  const idx = await col('staffEmails').doc(String(email).trim().toLowerCase()).get();
  if (!idx.exists) return null;
  const s = await col('staff').doc(idx.data().id).get();
  if (!s.exists || !bcrypt.compareSync(password, s.data().passwordHash)) return null;
  const token = newToken();
  await col('staffSessions').doc(sha(token)).set({ staffId: s.id, expiresAt: inDays(30) });
  writeSessionCookie(req, res, 's', token);
  return s;
}

async function staffLogout(req, res) {
  const token = readSessionCookie(req).s;
  if (token) await col('staffSessions').doc(sha(token)).delete();
  writeSessionCookie(req, res, 's', null);
}

async function requireStaff(req, res, next) {
  try {
    const token = readSessionCookie(req).s;
    const sess = token && (await col('staffSessions').doc(sha(token)).get());
    if (sess?.exists && sess.data().expiresAt.toMillis() > Date.now()) {
      const s = await col('staff').doc(sess.data().staffId).get();
      if (s.exists) req.staff = { id: s.id, name: s.data().name, email: s.data().email, role: s.data().role };
    }
    if (!req.staff) return res.status(401).json({ error: 'Please sign in' });
    next();
  } catch (e) {
    next(e);
  }
}

function requireAdmin(req, res, next) {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'Only managers can do that' });
  next();
}

/** Creates a staff account; throws 'EMAIL_TAKEN' if the email is in use. */
async function createStaff({ name, email, password, role }) {
  const em = String(email).trim().toLowerCase();
  const ref = col('staff').doc();
  await db.runTransaction(async (t) => {
    const idx = col('staffEmails').doc(em);
    if ((await t.get(idx)).exists) throw new Error('EMAIL_TAKEN');
    t.set(ref, { name, email: em, passwordHash: bcrypt.hashSync(password, 10), role: role === 'admin' ? 'admin' : 'staff', createdAt: Timestamp.now() });
    t.set(idx, { id: ref.id });
  });
  return ref.id;
}

// Signed token for one-click unsubscribe links in marketing emails.
const secret = () => process.env.APP_SECRET || 'dev-secret-change-me';
const unsubToken = (code) => crypto.createHmac('sha256', secret()).update('unsub:' + code).digest('hex').slice(0, 24);

module.exports = {
  startMemberSession, memberFromReq, endMemberSession, requireMember, issueLoginCode, checkLoginCode,
  staffLogin, staffLogout, requireStaff, requireAdmin, createStaff, unsubToken,
};
