// Firestore access. All reads/writes go through the Admin SDK on the server;
// firestore.rules blocks direct client access entirely.
//
// Collections
//   members/{code}            member profile, cards: { [programId]: stamps }, counters
//   memberEmails/{email}      { code }   uniqueness index
//   memberPhones/{phone}      { code }   uniqueness index
//   memberSessions/{sha256}   { code, expiresAt }
//   loginCodes/{code}         { hash, expiresAt, attempts }
//   staff/{id}                { name, email, passwordHash, role }
//   staffEmails/{email}       { id }
//   staffSessions/{sha256}    { staffId, expiresAt }
//   programs/{id}             stamp cards
//   vouchers/{id}             rewards (birthday ones use id bday_{code}_{year})
//   transactions/{id}         audit log of stamps, redemptions, gifts
//   specials/{id}, campaigns/{id}, settings/main
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

if (!getApps().length) initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const col = (name) => db.collection(name);
const iso = (ts) => (ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : ts || null);
const doc = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);
const daysAgo = (n) => Timestamp.fromMillis(Date.now() - n * 86400e3);

let seeded = false;
async function seedDefaults() {
  if (seeded) return;
  seeded = true;
  const marker = col('settings').doc('main');
  await db.runTransaction(async (t) => {
    const snap = await t.get(marker);
    if (snap.exists && snap.data().seeded) return;
    // Starter stamp cards on a fresh install (editable in the admin).
    t.set(col('programs').doc(), { name: 'Coffee card', stampsRequired: 9, reward: 'Free coffee of your choice', emoji: '☕', rewardValidDays: 90, active: true, sort: 1 });
    t.set(col('programs').doc(), { name: 'Pint card', stampsRequired: 9, reward: 'Free draught pint', emoji: '🍺', rewardValidDays: 90, active: true, sort: 2 });
    t.set(marker, { seeded: true }, { merge: true });
  });
}

module.exports = { db, col, iso, doc, daysAgo, seedDefaults, FieldValue, Timestamp };
