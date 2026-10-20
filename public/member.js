'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const root = $('#root');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let brand = { name: 'Loyalty' };
let data = null;      // /api/m/me payload
let tab = 'card';
let pollTimer = null;
let knownVouchers = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong'), { status: res.status });
  return json;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2500);
}

const fmtDate = (iso) => new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const firstName = (n) => String(n || '').split(' ')[0];
const wordmark = (cls = '') => `<h1 class="wordmark ${cls}"><img class="logo" src="/icons/logo-white.svg" alt="${esc(brand.name)}" /><small>Rewards</small></h1>`;

function birthdayFields() {
  return `<div class="row">
    <select name="bmonth" aria-label="Birth month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select>
    <select name="bday" aria-label="Birth day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join('')}</select>
  </div>`;
}
const birthdayValue = (f) => (f.bmonth.value && f.bday.value ? `${f.bmonth.value}-${f.bday.value}` : null);

// ------------------------------------------------------------------ welcome / join / sign in
function showWelcome() {
  stopPolling();
  root.className = 'shell auth';
  root.innerHTML = `
    <div class="hero">${wordmark()}<p>${esc(brand.tagline)}</p></div>
    <div class="pad stack">
      <div class="card stack">
        <div><strong>How it works</strong></div>
        <div>📱 Join free in under a minute</div>
        <div>✅ Show your card when you order — we'll stamp it</div>
        <div>🎁 Fill a card, get a reward. Plus a treat in your birthday month</div>
      </div>
      <button class="btn primary block" id="joinBtn">Join now — it's free</button>
      <button class="btn block" id="signinBtn">I'm already a member</button>
    </div>`;
  $('#joinBtn').onclick = showJoin;
  $('#signinBtn').onclick = () => showSignIn();
}

function showJoin() {
  root.className = 'shell auth';
  root.innerHTML = `
    <div class="hero compact">${wordmark()}</div>
    <form class="pad" id="joinForm" novalidate>
      <h2 style="margin-top:0">Join ${esc(brand.name)} Rewards</h2>
      <label>Your name<input name="name" autocomplete="name" required /></label>
      <label>Email<input name="email" type="email" autocomplete="email" inputmode="email" required /></label>
      <label>Mobile number <span class="muted" style="font-weight:400">(optional)</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="082 123 4567" /></label>
      <label>Birthday <span class="muted" style="font-weight:400">(optional — for your birthday treat)</span>${birthdayFields()}</label>
      <div class="card stack" style="padding:14px">
        <label class="check" style="margin:0"><input type="checkbox" name="marketing_email" /> <span>Email me specials and events</span></label>
        <label class="check" style="margin:0" id="waOpt"><input type="checkbox" name="marketing_whatsapp" /> <span>WhatsApp me specials and events</span></label>
        <div class="small muted">You can change this any time in your profile.</div>
      </div>
      <label class="check"><input type="checkbox" name="accept_terms" required /> <span>I agree to the rewards terms${brand.privacyUrl ? ` and <a href="${esc(brand.privacyUrl)}" target="_blank" rel="noopener">privacy policy</a>` : ''}. My details are only used for this programme.</span></label>
      <p class="error" id="err"></p>
      <button class="btn primary block" type="submit">Create my card</button>
      <p style="text-align:center"><button type="button" class="link" id="back">Back</button></p>
    </form>`;
  const f = $('#joinForm');
  const syncWa = () => $('#waOpt').classList.toggle('hidden', !f.phone.value.trim());
  f.phone.addEventListener('input', syncWa);
  syncWa();
  $('#back').onclick = showWelcome;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/m/signup', {
        body: {
          name: f.name.value, email: f.email.value, phone: f.phone.value, birthday: birthdayValue(f),
          marketing_email: f.marketing_email.checked, marketing_whatsapp: f.marketing_whatsapp.checked, accept_terms: f.accept_terms.checked,
        },
      });
      tab = 'card';
      await loadMe(true);
      toast('Welcome! Your card is ready 🎉');
    } catch (err) {
      $('#err').textContent = err.message;
      if (err.status === 409) setTimeout(() => showSignIn(f.email.value), 1200);
    } finally {
      btn.disabled = false;
    }
  };
}

function showSignIn(prefill = '') {
  root.className = 'shell auth';
  root.innerHTML = `
    <div class="hero compact">${wordmark()}</div>
    <form class="pad" id="f1">
      <h2 style="margin-top:0">Sign in</h2>
      <label>Email or mobile number<input name="identifier" autocomplete="username" required value="${esc(prefill)}" /></label>
      <p class="error" id="err"></p>
      <button class="btn primary block" type="submit">Send me a code</button>
      <p style="text-align:center"><button type="button" class="link" id="back">Back</button></p>
    </form>`;
  $('#back').onclick = showWelcome;
  $('#f1').onsubmit = async (e) => {
    e.preventDefault();
    const identifier = e.target.identifier.value.trim();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/m/login', { body: { identifier } });
      showCodeEntry(identifier, r);
    } catch (err) {
      $('#err').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}

function showCodeEntry(identifier, r) {
  const where = r.sentVia ? `We sent a 6-digit code to ${esc(r.where)}.` : 'Demo mode: no email or WhatsApp is set up, so here is your code.';
  root.className = 'shell auth';
  root.innerHTML = `
    <div class="hero compact">${wordmark()}</div>
    <form class="pad" id="f2">
      <h2 style="margin-top:0">Enter your code</h2>
      <p>${where}</p>
      ${r.demoCode ? `<p class="card" style="font-size:24px;letter-spacing:.2em;text-align:center">${esc(r.demoCode)}</p>` : ''}
      <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required style="font-size:24px;letter-spacing:.3em;text-align:center" /></label>
      <p class="error" id="err"></p>
      <button class="btn primary block" type="submit">Sign in</button>
      <p style="text-align:center"><button type="button" class="link" id="back">Use a different email or number</button></p>
    </form>`;
  $('#back').onclick = () => showSignIn(identifier);
  const f = $('#f2');
  f.code.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/m/verify', { body: { identifier, code: f.code.value } });
      tab = 'card';
      await loadMe(true);
    } catch (err) {
      $('#err').textContent = err.message;
    }
  };
}

// ------------------------------------------------------------------ signed-in app
async function loadMe(first) {
  try {
    data = await api('/api/m/me');
  } catch (err) {
    if (err.status === 401) return showWelcome();
    throw err;
  }
  // Celebrate rewards that appeared since we last looked (e.g. staff just stamped the 9th).
  const ids = data.vouchers.map((v) => v.id);
  if (knownVouchers && !first) {
    const fresh = data.vouchers.filter((v) => !knownVouchers.includes(v.id));
    if (fresh.length) celebrate(fresh[0]);
  }
  knownVouchers = ids;
  renderApp();
  startPolling();
}

function renderApp() {
  if (!$('#app-main')) {
    root.className = 'shell app';
    // The tab bar sits at the bottom of the screen on phones and moves into the top bar on laptops.
    root.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <div class="wordmark"><img class="logo" src="/icons/logo-white.svg" alt="${esc(brand.name)}" /></div>
        <nav class="tabbar"><div class="inner">
          <button data-tab="card"><span class="i">🎟️</span>Card</button>
          <button data-tab="rewards"><span class="i">🎁</span>Rewards</button>
          <button data-tab="specials"><span class="i">📣</span>What's on</button>
          <button data-tab="profile"><span class="i">👤</span>Profile</button>
        </div></nav>
        <div class="hi" id="hi"></div>
      </div></header>
      <main class="view" id="app-main"></main>`;
    document.querySelector('.tabbar').onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) ((tab = b.dataset.tab), renderApp(), window.scrollTo(0, 0));
    };
  }
  $('#hi').textContent = `Hi, ${firstName(data.member.name)}`;
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    if (b.dataset.tab === 'rewards') b.innerHTML = `<span class="i">🎁</span>Rewards${data.vouchers.length ? `<span class="badge">${data.vouchers.length}</span>` : ''}`;
  });
  ({ card: renderCard, rewards: renderRewards, specials: renderSpecials, profile: renderProfile })[tab]();
}

function stampsHtml(c, popIndex) {
  const cells = [];
  for (let i = 0; i < c.stamps_required; i++) {
    const on = i < c.stamps;
    cells.push(`<div class="stamp ${on ? 'on' : ''} ${i === c.stamps_required - 1 ? 'goal' : ''} ${i === popIndex ? 'pop' : ''}">${on ? esc(c.emoji) : i === c.stamps_required - 1 ? '🎁' : ''}</div>`);
  }
  return `<div class="stamps">${cells.join('')}</div>`;
}

let lastStamps = {};
function renderCard() {
  const main = $('#app-main');
  const m = data.member;
  main.innerHTML = `
    <div class="card-layout"><div class="col-a">
    <div class="member-card">
      <div class="name">${esc(m.name)}</div>
      <div class="qr" id="liveqr" role="img" aria-label="Your live membership QR code"></div>
      <div class="live"><span class="dot"></span> LIVE CODE <span class="countdown"><i id="qrbar"></i></span></div>
      <div class="hint">Show this to the team when you order · screenshots won't work</div>
    </div>
    <div id="pushTip"></div>
    <div id="walletBtns"></div>
    <div id="installTip"></div>
    </div><div class="col-b">
    ${data.vouchers.length ? `<div class="card voucher" style="margin-top:16px;cursor:pointer" id="toRewards"><div class="ico">🎁</div><div><div class="t">You have ${data.vouchers.length} reward${data.vouchers.length > 1 ? 's' : ''} ready!</div><div class="small muted">Tap to see them</div></div></div>` : ''}
    <div class="section-title">Your stamp cards</div>
    <div class="stack">${data.cards
      .map((c) => {
        const prev = lastStamps[c.program_id];
        const pop = prev !== undefined && c.stamps > prev ? c.stamps - 1 : -1;
        const left = c.stamps_required - c.stamps;
        return `<div class="card stampcard">
          <div class="head"><strong>${esc(c.emoji)} ${esc(c.name)}</strong><span class="muted small">${c.stamps}/${c.stamps_required}</span></div>
          ${stampsHtml(c, pop)}
          <div class="small">${left === 1 ? '<strong>Just 1 more</strong>' : `<strong>${left} more</strong>`} to earn: ${esc(c.reward)}</div>
        </div>`;
      })
      .join('') || '<p class="muted">No stamp cards running right now.</p>'}</div>
    </div></div>`;
  lastStamps = Object.fromEntries(data.cards.map((c) => [c.program_id, c.stamps]));
  $('#toRewards')?.addEventListener('click', () => ((tab = 'rewards'), renderApp()));
  renderInstallTip();
  startLiveQr();
  renderPushTip();
  renderWalletButtons();
}

// ------------------------------------------------------------------ live QR
// A new code every 30 seconds (TOTP, same as Google Wallet's rotating barcode), computed on the phone
// from the member's secret, so it works offline and a screenshot is useless a minute later.
const hexBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function totp(keyHex, counter, digits) {
  const key = await crypto.subtle.importKey('raw', hexBytes(keyHex), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
let liveTimer = null, liveCounter = null;
function startLiveQr() {
  clearInterval(liveTimer);
  liveCounter = null;
  const tick = async () => {
    const el = $('#liveqr');
    if (!el) return clearInterval(liveTimer);
    const { key, period, digits } = data.qr;
    const now = Date.now() / 1000;
    const counter = Math.floor(now / period);
    $('#qrbar').style.width = `${(1 - (now % period) / period) * 100}%`;
    if (counter === liveCounter) return;
    liveCounter = counter;
    const text = `FR2:${data.member.code}:${counter * period}:${await totp(key, counter, digits)}`;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  tick();
  liveTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ push notifications
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function enablePush(prefs) {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked — allow them in your phone settings for this app');
  const { publicKey } = await api('/api/push/key');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
  await api('/api/m/push/subscribe', { body: { subscription: sub.toJSON(), ...prefs } });
}
async function disablePush() {
  const sub = await currentPushSub();
  if (!sub) return;
  await api('/api/m/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
async function renderPushTip() {
  const el = $('#pushTip');
  if (!el) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('pushTipDismissed') === '1'; } catch {}
  if (dismissed || !pushSupported() || Notification.permission !== 'default' || (await currentPushSub())) return (el.innerHTML = '');
  el.innerHTML = `<div class="install-tip" style="margin-top:16px"><span style="flex:1">🔔 Get a heads-up when you earn a stamp or reward.</span>
    <button class="btn sm primary" id="pushOn">Turn on</button><button class="btn sm" id="pushX" aria-label="Dismiss">✕</button></div>`;
  $('#pushOn').onclick = async () => {
    try {
      await enablePush({ updates: true, marketing: false });
      el.innerHTML = '';
      toast('Notifications on 🔔');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#pushX').onclick = () => {
    try { localStorage.setItem('pushTipDismissed', '1'); } catch {}
    el.innerHTML = '';
  };
}

// ------------------------------------------------------------------ wallet cards
function renderWalletButtons() {
  const el = $('#walletBtns');
  const w = data.wallet || {};
  const showApple = w.apple && isIOS;
  const showGoogle = w.google && !isIOS;
  if (!el || (!showApple && !showGoogle)) return;
  el.innerHTML = `<div class="wallet-row">
    ${showApple ? `<a class="btn wallet-btn" href="/api/m/wallet/apple"><span aria-hidden="true"></span> ${w.has_apple ? 'Update Apple Wallet card' : 'Add to Apple Wallet'}</a>` : ''}
    ${showGoogle ? `<button class="btn wallet-btn" id="gwallet">${w.has_google ? 'Open in Google Wallet' : 'Add to Google Wallet'}</button>` : ''}
  </div>
  ${showApple ? '<p class="small muted" style="text-align:center;margin:6px 0 0">Your Wallet card shows your stamps and pops up near the pub. To get stamped, open this live card.</p>' : ''}`;
  $('#gwallet')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      location.href = (await api('/api/m/wallet/google')).url;
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  });
}

function renderRewards() {
  $('#app-main').innerHTML = `
    <h2 style="margin-top:4px">Your rewards</h2>
    ${data.vouchers.length
      ? `<p class="muted">To claim, show your live card to the team and tell them which reward you'd like.</p>
         <div class="stack grid-2">${data.vouchers
           .map(
             (v) => `<div class="card voucher"><div class="ico">${v.source === 'birthday' ? '🎂' : '🎁'}</div><div>
              <div class="t">${esc(v.title)}</div>
              <div class="small muted">${v.expires_at ? 'Valid until ' + fmtDate(v.expires_at) : 'No expiry'}</div></div></div>`
           )
           .join('')}</div>
         <p style="text-align:center;margin-top:20px"><button class="btn primary" id="showCard">Show my card</button></p>`
      : `<div class="card" style="text-align:center"><div style="font-size:40px">🎁</div><p>No rewards yet. Fill a stamp card to earn one!</p></div>`}`;
  $('#showCard')?.addEventListener('click', () => ((tab = 'card'), renderApp()));
}

function renderSpecials() {
  const list = data.specials;
  $('#app-main').innerHTML = `
    <h2 style="margin-top:4px">What's on</h2>
    <div class="stack grid-2">${list.length
      ? list
          .map(
            (s) => `<article class="card special">
              ${s.image_url ? `<img src="${esc(s.image_url)}" alt="" loading="lazy" />` : ''}
              ${s.pinned ? '<div class="pin">Featured</div>' : ''}
              <h3>${esc(s.title)}</h3>
              ${s.starts_on || s.ends_on ? `<div class="small muted">${s.starts_on ? fmtDate(s.starts_on) : ''}${s.ends_on && s.ends_on !== s.starts_on ? ' – ' + fmtDate(s.ends_on) : ''}</div>` : ''}
              ${s.body ? `<p>${esc(s.body)}</p>` : ''}
            </article>`
          )
          .join('')
      : '<div class="card muted" style="text-align:center">Nothing posted right now — check back soon!</div>'}</div>`;
}

async function renderProfile() {
  const m = data.member;
  const main = $('#app-main');
  main.innerHTML = `
    <h2 style="margin-top:4px">Profile</h2>
    <div class="profile-layout"><div>
    <form class="card" id="pf">
      <label>Name<input name="name" value="${esc(m.name)}" required /></label>
      <label>Email<input value="${esc(m.email || '')}" disabled /></label>
      <label>Mobile number<input name="phone" type="tel" value="${m.phone ? '+' + esc(m.phone) : ''}" placeholder="082 123 4567" /></label>
      ${m.birthday
        ? `<label>Birthday<input value="${esc(new Date(2000, Number(m.birthday.slice(0, 2)) - 1, Number(m.birthday.slice(3))).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' }))}" disabled /></label>`
        : `<label>Birthday <span class="muted" style="font-weight:400">(can only be set once)</span>${birthdayFields()}</label>`}
      <label>Card number<input value="${esc(m.code.replace(/(.{4})/, '$1 '))}" disabled /></label>
      <div class="section-title" style="margin-top:14px">Marketing</div>
      <label class="check"><input type="checkbox" name="marketing_email" ${m.marketing_email ? 'checked' : ''} /> <span>Email me specials and events</span></label>
      <label class="check"><input type="checkbox" name="marketing_whatsapp" ${m.marketing_whatsapp ? 'checked' : ''} /> <span>WhatsApp me specials and events</span></label>
      <p class="error" id="err"></p>
      <button class="btn primary block" type="submit">Save</button>
    </form>
    </div><div>
    <div class="section-title section-first">Notifications on this device</div>
    <div class="card" id="notif"><p class="muted" style="margin:0">Checking…</p></div>
    <div class="section-title">Recent activity</div>
    <div class="card"><ul class="history" id="hist"><li class="muted">Loading…</li></ul></div>
    <div class="section-title">Account</div>
    <div class="stack">
      <button class="btn block" id="logout">Sign out</button>
      <button class="btn block danger" id="del">Delete my account and data</button>
    </div>
    </div></div>`;
  const f = $('#pf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, phone: f.phone.value, marketing_email: f.marketing_email.checked, marketing_whatsapp: f.marketing_whatsapp.checked };
    if (!m.birthday && f.bmonth) {
      const b = birthdayValue(f);
      if (b && !confirm(`Set your birthday to ${f.bday.value} ${MONTHS[f.bmonth.value - 1]}? This can't be changed later.`)) return;
      if (b) body.birthday = b;
    }
    try {
      await api('/api/m/me', { method: 'PATCH', body });
      toast('Saved');
      await loadMe();
    } catch (err) {
      $('#err').textContent = err.message;
    }
  };
  $('#logout').onclick = async () => {
    await api('/api/m/logout', { body: {} });
    knownVouchers = null;
    showWelcome();
  };
  $('#del').onclick = async () => {
    if (!confirm('Delete your account? Your stamps and rewards will be lost. This cannot be undone.')) return;
    await api('/api/m/me', { method: 'DELETE' });
    knownVouchers = null;
    toast('Your account has been deleted');
    showWelcome();
  };
  renderNotificationPrefs();
  const hist = await api('/api/m/history');
  const label = (h) =>
    h.type === 'stamp' ? `${esc(h.emoji || '⭐')} ${h.qty} stamp${h.qty > 1 ? 's' : ''} · ${esc(h.program)}` : h.type === 'redeem' ? `🎁 Redeemed: ${esc(h.voucher)}` : `🎉 Gift: ${esc(h.voucher)}`;
  $('#hist').innerHTML = hist.length ? hist.map((h) => `<li><span>${label(h)}</span><span class="muted">${fmtDate(h.created_at)}</span></li>`).join('') : '<li class="muted">Nothing yet</li>';
}

async function renderNotificationPrefs() {
  const el = $('#notif');
  if (!el) return;
  if (!pushSupported()) {
    el.innerHTML = `<p class="small muted" style="margin:0">${isIOS && !isStandalone()
      ? 'On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there to turn on notifications.'
      : "This browser doesn't support notifications."}</p>`;
    return;
  }
  const sub = await currentPushSub();
  const state = sub ? await api('/api/m/push').catch(() => ({})) : {};
  const blocked = Notification.permission === 'denied';
  el.innerHTML = `
    <label class="check"><input type="checkbox" id="nUpdates" ${sub && state.updates ? 'checked' : ''} ${blocked ? 'disabled' : ''} /> <span>Stamps and rewards on my card</span></label>
    <label class="check"><input type="checkbox" id="nMarketing" ${sub && state.marketing ? 'checked' : ''} ${blocked ? 'disabled' : ''} /> <span>Specials and events</span></label>
    ${blocked ? '<p class="small muted" style="margin:0">Notifications are blocked for this app — allow them in your phone settings.</p>' : ''}`;
  const save = async () => {
    const updates = $('#nUpdates').checked, marketing = $('#nMarketing').checked;
    try {
      if (!updates && !marketing) await disablePush();
      else await enablePush({ updates, marketing });
      toast('Notification settings saved');
    } catch (err) {
      toast(err.message, true);
      renderNotificationPrefs();
    }
  };
  $('#nUpdates').onchange = save;
  $('#nMarketing').onchange = save;
}

function celebrate(v) {
  const el = document.createElement('div');
  el.className = 'celebrate';
  el.innerHTML = `<div class="card"><div class="big">${v.source === 'birthday' ? '🎂' : '🎉'}</div><h2>You earned a reward!</h2><p><strong>${esc(v.title)}</strong></p><button class="btn primary block">Nice!</button></div>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.appendChild(el);
  navigator.vibrate?.(200);
}

// Refresh while the card is open so stamps appear the moment staff add them.
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && (tab === 'card' || tab === 'rewards')) loadMe().catch(() => {});
  }, 8000);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && data && loadMe().catch(() => {}));

// ------------------------------------------------------------------ install prompt
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (tab === 'card' && $('#installTip')) renderInstallTip();
});
function renderInstallTip() {
  const el = $('#installTip');
  if (!el) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('installTipDismissed') === '1'; } catch {}
  if (standalone || dismissed) return (el.innerHTML = '');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!deferredInstall && !ios) return (el.innerHTML = '');
  el.innerHTML = `<div class="install-tip" style="margin-top:16px"><span style="flex:1">${
    ios ? 'Add your card to your home screen (tap <strong>Share</strong> then <strong>Add to Home Screen</strong>) — then open it from there to get stamp and reward notifications.' : 'Add your card to your home screen for quick access.'
  }</span>${deferredInstall ? '<button class="btn sm primary" id="inst">Add</button>' : ''}<button class="btn sm" id="instX" aria-label="Dismiss">✕</button></div>`;
  $('#inst')?.addEventListener('click', async () => {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    el.innerHTML = '';
  });
  $('#instX').onclick = () => {
    try { localStorage.setItem('installTipDismissed', '1'); } catch {}
    el.innerHTML = '';
  };
}

// ------------------------------------------------------------------ boot
(async () => {
  brand = await api('/api/brand').catch(() => brand);
  document.title = `${brand.name} Rewards`;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const wanted = new URLSearchParams(location.search).get('tab');
  if (['card', 'rewards', 'specials', 'profile'].includes(wanted)) tab = wanted;
  await loadMe(true);
})();
