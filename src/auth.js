const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const MEMBER_COOKIE = 'fl_member';
const STAFF_COOKIE = 'fl_staff';

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function setCookie(res, name, value, days) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.round(days * 86400)}${secure}`);
}

const newToken = () => crypto.randomBytes(32).toString('hex');

// ------------------------------------------------------------------ members
// Members stay signed in for a year so the card is always one tap away.
function startMemberSession(res, memberId) {
  const token = newToken();
  db.prepare(`INSERT INTO member_sessions (token, member_id, expires_at) VALUES (?, ?, datetime('now', '+365 days'))`).run(token, memberId);
  setCookie(res, MEMBER_COOKIE, token, 365);
}

function memberFromReq(req) {
  const token = cookies(req)[MEMBER_COOKIE];
  if (!token) return null;
  return db
    .prepare(`SELECT m.* FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ? AND s.expires_at > datetime('now')`)
    .get(token);
}

function endMemberSession(req, res) {
  const token = cookies(req)[MEMBER_COOKIE];
  if (token) db.prepare('DELETE FROM member_sessions WHERE token = ?').run(token);
  setCookie(res, MEMBER_COOKIE, '', 0);
}

function requireMember(req, res, next) {
  req.member = memberFromReq(req);
  if (!req.member) return res.status(401).json({ error: 'Please sign in' });
  next();
}

// One-time login codes (6 digits, 10 minutes, 5 attempts).
function issueLoginCode(memberId) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  db.prepare(
    `INSERT INTO login_codes (member_id, code_hash, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))
     ON CONFLICT(member_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
  ).run(memberId, hash);
  return code;
}

function checkLoginCode(memberId, code) {
  const row = db.prepare(`SELECT * FROM login_codes WHERE member_id = ? AND expires_at > datetime('now')`).get(memberId);
  if (!row || row.attempts >= 5) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(crypto.createHash('sha256').update(String(code)).digest('hex')));
  if (ok) db.prepare('DELETE FROM login_codes WHERE member_id = ?').run(memberId);
  else db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE member_id = ?').run(memberId);
  return ok;
}

// ------------------------------------------------------------------ staff
function staffLogin(res, email, password) {
  const s = db.prepare('SELECT * FROM staff WHERE email = ?').get(email);
  if (!s || !bcrypt.compareSync(password, s.password_hash)) return null;
  const token = newToken();
  db.prepare(`INSERT INTO staff_sessions (token, staff_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`).run(token, s.id);
  setCookie(res, STAFF_COOKIE, token, 30);
  return s;
}

function staffLogout(req, res) {
  const token = cookies(req)[STAFF_COOKIE];
  if (token) db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
  setCookie(res, STAFF_COOKIE, '', 0);
}

function requireStaff(req, res, next) {
  const token = cookies(req)[STAFF_COOKIE];
  req.staff =
    token &&
    db
      .prepare(`SELECT st.id, st.name, st.email, st.role FROM staff_sessions s JOIN staff st ON st.id = s.staff_id WHERE s.token = ? AND s.expires_at > datetime('now')`)
      .get(token);
  if (!req.staff) return res.status(401).json({ error: 'Please sign in' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'Only managers can do that' });
  next();
}

function createStaff({ name, email, password, role }) {
  return db
    .prepare('INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role === 'admin' ? 'admin' : 'staff').lastInsertRowid;
}

// Signed token for one-click unsubscribe links in marketing emails.
const secret = () => process.env.APP_SECRET || 'dev-secret-change-me';
const unsubToken = (code) => crypto.createHmac('sha256', secret()).update('unsub:' + code).digest('hex').slice(0, 24);

module.exports = {
  startMemberSession, memberFromReq, endMemberSession, requireMember, issueLoginCode, checkLoginCode,
  staffLogin, staffLogout, requireStaff, requireAdmin, createStaff, unsubToken,
};
