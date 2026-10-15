// Stamp cards, vouchers and birthday rewards.
const db = require('./db');
const notify = require('./notify');

const TZ = process.env.TZ_NAME || 'Africa/Johannesburg';
const UNDO_MINUTES = 15;

/** Today's date in the venue's time zone: { y, m, d, iso: 'YYYY-MM-DD' } */
function today() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), iso: `${parts.year}-${parts.month}-${parts.day}` };
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

const birthdayReward = () => getSetting('birthday_reward', 'Birthday treat: a free drink or dessert on us 🎂');
const birthdayEnabled = () => getSetting('birthday_enabled', '1') === '1';

// ------------------------------------------------------------------ member view
function memberSummary(memberId) {
  const cards = db
    .prepare(
      `SELECT p.id program_id, p.name, p.emoji, p.stamps_required, p.reward, COALESCE(c.stamps, 0) stamps
       FROM programs p LEFT JOIN member_cards c ON c.program_id = p.id AND c.member_id = ?
       WHERE p.active = 1 ORDER BY p.sort, p.id`
    )
    .all(memberId);
  const vouchers = db
    .prepare(
      `SELECT id, title, source, created_at, expires_at FROM vouchers
       WHERE member_id = ? AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)
       ORDER BY COALESCE(expires_at, '9999'), id`
    )
    .all(memberId, today().iso);
  return { cards, vouchers };
}

// ------------------------------------------------------------------ stamping
const addStamps = db.transaction((memberId, programId, qty, staffId) => {
  const program = db.prepare('SELECT * FROM programs WHERE id = ? AND active = 1').get(programId);
  if (!program) throw new Error('That stamp card is not active');
  db.prepare('INSERT OR IGNORE INTO member_cards (member_id, program_id, stamps) VALUES (?, ?, 0)').run(memberId, programId);
  const before = db.prepare('SELECT stamps FROM member_cards WHERE member_id = ? AND program_id = ?').get(memberId, programId).stamps;
  const tx = db
    .prepare(`INSERT INTO transactions (member_id, staff_id, type, program_id, qty, stamps_before) VALUES (?, ?, 'stamp', ?, ?, ?)`)
    .run(memberId, staffId, programId, qty, before).lastInsertRowid;

  let stamps = before + qty;
  const earned = [];
  while (stamps >= program.stamps_required) {
    stamps -= program.stamps_required;
    const v = db
      .prepare(
        `INSERT INTO vouchers (member_id, title, source, program_id, tx_id, expires_at)
         VALUES (?, ?, 'stamps', ?, ?, date(?, '+' || ? || ' days'))`
      )
      .run(memberId, program.reward, program.id, tx, today().iso, program.reward_valid_days).lastInsertRowid;
    earned.push(v);
  }
  db.prepare('UPDATE member_cards SET stamps = ? WHERE member_id = ? AND program_id = ?').run(stamps, memberId, programId);
  db.prepare(`UPDATE members SET last_visit_at = datetime('now') WHERE id = ?`).run(memberId);
  return { txId: tx, stamps, earned: earned.length, reward: program.reward };
});

// Staff can undo the most recent stamp on a card within a few minutes (fat-finger protection).
const undoStamp = db.transaction((txId) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id = ? AND type = 'stamp' AND undone = 0`).get(txId);
  if (!tx) throw new Error('Nothing to undo');
  if (Date.now() - Date.parse(tx.created_at.replace(' ', 'T') + 'Z') > UNDO_MINUTES * 60e3) throw new Error(`Stamps can only be undone within ${UNDO_MINUTES} minutes`);
  const later = db
    .prepare(`SELECT 1 FROM transactions WHERE member_id = ? AND program_id = ? AND type = 'stamp' AND undone = 0 AND id > ?`)
    .get(tx.member_id, tx.program_id, tx.id);
  if (later) throw new Error('Undo the newer stamps first');
  if (db.prepare('SELECT 1 FROM vouchers WHERE tx_id = ? AND redeemed_at IS NOT NULL').get(tx.id)) throw new Error('The reward from these stamps was already redeemed');
  db.prepare('DELETE FROM vouchers WHERE tx_id = ?').run(tx.id);
  db.prepare('UPDATE member_cards SET stamps = ? WHERE member_id = ? AND program_id = ?').run(tx.stamps_before, tx.member_id, tx.program_id);
  db.prepare('UPDATE transactions SET undone = 1 WHERE id = ?').run(tx.id);
});

const redeemVoucher = db.transaction((voucherId, memberId, staffId) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id = ? AND member_id = ?').get(voucherId, memberId);
  if (!v) throw new Error('Reward not found');
  if (v.redeemed_at) throw new Error('This reward was already used');
  if (v.expires_at && v.expires_at < today().iso) throw new Error('This reward has expired');
  db.prepare(`UPDATE vouchers SET redeemed_at = datetime('now'), redeemed_by = ? WHERE id = ?`).run(staffId, v.id);
  db.prepare(`INSERT INTO transactions (member_id, staff_id, type, voucher_id, program_id) VALUES (?, ?, 'redeem', ?, ?)`).run(memberId, staffId, v.id, v.program_id);
  db.prepare(`UPDATE members SET last_visit_at = datetime('now') WHERE id = ?`).run(memberId);
  return v;
});

function giftVoucher(memberId, title, validDays, staffId) {
  const id = db
    .prepare(`INSERT INTO vouchers (member_id, title, source, expires_at) VALUES (?, ?, 'gift', CASE WHEN ? > 0 THEN date(?, '+' || ? || ' days') END)`)
    .run(memberId, title, validDays, today().iso, validDays).lastInsertRowid;
  db.prepare(`INSERT INTO transactions (member_id, staff_id, type, voucher_id) VALUES (?, ?, 'gift', ?)`).run(memberId, staffId, id);
  return id;
}

// ------------------------------------------------------------------ birthdays
// Issue a birthday voucher valid for the whole birthday month. Safe to run repeatedly.
function lastDayOfMonth(y, m) {
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function issueBirthdayVoucher(member) {
  const { y, m } = today();
  if (!birthdayEnabled() || member.birth_month !== m) return false;
  const r = db
    .prepare(`INSERT OR IGNORE INTO vouchers (member_id, title, source, birthday_year, expires_at) VALUES (?, ?, 'birthday', ?, ?)`)
    .run(member.id, birthdayReward(), y, lastDayOfMonth(y, m));
  return r.changes > 0;
}

async function runBirthdays(baseUrl) {
  const { m } = today();
  const members = db.prepare('SELECT * FROM members WHERE birth_month = ?').all(m);
  let issued = 0;
  for (const member of members) {
    if (!issueBirthdayVoucher(member)) continue;
    issued++;
    const first = member.name.split(' ')[0];
    try {
      if (member.marketing_email && member.email && notify.emailEnabled()) {
        await notify.sendEmail({
          to: member.email,
          subject: `Happy birthday month, ${first}! 🎂`,
          text: `Hi ${first},\n\nIt's your birthday month, so there's a reward waiting in your ${process.env.BRAND_NAME || ''} loyalty card:\n\n${birthdayReward()}\n\nShow your card to the team any time this month: ${baseUrl}\n\nCheers!`,
        });
      } else if (member.marketing_whatsapp && member.phone && notify.whatsappEnabled() && process.env.WHATSAPP_BIRTHDAY_TEMPLATE) {
        await notify.sendWhatsAppTemplate({ to: member.phone, template: process.env.WHATSAPP_BIRTHDAY_TEMPLATE, params: [first] });
      }
    } catch (e) {
      console.error('[birthday] could not notify member', member.id, e.message);
    }
  }
  if (issued) console.log(`[birthday] issued ${issued} birthday reward(s)`);
  return issued;
}

module.exports = {
  today, getSetting, setSetting, birthdayReward, birthdayEnabled, memberSummary,
  addStamps, undoStamp, redeemVoucher, giftVoucher, issueBirthdayVoucher, runBirthdays, UNDO_MINUTES,
};
