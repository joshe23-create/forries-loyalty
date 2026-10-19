// Staff integrity: scorecards, warning flags, bill spot checks and bonus eligibility.
const crypto = require('crypto');
const { col, iso, daysAgo, Timestamp } = require('./db');
const L = require('./loyalty');

const SPOT_CHECKS_PER_WEEK = 5;

// Stable pseudo-random order, so the same bills stay selected for the week even after a reload.
const rank = (id, salt) => crypto.createHash('sha1').update(salt + id).digest('hex');
const isoWeek = () => {
  const d = new Date(L.today().iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-W${1 + Math.round(((d - jan4) / 86400e3 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)}`;
};

const billOut = (b) => ({
  id: b.id, ref: b.ref, day: b.day, created_at: iso(b.createdAt), member_code: b.memberCode, member_name: b.memberName,
  staff_id: b.staffId, staff_name: b.staffName, programs: b.programs || {},
  audit: b.audit ? { result: b.audit.result, note: b.audit.note || '', by: b.audit.byName, at: iso(b.audit.at) } : null,
});

/** Everything the Integrity tab shows, for the last `days` days. */
async function integrityReport(days) {
  const since = daysAgo(days);
  const [settings, staffSnap, txSnap, billSnap, memberSnap, programs] = await Promise.all([
    L.getSettings(),
    col('staff').get(),
    col('transactions').where('createdAt', '>=', since).get(),
    col('bills').where('createdAt', '>=', since).get(),
    col('members').where('createdAt', '>=', since).get(),
    L.listPrograms(),
  ]);
  const programName = Object.fromEntries(programs.map((p) => [p.id, `${p.emoji} ${p.name}`]));
  const staff = Object.fromEntries(
    staffSnap.docs.map((d) => [d.id, {
      id: d.id, name: d.data().name, role: d.data().role,
      stamps: 0, stampTx: 0, undos: 0, outsideHours: 0, redemptions: 0, members: {}, pairDays: {},
      newMembers: 0, newRegulars: 0, checksPassed: 0, checksFailed: 0,
    }])
  );
  const flags = [];
  const memberNames = {};

  for (const d of txSnap.docs) {
    const t = d.data();
    const s = staff[t.staffId];
    if (!s) continue;
    if (t.type === 'redeem') s.redemptions++;
    if (t.type !== 'stamp') continue;
    if (t.undone) {
      s.undos++;
      continue;
    }
    s.stamps += t.qty;
    s.stampTx++;
    s.members[t.memberCode] = (s.members[t.memberCode] || 0) + t.qty;
    const day = L.localDay(t.createdAt.toDate());
    (s.pairDays[t.memberCode] ??= new Set()).add(day);
    if (t.outsideHours) {
      s.outsideHours++;
      flags.push({
        level: 'warn', staff_id: s.id, staff_name: s.name, member_code: t.memberCode,
        text: `${t.qty} stamp${t.qty > 1 ? 's' : ''} on ${t.programName} at ${t.localTime} on ${day} — outside trading hours`,
      });
    }
  }

  // New members credited to the staff member who gave them their first stamp;
  // they only count as "regulars" once they've come back on another day.
  for (const d of memberSnap.docs) {
    const m = d.data();
    memberNames[d.id] = m.name;
    const s = staff[m.firstStaffId];
    if (!s) continue;
    s.newMembers++;
    if ((m.visitDayCount || 0) >= 2) s.newRegulars++;
  }

  // Spot checks
  const bills = billSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const b of bills) {
    const s = staff[b.staffId];
    if (!s || !b.audit) continue;
    if (b.audit.result === 'ok') s.checksPassed++;
    else {
      s.checksFailed++;
      flags.push({ level: 'red', staff_id: s.id, staff_name: s.name, member_code: b.memberCode, text: `Spot check failed: bill ${b.ref} (${b.day})${b.audit.note ? ' — ' + b.audit.note : ''}` });
    }
  }
  const week = isoWeek();
  const weekCutoff = daysAgo(7).toMillis();
  const pending = bills
    .filter((b) => !b.audit && b.createdAt.toMillis() >= weekCutoff)
    .sort((a, b) => rank(a.id, week).localeCompare(rank(b.id, week)))
    .slice(0, SPOT_CHECKS_PER_WEEK)
    .map(billOut);

  // Pattern flags
  const pairLimit = days <= 7 ? 4 : 12;
  for (const s of Object.values(staff)) {
    for (const [code, set] of Object.entries(s.pairDays)) {
      if (set.size >= pairLimit)
        flags.push({ level: 'info', staff_id: s.id, staff_name: s.name, member_code: code, text: `Stamped ${memberNames[code] || code} on ${set.size} different days — normal for a regular, but worth a look` });
    }
    if (s.undos >= 5 && s.undos > 0.15 * (s.stampTx + s.undos))
      flags.push({ level: 'warn', staff_id: s.id, staff_name: s.name, text: `High undo rate: ${s.undos} undone out of ${s.stampTx + s.undos} stamps` });
    const top3 = Object.values(s.members).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    s.topShare = s.stamps ? Math.round((top3 / s.stamps) * 100) : 0;
    if (s.stamps >= 20 && s.topShare > 50)
      flags.push({ level: 'warn', staff_id: s.id, staff_name: s.name, text: `${s.topShare}% of their stamps went to just 3 members` });
  }

  // Bonus eligibility (targets are per month; scaled for shorter periods)
  const scale = Math.min(1, days / 30);
  const needChecks = Math.max(1, Math.ceil(settings.bonusMinChecks * scale));
  const needRegulars = Math.ceil(settings.bonusMinNewRegulars * scale);
  const scorecards = Object.values(staff)
    .filter((s) => s.stampTx || s.undos || s.redemptions || s.newMembers || s.checksPassed || s.checksFailed || s.role === 'staff')
    .map((s) => {
      const red = flags.filter((f) => f.staff_id === s.id && f.level === 'red').length;
      const warn = flags.filter((f) => f.staff_id === s.id && f.level === 'warn').length;
      const missing = [];
      if (s.checksPassed < needChecks) missing.push(`${needChecks - s.checksPassed} more spot check${needChecks - s.checksPassed === 1 ? '' : 's'} passed`);
      if (s.newRegulars < needRegulars) missing.push(`${needRegulars - s.newRegulars} more new regular${needRegulars - s.newRegulars === 1 ? '' : 's'}`);
      if (red) missing.push('no failed spot checks');
      return {
        id: s.id, name: s.name, role: s.role, stamps: s.stamps, stamp_tx: s.stampTx, undos: s.undos, redemptions: s.redemptions,
        unique_members: Object.keys(s.members).length, top_share: s.topShare, outside_hours: s.outsideHours,
        new_members: s.newMembers, new_regulars: s.newRegulars, checks_passed: s.checksPassed, checks_failed: s.checksFailed,
        red_flags: red, warnings: warn, bonus_eligible: missing.length === 0, bonus_missing: missing,
      };
    })
    .sort((a, b) => b.stamps - a.stamps);

  const order = { red: 0, warn: 1, info: 2 };
  return {
    days,
    targets: { checks: needChecks, new_regulars: needRegulars },
    scorecards,
    flags: flags.sort((a, b) => order[a.level] - order[b.level]),
    spot_checks: pending,
    checked: bills.filter((b) => b.audit).sort((a, b) => b.audit.at.toMillis() - a.audit.at.toMillis()).slice(0, 20).map(billOut),
    program_names: programName,
    bills_total: bills.length,
  };
}

async function auditBill(id, result, note, manager) {
  if (!['ok', 'problem'].includes(result)) throw new L.UserError('Choose OK or Problem');
  const ref = col('bills').doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new L.UserError('Bill not found');
  await ref.update({ audit: { result, note: String(note || '').slice(0, 200), by: manager.id, byName: manager.name, at: Timestamp.now() } });
}

async function billsCsv(days) {
  const [snap, programs] = await Promise.all([col('bills').where('createdAt', '>=', daysAgo(days)).orderBy('createdAt').get(), L.listPrograms()]);
  const names = Object.fromEntries(programs.map((p) => [p.id, p.name]));
  const cell = (v) => {
    let x = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(x)) x = "'" + x;
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const rows = snap.docs.map((d) => {
    const b = d.data();
    const when = b.createdAt.toDate();
    return [b.day, L.localClockOf(when), b.ref, b.memberName, b.memberCode, Object.entries(b.programs || {}).map(([p, q]) => `${names[p] || p} x${q}`).join('; '), b.staffName, b.audit?.result || '', b.audit?.note || ''];
  });
  return [['date', 'time', 'bill', 'member', 'card_code', 'stamps', 'staff', 'spot_check', 'note'].join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}

module.exports = { integrityReport, auditBill, billsCsv };
