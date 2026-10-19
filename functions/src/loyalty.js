// Stamp cards, vouchers and birthday rewards (Firestore).
const { db, col, iso, FieldValue, Timestamp } = require('./db');
const notify = require('./notify');

const TZ = process.env.TZ_NAME || 'Africa/Johannesburg';
const UNDO_MINUTES = 15;

class UserError extends Error {}

/** Today's date in the venue's time zone: { y, m, d, iso: 'YYYY-MM-DD' } */
function today() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), iso: `${p.year}-${p.month}-${p.day}` };
}
/** Local calendar day (YYYY-MM-DD) for a timestamp. */
const localDay = (date) => date.toLocaleDateString('en-CA', { timeZone: TZ });
/** today + n days, as YYYY-MM-DD */
function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastDayOfMonth(y, m) {
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** Milliseconds since local midnight, and the local time as "HH:MM". */
function localClock(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return { sinceMidnight: ((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 + date.getMilliseconds(), hhmm: `${p.hour}:${p.minute}` };
}
const startOfLocalDay = () => Timestamp.fromMillis(Date.now() - localClock().sinceMidnight);

/** Is "HH:MM" outside trading hours? Handles closing after midnight (e.g. 10:00–02:00). */
function outsideHours(hhmm, open, close) {
  if (!open || !close || open === close) return false;
  return open < close ? hhmm < open || hhmm >= close : hhmm < open && hhmm >= close;
}

// ------------------------------------------------------------------ settings
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
async function getSettings() {
  const s = (await col('settings').doc('main').get()).data() || {};
  return {
    birthdayEnabled: s.birthdayEnabled !== false,
    birthdayReward: s.birthdayReward || 'Birthday treat: a free drink or dessert on us 🎂',
    // Stamp rules (staff integrity)
    requireBill: s.requireBill !== false,
    billResetsDaily: !!s.billResetsDaily,
    maxPerCardPerDay: num(s.maxPerCardPerDay, 4),
    staffMaxPerScan: num(s.staffMaxPerScan, 1),
    // One stamping per card per visit: after a stamp, that card is locked for this many hours.
    visitHours: num(s.visitHours, 3),
    openTime: s.openTime || '',
    closeTime: s.closeTime || '',
    // Staff bonus targets (per month)
    bonusMinChecks: num(s.bonusMinChecks, 4),
    bonusMinNewRegulars: num(s.bonusMinNewRegulars, 5),
  };
}
const saveSettings = (fields) => col('settings').doc('main').set(fields, { merge: true });

// ------------------------------------------------------------------ programs
async function listPrograms() {
  const snap = await col('programs').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.active === true) - (a.active === true) || (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ member view
const voucherOut = (v) => ({ id: v.id, title: v.title, source: v.source, created_at: iso(v.createdAt), expires_at: v.expiresAt || null });

async function openVouchers(code) {
  const t = today().iso;
  const snap = await col('vouchers').where('memberCode', '==', code).where('redeemedAt', '==', null).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((v) => !v.expiresAt || v.expiresAt >= t)
    .sort((a, b) => (a.expiresAt || '9999').localeCompare(b.expiresAt || '9999'))
    .map(voucherOut);
}

async function memberSummary(member, programs) {
  programs ??= await listPrograms();
  const cards = programs
    .filter((p) => p.active)
    .map((p) => ({ program_id: p.id, name: p.name, emoji: p.emoji, stamps_required: p.stampsRequired, reward: p.reward, stamps: member.cards?.[p.id] || 0 }));
  return { cards, vouchers: await openVouchers(member.code) };
}

// ------------------------------------------------------------------ stamping
/** "#00 1234 " -> "001234". Bill/slip numbers: letters, digits and dashes only. */
const normalizeBill = (ref) => String(ref || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);

async function addStamps(code, programId, qty, staff, { billRef } = {}) {
  const settings = await getSettings();
  const isManager = staff.role === 'admin';
  if (!isManager && qty > settings.staffMaxPerScan)
    throw new UserError(`Staff can add up to ${settings.staffMaxPerScan} stamp${settings.staffMaxPerScan === 1 ? '' : 's'} at a time — ask a manager for more`);
  const bill = normalizeBill(billRef);
  if (settings.requireBill && !bill) throw new UserError('Enter the bill / slip number first');
  const day = today().iso;
  const billKey = bill ? (settings.billResetsDaily ? `${day}_${bill}` : bill) : null;

  const memberRef = col('members').doc(code);
  const programRef = col('programs').doc(String(programId));
  const billRefDoc = billKey ? col('bills').doc(billKey) : null;
  const txRef = col('transactions').doc();
  const clock = localClock();
  const flaggedHours = outsideHours(clock.hhmm, settings.openTime, settings.closeTime);

  return db.runTransaction(async (t) => {
    // Look back far enough for both the daily limit and the one-stamp-per-visit rule (which can span midnight).
    const visitMs = settings.visitHours * 3600e3;
    const lookback = Math.min(startOfLocalDay().toMillis(), Date.now() - visitMs);
    const recentQuery = col('transactions').where('memberCode', '==', code).where('createdAt', '>=', Timestamp.fromMillis(lookback));
    const [pSnap, mSnap, bSnap, todaySnap] = await Promise.all([
      t.get(programRef), t.get(memberRef), billRefDoc ? t.get(billRefDoc) : null, t.get(recentQuery),
    ]);
    const program = pSnap.data();
    if (!program?.active) throw new UserError('That stamp card is not active');
    if (!mSnap.exists) throw new UserError('Member not found');
    const member = mSnap.data();
    if (member.email && staff.email && member.email === staff.email) throw new UserError("You can't stamp your own card — ask a colleague");

    // One bill = one member, and each card stamped at most once per bill.
    if (bSnap?.exists) {
      const b = bSnap.data();
      if (b.memberCode !== code) throw new UserError(`Bill ${bill} was already used for another member`);
      if (b.programs?.[programId]) throw new UserError(`Bill ${bill} was already stamped on the ${program.name}`);
    }

    // Daily limit per card (managers can override, e.g. for a big group bill).
    const recent = todaySnap.docs.map((d) => d.data()).filter((x) => x.type === 'stamp' && !x.undone && x.programId === programId);
    // One stamping per card per visit (managers can override).
    const lastMs = Math.max(0, ...recent.map((x) => x.createdAt.toMillis()));
    if (!isManager && visitMs > 0 && lastMs && Date.now() - lastMs < visitMs)
      throw new UserError(`Already stamped this visit — the ${program.name} can be stamped again from ${localClockOf(new Date(lastMs + visitMs))}`);
    const dayStart = startOfLocalDay().toMillis();
    const usedToday = recent.filter((x) => x.createdAt.toMillis() >= dayStart).reduce((n, x) => n + x.qty, 0);
    if (!isManager && usedToday + qty > settings.maxPerCardPerDay)
      throw new UserError(`Daily limit reached: ${settings.maxPerCardPerDay} stamps per card per day (already ${usedToday} today) — ask a manager`);

    const before = member.cards?.[programId] || 0;
    const newVisitDay = member.lastVisitDay !== day;
    const setFirstStaff = !member.firstStaffId;

    let stamps = before + qty;
    const voucherIds = [];
    while (stamps >= program.stampsRequired) {
      stamps -= program.stampsRequired;
      const vRef = col('vouchers').doc();
      voucherIds.push(vRef.id);
      t.set(vRef, {
        memberCode: code, title: program.reward, source: 'stamps', programId, txId: txRef.id,
        createdAt: Timestamp.now(), expiresAt: addDays(today().iso, program.rewardValidDays || 90), redeemedAt: null,
      });
    }
    t.set(txRef, {
      memberCode: code, staffId: staff.id, staffName: staff.name, type: 'stamp', programId, programName: program.name, emoji: program.emoji,
      qty, stampsBefore: before, voucherIds, prevTxId: member.lastStampTx?.[programId] || null, undone: false, createdAt: Timestamp.now(),
      billRef: bill || null, billKey, outsideHours: flaggedHours, localTime: clock.hhmm, newVisitDay, setFirstStaff,
    });
    if (billRefDoc) {
      if (bSnap.exists) t.update(billRefDoc, { [`programs.${programId}`]: qty });
      else
        t.set(billRefDoc, {
          ref: bill, day, memberCode: code, memberName: member.name, staffId: staff.id, staffName: staff.name,
          programs: { [programId]: qty }, createdAt: Timestamp.now(), audit: null,
        });
    }
    t.update(memberRef, {
      [`cards.${programId}`]: stamps,
      [`lastStampTx.${programId}`]: txRef.id,
      totalStamps: FieldValue.increment(qty),
      lastVisitAt: Timestamp.now(),
      activityAt: Timestamp.now(),
      lastVisitDay: day,
      ...(newVisitDay ? { visitDayCount: FieldValue.increment(1) } : {}),
      ...(setFirstStaff ? { firstStaffId: staff.id } : {}),
    });
    return { txId: txRef.id, stamps, earned: voucherIds.length, reward: program.reward, outsideHours: flaggedHours };
  });
}

// Staff can undo the most recent stamp on a card within a few minutes (fat-finger protection).
async function undoStamp(txId) {
  const txRef = col('transactions').doc(String(txId));
  return db.runTransaction(async (t) => {
    const txSnap = await t.get(txRef);
    const tx = txSnap.data();
    if (!tx || tx.type !== 'stamp' || tx.undone) throw new UserError('Nothing to undo');
    if (Date.now() - tx.createdAt.toMillis() > UNDO_MINUTES * 60e3) throw new UserError(`Stamps can only be undone within ${UNDO_MINUTES} minutes`);
    const memberRef = col('members').doc(tx.memberCode);
    const member = (await t.get(memberRef)).data();
    if (!member) throw new UserError('Member not found');
    if (member.lastStampTx?.[tx.programId] !== txRef.id) throw new UserError('Undo the newer stamps first');
    const vouchers = await Promise.all((tx.voucherIds || []).map((id) => t.get(col('vouchers').doc(id))));
    const billSnap = tx.billKey ? await t.get(col('bills').doc(tx.billKey)) : null;
    if (vouchers.some((v) => v.exists && v.data().redeemedAt)) throw new UserError('The reward from these stamps was already redeemed');
    vouchers.forEach((v) => v.exists && t.delete(v.ref));
    // Free the bill number again for this card (and drop the bill entirely if nothing else used it).
    if (billSnap?.exists) {
      const remaining = Object.keys(billSnap.data().programs || {}).filter((p) => p !== tx.programId);
      if (remaining.length) t.update(billSnap.ref, { [`programs.${tx.programId}`]: FieldValue.delete() });
      else t.delete(billSnap.ref);
    }
    t.update(memberRef, {
      [`cards.${tx.programId}`]: tx.stampsBefore,
      [`lastStampTx.${tx.programId}`]: tx.prevTxId || null,
      totalStamps: FieldValue.increment(-tx.qty),
      ...(tx.newVisitDay ? { visitDayCount: FieldValue.increment(-1) } : {}),
      ...(tx.setFirstStaff ? { firstStaffId: FieldValue.delete() } : {}),
    });
    t.update(txRef, { undone: true });
  });
}

async function redeemVoucher(voucherId, code, staff) {
  const vRef = col('vouchers').doc(String(voucherId));
  return db.runTransaction(async (t) => {
    const snap = await t.get(vRef);
    const v = snap.data();
    if (!v || v.memberCode !== code) throw new UserError('Reward not found');
    if (v.redeemedAt) throw new UserError('This reward was already used');
    if (v.expiresAt && v.expiresAt < today().iso) throw new UserError('This reward has expired');
    t.update(vRef, { redeemedAt: Timestamp.now(), redeemedBy: staff.id });
    t.set(col('transactions').doc(), {
      memberCode: code, staffId: staff.id, staffName: staff.name, type: 'redeem', voucherId: vRef.id, voucherTitle: v.title,
      programId: v.programId || null, qty: 1, undone: false, createdAt: Timestamp.now(),
    });
    t.update(col('members').doc(code), { rewardsRedeemed: FieldValue.increment(1), lastVisitAt: Timestamp.now(), activityAt: Timestamp.now() });
    return v;
  });
}

async function giftVoucher(code, title, validDays, staff) {
  const vRef = col('vouchers').doc();
  const batch = db.batch();
  batch.set(vRef, { memberCode: code, title, source: 'gift', createdAt: Timestamp.now(), expiresAt: validDays > 0 ? addDays(today().iso, validDays) : null, redeemedAt: null });
  batch.set(col('transactions').doc(), { memberCode: code, staffId: staff.id, staffName: staff.name, type: 'gift', voucherId: vRef.id, voucherTitle: title, qty: 1, undone: false, createdAt: Timestamp.now() });
  await batch.commit();
  return vRef.id;
}

// ------------------------------------------------------------------ birthdays
/** Issue this year's birthday voucher (valid all birthday month). Returns true if newly issued. */
async function issueBirthdayVoucher(member, settings) {
  const { y, m } = today();
  if (member.birthMonth !== m) return false;
  settings ??= await getSettings();
  if (!settings.birthdayEnabled) return false;
  try {
    await col('vouchers').doc(`bday_${member.code}_${y}`).create({
      memberCode: member.code, title: settings.birthdayReward, source: 'birthday', birthdayYear: y,
      createdAt: Timestamp.now(), expiresAt: lastDayOfMonth(y, m), redeemedAt: null,
    });
    return true;
  } catch (e) {
    if (e.code === 6 /* ALREADY_EXISTS */) return false;
    throw e;
  }
}

async function runBirthdays(baseUrl) {
  const { m } = today();
  const settings = await getSettings();
  const snap = await col('members').where('birthMonth', '==', m).get();
  let issued = 0;
  for (const d of snap.docs) {
    const member = { code: d.id, ...d.data() };
    if (!(await issueBirthdayVoucher(member, settings))) continue;
    issued++;
    const first = member.name.split(' ')[0];
    try {
      if (member.marketingEmail && member.email && notify.emailEnabled()) {
        await notify.sendEmail({
          to: member.email,
          subject: `Happy birthday month, ${first}! 🎂`,
          text: `Hi ${first},\n\nIt's your birthday month, so there's a reward waiting in your ${process.env.BRAND_NAME || ''} loyalty card:\n\n${settings.birthdayReward}\n\nShow your card to the team any time this month: ${baseUrl}\n\nCheers!`,
        });
      } else if (member.marketingWhatsapp && member.phone && notify.whatsappEnabled() && process.env.WHATSAPP_BIRTHDAY_TEMPLATE) {
        await notify.sendWhatsAppTemplate({ to: member.phone, template: process.env.WHATSAPP_BIRTHDAY_TEMPLATE, params: [first] });
      }
    } catch (e) {
      console.error('[birthday] could not notify member', member.code, e.message);
    }
  }
  console.log(`[birthday] issued ${issued} birthday reward(s)`);
  return issued;
}

const localClockOf = (date) => localClock(date).hhmm;

module.exports = {
  UserError, UNDO_MINUTES, today, localDay, localClockOf, normalizeBill, outsideHours, addDays, getSettings, saveSettings, listPrograms, memberSummary, openVouchers,
  addStamps, undoStamp, redeemVoucher, giftVoucher, issueBirthdayVoucher, runBirthdays,
};
