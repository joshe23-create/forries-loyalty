// Apple Wallet and Google Wallet loyalty cards.
//
// Google Wallet: the card shows a rotating QR (same secret/format as the app's live card, see liveqr.js),
// so staff can scan it and screenshots don't work.
// Apple Wallet: barcodes there can't rotate, so the card carries no barcode. It shows stamps and rewards,
// updates itself when anything changes (with a lock-screen message), pops up near the venue, and links
// to the live card for scanning.
//
// Both are switched off until their settings are present (see README → Wallet cards).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http2 = require('http2');
const forge = require('node-forge');
const yazl = require('yazl');
const { GoogleAuth } = require('google-auth-library');
const { col, Timestamp } = require('./db');
const L = require('./loyalty');
const { ensureQrKey } = require('./liveqr');

const env = process.env;
const DISPLAY_NAME = env.VENUE_NAME || 'Foresters Arms';
const PROGRAM = `${env.BRAND_NAME || 'Forries'} Rewards`;
const publicUrl = () => (env.PUBLIC_URL || '').replace(/\/$/, '');
const ASSETS = path.join(__dirname, 'assets', 'wallet');

/** What both cards show. */
async function cardContent(member) {
  const { cards, vouchers } = await L.memberSummary(member);
  return {
    name: member.name,
    code: member.code,
    cards: cards.map((c) => ({ id: c.program_id, name: c.name, emoji: c.emoji, stamps: c.stamps, required: c.stamps_required, reward: c.reward })),
    rewards: vouchers.map((v) => ({ title: v.title, expires: v.expires_at })),
  };
}

// =================================================================== Google Wallet
const googleEnabled = () => Boolean(env.GOOGLE_WALLET_ISSUER_ID && env.GOOGLE_WALLET_SA_KEY && publicUrl());
const GW_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

let gCreds;
function googleCreds() {
  if (gCreds) return gCreds;
  const raw = env.GOOGLE_WALLET_SA_KEY.trim();
  gCreds = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  return gCreds;
}
let gAuth;
async function googleFetch(method, url, body) {
  gAuth ??= new GoogleAuth({ credentials: googleCreds(), scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'] });
  const client = await gAuth.getClient();
  const { token } = await client.getAccessToken();
  const r = await fetch(GW_API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const classId = () => `${env.GOOGLE_WALLET_ISSUER_ID}.${env.GOOGLE_WALLET_CLASS_SUFFIX || 'forries_rewards'}`;
const objectId = (code) => `${env.GOOGLE_WALLET_ISSUER_ID}.member_${code}`;
const localized = (value) => ({ defaultValue: { language: 'en', value } });

function googleClass() {
  return {
    id: classId(),
    issuerName: DISPLAY_NAME,
    programName: PROGRAM,
    programLogo: { sourceUri: { uri: `${publicUrl()}/icons/wallet-logo.png` }, contentDescription: localized(DISPLAY_NAME) },
    heroImage: { sourceUri: { uri: `${publicUrl()}/icons/wallet-hero.png` }, contentDescription: localized(DISPLAY_NAME) },
    hexBackgroundColor: '#1f4d3a',
    countryCode: 'ZA',
    reviewStatus: 'UNDER_REVIEW',
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
  };
}

function googleObject(content, qrKey) {
  return {
    id: objectId(content.code),
    classId: classId(),
    state: 'ACTIVE',
    accountId: content.code,
    accountName: content.name,
    loyaltyPoints: { label: 'Rewards ready', balance: { int: content.rewards.length } },
    rotatingBarcode: {
      type: 'QR_CODE',
      valuePattern: `FR2:${content.code}:{totp_timestamp_seconds}:{totp_value_0}`,
      totpDetails: { periodMillis: '30000', algorithm: 'TOTP_SHA1', parameters: [{ key: qrKey, valueLength: 8 }] },
    },
    textModulesData: [
      ...content.cards.map((c) => ({ id: `card_${c.id}`.slice(0, 60), header: `${c.emoji} ${c.name}`, body: `${c.stamps} of ${c.required} stamps — ${c.required - c.stamps} more for: ${c.reward}` })),
      ...(content.rewards.length ? [{ id: 'rewards', header: '🎁 Rewards ready', body: content.rewards.map((r) => r.title).join('\n') }] : []),
    ],
    linksModuleData: { uris: [{ id: 'app', uri: publicUrl(), description: 'Open my card' }] },
  };
}

let classReady = false;
async function ensureGoogleClass() {
  if (classReady) return;
  const got = await googleFetch('GET', `/loyaltyClass/${classId()}`);
  if (got.status === 404) {
    const ins = await googleFetch('POST', '/loyaltyClass', googleClass());
    if (ins.status >= 300 && ins.status !== 409) throw new Error(`Google Wallet class: ${ins.data.error?.message || ins.status}`);
  } else if (got.status >= 300) throw new Error(`Google Wallet class: ${got.data.error?.message || got.status}`);
  classReady = true;
}

async function upsertGoogleObject(member) {
  const content = await cardContent(member);
  const body = googleObject(content, await ensureQrKey(member));
  const got = await googleFetch('GET', `/loyaltyObject/${body.id}`);
  const res = got.status === 404 ? await googleFetch('POST', '/loyaltyObject', body) : await googleFetch('PUT', `/loyaltyObject/${body.id}`, body);
  if (res.status >= 300) throw new Error(`Google Wallet card: ${res.data.error?.message || res.status}`);
  return body.id;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** "Add to Google Wallet" link for this member (creates/updates their card first). */
async function googleSaveUrl(member) {
  await ensureGoogleClass();
  const id = await upsertGoogleObject(member);
  await col('members').doc(member.code).update({ walletGoogle: true });
  return `https://pay.google.com/gp/v/save/${saveJwt(id)}`;
}

// The card (with its barcode secret) is created server-side, so the signed link only references its id.
function saveJwt(id) {
  const creds = googleCreds();
  const claims = { iss: creds.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000), origins: [publicUrl()], payload: { loyaltyObjects: [{ id }] } };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  return `${unsigned}.${b64url(crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key))}`;
}

// =================================================================== Apple Wallet
const appleEnabled = () => Boolean(env.APPLE_PASS_TYPE_ID && env.APPLE_TEAM_ID && env.APPLE_PASS_P12 && env.APPLE_WWDR_PEM && publicUrl());

let appleCerts;
function appleCredentials() {
  if (appleCerts) return appleCerts;
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(env.APPLE_PASS_P12.trim())), env.APPLE_PASS_P12_PASSWORD || '');
  const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0].cert;
  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag][0];
  const wwdrPem = env.APPLE_WWDR_PEM.includes('BEGIN') ? env.APPLE_WWDR_PEM : Buffer.from(env.APPLE_WWDR_PEM, 'base64').toString('utf8');
  appleCerts = { cert, key: keyBag.key, wwdr: forge.pki.certificateFromPem(wwdrPem), certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keyBag.key) };
  return appleCerts;
}

async function ensureAppleToken(member) {
  if (member.appleAuthToken) return member.appleAuthToken;
  const t = crypto.randomBytes(24).toString('hex');
  await col('members').doc(member.code).update({ appleAuthToken: t });
  member.appleAuthToken = t;
  return t;
}

function applePassJson(content, authToken) {
  const lat = Number(env.VENUE_LAT), lng = Number(env.VENUE_LNG);
  const short = (s) => s.toUpperCase().replace(/ CARD$/, '');
  return {
    formatVersion: 1,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    serialNumber: content.code,
    organizationName: DISPLAY_NAME,
    description: `${PROGRAM} card`,
    logoText: 'Rewards',
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(31, 77, 58)',
    labelColor: 'rgb(200, 162, 74)',
    webServiceURL: `${publicUrl()}/api/applepass`,
    authenticationToken: authToken,
    ...(Number.isFinite(lat) && Number.isFinite(lng) && env.VENUE_LAT ? { locations: [{ latitude: lat, longitude: lng, relevantText: 'Show your live rewards card at the bar 🍺' }] } : {}),
    storeCard: {
      headerFields: [{ key: 'rewards', label: 'REWARDS', value: content.rewards.length, changeMessage: '🎁 You have %@ reward(s) ready!' }],
      primaryFields: [{ key: 'member', label: 'MEMBER', value: content.name }],
      secondaryFields: content.cards.slice(0, 4).map((c, i) => ({
        key: `card${i}`, label: `${c.emoji} ${short(c.name)}`, value: `${c.stamps}/${c.required}`, changeMessage: `${c.emoji} ${c.name}: %@ stamps`,
      })),
      backFields: [
        { key: 'live', label: 'Getting stamped', value: `Open your live card to be scanned: ${publicUrl()}`, attributedValue: `<a href="${publicUrl()}">Open my live card</a>` },
        ...content.cards.map((c, i) => ({ key: `goal${i}`, label: `${c.emoji} ${c.name}`, value: `${c.stamps} of ${c.required} — ${c.required - c.stamps} more for: ${c.reward}` })),
        { key: 'ready', label: 'Rewards ready', value: content.rewards.length ? content.rewards.map((r) => `• ${r.title}${r.expires ? ` (until ${r.expires})` : ''}`).join('\n') : 'None yet — keep collecting!' },
        { key: 'code', label: 'Card number', value: content.code },
      ],
    },
  };
}

function zip(files) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [name, buf] of Object.entries(files)) z.addBuffer(buf, name);
    z.end();
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

/** Build and sign a .pkpass for this member. */
async function buildApplePass(member) {
  const content = await cardContent(member);
  const files = { 'pass.json': Buffer.from(JSON.stringify(applePassJson(content, await ensureAppleToken(member)))) };
  for (const f of fs.readdirSync(ASSETS)) if (f.endsWith('.png')) files[f] = fs.readFileSync(path.join(ASSETS, f));
  const manifest = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, crypto.createHash('sha1').update(b).digest('hex')]));
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest));

  const { cert, key, wwdr } = appleCredentials();
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(files['manifest.json'].toString('binary'));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }],
  });
  p7.sign({ detached: true });
  files.signature = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
  return zip(files);
}

/** Tell every iPhone holding this member's card to fetch the new version (APNs, empty payload). */
async function pushAppleUpdate(code) {
  const regs = await col('appleRegs').where('serial', '==', code).get();
  if (regs.empty) return 0;
  const { certPem, keyPem } = appleCredentials();
  const session = http2.connect('https://api.push.apple.com', { cert: certPem, key: keyPem });
  session.on('error', (e) => console.error('[apple] APNs session', e.message));
  const sendOne = (token) =>
    new Promise((resolve) => {
      const req = session.request({ ':method': 'POST', ':path': `/3/device/${token}`, 'apns-topic': env.APPLE_PASS_TYPE_ID, 'content-type': 'application/json' });
      req.on('response', (h) => resolve(h[':status']));
      req.on('error', () => resolve(0));
      req.end('{}');
    });
  let ok = 0;
  for (const d of regs.docs) {
    const status = await sendOne(d.data().pushToken);
    if (status === 200) ok++;
    else if (status === 410) await d.ref.delete(); // device no longer has the pass
  }
  session.close();
  return ok;
}

// =================================================================== both
/** Something on this member's card changed: refresh whichever wallet cards they have. */
async function refreshWallets(code) {
  const snap = await col('members').doc(code).get();
  if (!snap.exists) return;
  const member = { code, ...snap.data() };
  const jobs = [];
  if (member.walletGoogle && googleEnabled()) jobs.push(upsertGoogleObject(member).catch((e) => console.error('[google wallet]', code, e.message)));
  if (member.walletApple && appleEnabled())
    jobs.push(
      col('members').doc(code).update({ appleUpdatedAt: Timestamp.now() })
        .then(() => pushAppleUpdate(code))
        .catch((e) => console.error('[apple wallet]', code, e.message))
    );
  await Promise.all(jobs);
}

module.exports = { googleEnabled, appleEnabled, googleSaveUrl, saveJwt, objectId, buildApplePass, ensureAppleToken, refreshWallets, applePassJson, googleObject, cardContent };
