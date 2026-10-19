// Live, time-based card QR codes (TOTP, RFC 6238) so a screenshot of someone's card stops working.
//
// Code format: "FR2:<card code>:<unix seconds>:<8-digit TOTP>". The member's app computes it every
// 30 seconds from a per-member secret; Google Wallet's rotating barcode uses the same secret and the
// same pattern ({totp_timestamp_seconds}, {totp_value_0}), so staff scan both the same way.
const crypto = require('crypto');
const { col } = require('./db');
const { UserError } = require('./loyalty');

const PERIOD = 30; // seconds
const DIGITS = 8;
const MAX_AGE = 120; // seconds a scanned code stays valid (allows for slow scanning / clock drift)

function totp(keyHex, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(keyHex, 'hex')).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The member's secret, created the first time it's needed. */
async function ensureQrKey(member) {
  if (member.qrKey) return member.qrKey;
  const key = crypto.randomBytes(20).toString('hex');
  await col('members').doc(member.code).update({ qrKey: key });
  member.qrKey = key;
  return key;
}

const qrConfig = (key) => ({ key, period: PERIOD, digits: DIGITS });

/**
 * Turn whatever the staff camera read into a card code, or explain why not.
 * Returns { code, via: 'live' }.
 */
async function verifyScan(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^FR2:([A-Z2-9]{8}):(\d{9,11}):(\d{6,10})$/);
  if (!m) {
    if (/^[A-Z2-9]{8}$/.test(text.toUpperCase())) throw new UserError("That's an old-style card QR — ask the customer to open their card in the app to show the live code");
    throw new UserError("That QR code isn't a rewards card");
  }
  const [, code, tsStr, otp] = m;
  const ts = Number(tsStr);
  const now = Date.now() / 1000;
  if (Math.abs(now - ts) > MAX_AGE) throw new UserError('This code has expired — ask the customer to open their live card (screenshots don\'t work)');
  const snap = await col('members').doc(code).get();
  const key = snap.exists && snap.data().qrKey;
  if (!key) throw new UserError('Card not recognised — ask the customer to open their card in the app');
  const counters = new Set([Math.floor(ts / PERIOD), Math.floor(now / PERIOD)]);
  for (const c of [...counters]) [c - 1, c + 1].forEach((x) => counters.add(x));
  const ok = [...counters].some((c) => crypto.timingSafeEqual(Buffer.from(totp(key, c, otp.length)), Buffer.from(otp)));
  if (!ok) throw new UserError('Card code not valid — ask the customer to open their live card');
  return { code, via: 'live' };
}

module.exports = { PERIOD, DIGITS, totp, ensureQrKey, qrConfig, verifyScan };
