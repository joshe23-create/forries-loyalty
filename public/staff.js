'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const root = $('#root');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let me = null;
let brand = { name: 'Rewards' };
let tab = 'scan';
let current = null; // member view currently open

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin(false);
    throw new Error('Please sign in');
  }
  if (!res.ok) throw new Error(json.error || 'Something went wrong');
  return json;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2500);
}

// Dates from the API are ISO timestamps; plain YYYY-MM-DD values are calendar days.
const parseUtc = (s) => new Date(s);
const fmtDate = (s) => (s.length === 10 ? new Date(s + 'T12:00:00') : parseUtc(s)).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (s) => parseUtc(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const phoneFmt = (p) => (p ? '+' + p : '');

function dialog(title, html, onSubmit, submitLabel = 'Save') {
  const d = $('#dialog');
  const form = $('#dialogForm');
  form.innerHTML = `<h2>${esc(title)}</h2>${html}<p class="error" id="dlgErr"></p>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div>`;
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await onSubmit(new FormData(form), form);
      d.close();
    } catch (err) {
      $('#dlgErr').textContent = err.message;
    }
  };
  d.showModal();
}

// ------------------------------------------------------------------ auth
async function showLogin(setup) {
  stopCamera();
  root.innerHTML = `
    <div class="hero" style="padding:32px 24px"><h1 class="wordmark">${esc(brand.name)}<small>Staff</small></h1></div>
    <form class="pad" id="lf" style="max-width:420px;margin:0 auto">
      <h2>${setup ? 'Create the manager account' : 'Staff sign in'}</h2>
      ${setup ? '<label>Your name<input name="name" required autocomplete="name" /></label>' : ''}
      <label>Email<input name="email" type="email" required autocomplete="username" /></label>
      <label>Password<input name="password" type="password" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}" /></label>
      <p class="error" id="err"></p>
      <button class="btn primary block">${setup ? 'Create account' : 'Sign in'}</button>
    </form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(setup ? '/api/s/setup' : '/api/s/login', { body: { name: f.name?.value, email: f.email.value, password: f.password.value } });
      boot();
    } catch (err) {
      $('#err').textContent = err.message;
    }
  };
}

// ------------------------------------------------------------------ shell
const TABS = [
  ['scan', 'Scan', false],
  ['members', 'Members', false],
  ['dashboard', 'Dashboard', true],
  ['programs', 'Stamp cards', true],
  ['specials', "What's on", true],
  ['messages', 'Messages', true],
  ['settings', 'Team & settings', true],
];

function renderShell() {
  root.innerHTML = `
    <header class="s-top">
      <div class="bar"><div class="wordmark">${esc(brand.name)} <span style="font-family:system-ui;font-size:13px;color:var(--accent);letter-spacing:.15em">STAFF</span></div>
        <div class="who">${esc(me.name)} · <button class="link" id="out">Sign out</button></div></div>
      <nav class="s-tabs" id="tabs">${TABS.filter(([, , adm]) => !adm || me.role === 'admin')
        .map(([k, l]) => `<button data-tab="${k}">${l}</button>`)
        .join('')}</nav>
    </header>
    <main class="s-main" id="main"></main>`;
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) go(b.dataset.tab);
  };
  $('#out').onclick = async () => {
    await api('/api/s/logout', { body: {} });
    showLogin(false);
  };
}

function go(t) {
  tab = t;
  stopCamera();
  $('#main').onclick = null;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  ({ scan: renderScan, members: renderMembers, dashboard: renderDashboard, programs: renderPrograms, specials: renderSpecials, messages: renderMessages, settings: renderSettings })[t]();
}

// ------------------------------------------------------------------ scanning
let stream = null;
let scanRaf = null;

function stopCamera() {
  cancelAnimationFrame(scanRaf);
  scanRaf = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function renderScan() {
  current = null;
  $('#main').innerHTML = `
    <div class="card stack">
      <div class="scanner" id="scanner"><video id="video" playsinline muted></video><div class="frame"></div><div class="msg" id="scanMsg">Starting camera…</div></div>
      <form id="manual" class="row" autocomplete="off">
        <input name="q" placeholder="Or type card code, phone or email" autocapitalize="characters" />
        <button class="btn primary" style="flex:none">Find</button>
      </form>
    </div>
    <div id="results"></div>`;
  $('#manual').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) lookup(q);
  };
  startCamera();
}

async function startCamera() {
  const msg = $('#scanMsg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'Camera not available here — type the code below';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    msg.textContent = 'Camera blocked — allow camera access or type the code below';
    return;
  }
  if (tab !== 'scan') return stopCamera();
  const video = $('#video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  msg.textContent = "Point at the customer's QR code";

  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = 0;
  const tick = async (t) => {
    if (!stream) return;
    scanRaf = requestAnimationFrame(tick);
    if (t - last < 200 || video.readyState < 2) return;
    last = t;
    let text = null;
    try {
      if (detector) {
        const codes = await detector.detect(video);
        text = codes[0]?.rawValue;
      } else if (window.jsQR) {
        const w = Math.min(640, video.videoWidth), h = Math.round((w / video.videoWidth) * video.videoHeight);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        text = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data;
      }
    } catch {}
    if (text && stream) {
      navigator.vibrate?.(80);
      stopCamera();
      openMember(text.trim());
    }
  };
  scanRaf = requestAnimationFrame(tick);
}

async function lookup(q) {
  const clean = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Exact card code first, then a search.
  if (/^[A-Z2-9]{8}$/.test(clean)) {
    try {
      return await openMember(clean, true);
    } catch {}
  }
  const rows = await api('/api/s/members?q=' + encodeURIComponent(q));
  if (rows.length === 1) return openMember(rows[0].code);
  $('#results').innerHTML = `<div class="card" style="margin-top:16px">${
    rows.length ? memberTable(rows) : '<p class="muted" style="margin:0">No members found.</p>'
  }</div>`;
  bindMemberTable($('#results'));
}

function memberTable(rows) {
  return `<table class="t"><thead><tr><th>Name</th><th>Contact</th><th>Last visit</th></tr></thead><tbody>${rows
    .map(
      (r) => `<tr class="click" data-code="${esc(r.code)}"><td><strong>${esc(r.name)}</strong><div class="small muted">${esc(r.code)}</div></td>
        <td class="small">${esc(r.email || '')}<br>${esc(phoneFmt(r.phone))}</td><td class="small">${r.last_visit_at ? fmtDate(r.last_visit_at) : '—'}</td></tr>`
    )
    .join('')}</tbody></table>`;
}
function bindMemberTable(el) {
  el.querySelectorAll('tr[data-code]').forEach((tr) => (tr.onclick = () => openMember(tr.dataset.code)));
}

// ------------------------------------------------------------------ member panel
async function openMember(code, quiet) {
  stopCamera();
  let view;
  try {
    view = await api('/api/s/members/' + encodeURIComponent(code));
  } catch (err) {
    if (quiet) throw err;
    toast(err.message, true);
    if (tab === 'scan') renderScan();
    return;
  }
  current = view;
  renderMember();
}

const qty = {};
function renderMember() {
  const v = current;
  const m = v.member;
  const admin = me.role === 'admin';
  const bday = m.birthday ? new Date(2000, Number(m.birthday.slice(0, 2)) - 1, Number(m.birthday.slice(3))).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' }) : null;
  $('#main').innerHTML = `
    <div class="toolbar"><button class="btn" id="next">← ${tab === 'scan' ? 'Scan next customer' : 'Back'}</button>
      ${admin ? '<span class="row" style="flex:none"><button class="btn sm" id="edit">Edit details</button><button class="btn sm" id="gift">🎉 Gift reward</button></span>' : ''}</div>
    <div class="card m-head">
      <div><h2>${esc(m.name)}</h2><div class="small muted">Card ${esc(m.code)} · member since ${fmtDate(m.created_at)}</div></div>
      <div class="small" style="text-align:right">${esc(m.email || '')}<br>${esc(phoneFmt(m.phone))}${bday ? `<br>🎂 ${esc(bday)}` : ''}</div>
    </div>
    <div class="section-title">Rewards ready (${v.vouchers.length})</div>
    <div class="stack">${
      v.vouchers.length
        ? v.vouchers
            .map(
              (x) => `<div class="card voucher"><div class="ico">${x.source === 'birthday' ? '🎂' : '🎁'}</div>
              <div style="flex:1"><div class="t">${esc(x.title)}</div><div class="small muted">${x.expires_at ? 'Valid until ' + fmtDate(x.expires_at) : 'No expiry'}</div></div>
              <button class="btn accent" data-redeem="${x.id}">Redeem</button></div>`
            )
            .join('')
        : '<div class="card muted">No rewards to claim.</div>'
    }</div>
    <div class="section-title">Add stamps</div>
    <div class="card">${v.cards
      .map((c) => {
        qty[c.program_id] ??= 1;
        return `<div class="prog">
          <div class="nm"><strong>${esc(c.emoji)} ${esc(c.name)}</strong> <span class="muted small">${c.stamps}/${c.stamps_required}</span>
            <div class="bar"><i style="width:${(c.stamps / c.stamps_required) * 100}%"></i></div></div>
          <div class="stepper"><button data-dec="${c.program_id}" aria-label="Fewer">−</button><span id="q${c.program_id}">${qty[c.program_id]}</span><button data-inc="${c.program_id}" aria-label="More">+</button></div>
          <button class="btn primary" data-stamp="${c.program_id}">Stamp</button>
        </div>`;
      })
      .join('') || '<p class="muted">No active stamp cards.</p>'}</div>
    <div class="section-title">Recent activity</div>
    <div class="card"><ul class="act">${
      v.recent.length
        ? v.recent
            .map((t) => {
              const label =
                t.type === 'stamp' ? `${esc(t.emoji || '')} +${t.qty} ${esc(t.program || '')}` : t.type === 'redeem' ? `🎁 Redeemed: ${esc(t.voucher || '')}` : `🎉 Gift: ${esc(t.voucher || '')}`;
              return `<li><span class="${t.undone ? 'undone' : ''}">${label}<span class="muted small"> · ${fmtTime(t.created_at)}${t.staff ? ' · ' + esc(t.staff) : ''}</span></span>
                ${t.can_undo ? `<button class="btn sm" data-undo="${t.id}">Undo</button>` : ''}</li>`;
            })
            .join('')
        : '<li class="muted">No activity yet</li>'
    }</ul></div>`;

  const main = $('#main');
  $('#next').onclick = () => (tab === 'scan' ? renderScan() : go(tab));
  main.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.inc || d.dec) {
      const id = d.inc || d.dec;
      qty[id] = Math.max(1, Math.min(10, qty[id] + (d.inc ? 1 : -1)));
      $('#q' + id).textContent = qty[id];
    } else if (d.stamp) {
      b.disabled = true;
      try {
        const r = await api(`/api/s/members/${m.code}/stamp`, { body: { program_id: d.stamp, qty: qty[d.stamp] } });
        current = r.view;
        qty[d.stamp] = 1;
        renderMember();
        toast(r.earned ? `🎁 Card complete! Reward earned: ${r.reward}` : `Stamped ✓`);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
    } else if (d.redeem) {
      const vch = v.vouchers.find((x) => x.id === d.redeem);
      if (!confirm(`Redeem "${vch.title}" for ${m.name}?`)) return;
      try {
        const r = await api(`/api/s/members/${m.code}/redeem`, { body: { voucher_id: vch.id } });
        current = r.view;
        renderMember();
        toast('Redeemed ✓ — enjoy!');
      } catch (err) {
        toast(err.message, true);
      }
    } else if (d.undo) {
      try {
        await api(`/api/s/tx/${d.undo}/undo`, { body: {} });
        current = await api('/api/s/members/' + m.code);
        renderMember();
        toast('Undone');
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
  $('#gift')?.addEventListener('click', () =>
    dialog(
      `Gift a reward to ${m.name}`,
      `<label>Reward<input name="title" required placeholder="e.g. Free dessert — sorry about the wait!" /></label>
       <label>Valid for (days)<input name="valid_days" type="number" min="1" value="30" /></label>`,
      async (fd) => {
        const r = await api(`/api/s/members/${m.code}/gift`, { body: Object.fromEntries(fd) });
        current = r.view;
        renderMember();
        toast('Reward added');
      },
      'Gift'
    )
  );
  $('#edit')?.addEventListener('click', () => {
    const [bm, bd] = m.birthday ? m.birthday.split('-').map(Number) : [0, 0];
    dialog(
      'Edit member',
      `<label>Name<input name="name" value="${esc(m.name)}" required /></label>
       <label>Email<input name="email" type="email" value="${esc(m.email || '')}" required /></label>
       <label>Mobile<input name="phone" value="${esc(phoneFmt(m.phone))}" /></label>
       <label>Birthday<div class="row"><select name="bmonth"><option value="">Month</option>${MONTHS.map((x, i) => `<option value="${i + 1}" ${bm === i + 1 ? 'selected' : ''}>${x}</option>`).join('')}</select>
         <select name="bday"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option ${bd === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div></label>`,
      async (fd) => {
        const birthday = fd.get('bmonth') && fd.get('bday') ? `${fd.get('bmonth')}-${fd.get('bday')}` : '';
        const r = await api(`/api/s/members/${m.code}`, { method: 'PATCH', body: { name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), birthday } });
        current = r.view;
        renderMember();
        toast('Saved');
      }
    );
  });
}

// ------------------------------------------------------------------ members list
async function renderMembers() {
  $('#main').innerHTML = `
    <div class="toolbar"><h2>Members</h2>${me.role === 'admin' ? '<a class="btn sm" href="/api/s/export.csv">Export CSV</a>' : ''}</div>
    <div class="card"><input id="mq" type="search" placeholder="Search name, email, phone or card code" /><div id="mlist" style="margin-top:12px"></div></div>`;
  const load = async () => {
    const rows = await api('/api/s/members?q=' + encodeURIComponent($('#mq').value.trim()));
    $('#mlist').innerHTML = rows.length ? memberTable(rows) : '<p class="muted">No members found.</p>';
    bindMemberTable($('#mlist'));
  };
  let t;
  $('#mq').oninput = () => (clearTimeout(t), (t = setTimeout(load, 250)));
  load();
}

// ------------------------------------------------------------------ dashboard
function barChart(daily) {
  // Fill in days with no activity so the time axis is continuous.
  const days = [];
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d]));
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400e3);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    days.push({ day: key, stamps: byDay[key]?.stamps || 0, redeemed: byDay[key]?.redeemed || 0 });
  }
  const W = 640, H = 220, L = 34, R = 8, T = 12, B = 26;
  const max = Math.max(4, ...days.map((d) => d.stamps));
  const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1);
  const top = Math.ceil(max / step) * step;
  const cw = (W - L - R) / days.length;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const label = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  const bars = days
    .map((d, i) => {
      const x = L + i * cw + 1, w = cw - 2, y0 = y(0), y1 = y(d.stamps), h = y0 - y1, r = Math.min(4, w / 2, h);
      const shape = d.stamps ? `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z" fill="var(--brand)"/>` : '';
      return `<g class="col" data-i="${i}">${shape}<rect x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent"/></g>`;
    })
    .join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stamps given per day over the last 30 days">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e9e2d3" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6c736e">${v}</text>`).join('')}
    ${bars}
    ${[0, 7, 14, 21, 29].map((i) => `<text x="${L + i * cw + cw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6c736e">${label(days[i].day)}</text>`).join('')}
  </svg>`;
  return { svg, days, label, pos: (i) => ({ x: ((L + i * cw + cw / 2) / W) * 100, y: (vy) => (vy / H) * 100 }), y };
}

async function renderDashboard() {
  const s = await api('/api/s/stats');
  const chart = barChart(s.daily);
  const tile = (v, l) => `<div class="tile"><div class="v">${Number(v).toLocaleString('en-ZA')}</div><div class="l">${l}</div></div>`;
  $('#main').innerHTML = `
    <div class="toolbar"><h2>Dashboard</h2><a class="btn sm" href="/api/s/export.csv">Export members (CSV)</a></div>
    <div class="tiles">
      ${tile(s.members, 'Members')}${tile(s.new30, 'New in last 30 days')}${tile(s.active30, 'Visited in last 30 days')}
      ${tile(s.stamps30, 'Stamps given (30 days)')}${tile(s.redeemed30, 'Rewards redeemed (30 days)')}${tile(s.outstanding, 'Rewards waiting to be claimed')}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="toolbar" style="margin-bottom:6px"><strong>Stamps given per day — last 30 days</strong><button class="btn sm" id="asTable">Show as table</button></div>
      <div class="chart-wrap" id="chart">${chart.svg}<div class="tip hidden" id="tip"></div></div>
      <div id="chartTable" class="hidden" style="max-height:300px;overflow:auto"><table class="t"><thead><tr><th>Day</th><th class="num">Stamps</th><th class="num">Redeemed</th></tr></thead><tbody>${chart.days
        .slice()
        .reverse()
        .map((d) => `<tr><td>${chart.label(d.day)}</td><td class="num">${d.stamps}</td><td class="num">${d.redeemed}</td></tr>`)
        .join('')}</tbody></table></div>
    </div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><strong>Stamp cards (last 30 days)</strong>
        <table class="t" style="margin-top:8px"><thead><tr><th>Card</th><th class="num">Stamps</th><th class="num">Redeemed</th></tr></thead><tbody>${s.programs
          .map((p) => `<tr><td>${esc(p.emoji)} ${esc(p.name)} ${p.active ? '' : '<span class="pill off">off</span>'}</td><td class="num">${p.stamps30}</td><td class="num">${p.redeemed30}</td></tr>`)
          .join('')}</tbody></table></div>
      <div class="card"><strong>Top regulars (last 90 days)</strong>
        <table class="t" style="margin-top:8px"><thead><tr><th>Member</th><th class="num">Stamps</th></tr></thead><tbody>${
          s.top.map((m) => `<tr class="click" data-code="${esc(m.code)}"><td>${esc(m.name)}</td><td class="num">${m.stamps}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No stamps yet</td></tr>'
        }</tbody></table></div>
    </div>
    <div class="card small muted" style="margin-top:16px">Marketing opt-ins: <strong>${s.optEmail}</strong> by email, <strong>${s.optWhatsApp}</strong> by WhatsApp.</div>`;
  bindMemberTable($('#main'));
  $('#asTable').onclick = (e) => {
    const showTable = $('#chartTable').classList.toggle('hidden') === false;
    $('#chart').classList.toggle('hidden', showTable);
    e.target.textContent = showTable ? 'Show as chart' : 'Show as table';
  };
  const tip = $('#tip');
  $('#chart svg').addEventListener('mousemove', (e) => {
    const g = e.target.closest('.col');
    if (!g) return tip.classList.add('hidden');
    const i = Number(g.dataset.i), d = chart.days[i], p = chart.pos(i);
    tip.innerHTML = `<strong>${chart.label(d.day)}</strong><br>${d.stamps} stamp${d.stamps === 1 ? '' : 's'} · ${d.redeemed} redeemed`;
    tip.style.left = p.x + '%';
    tip.style.top = p.y(chart.y(d.stamps)) + '%';
    tip.classList.remove('hidden');
  });
  $('#chart svg').addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

// ------------------------------------------------------------------ stamp cards
async function renderPrograms() {
  const list = await api('/api/s/programs');
  $('#main').innerHTML = `
    <div class="toolbar"><h2>Stamp cards</h2><button class="btn primary" id="add">+ New stamp card</button></div>
    <div class="card"><table class="t"><thead><tr><th>Card</th><th class="num">Stamps</th><th>Reward</th><th>Status</th><th></th></tr></thead><tbody>${list
      .map(
        (p) => `<tr><td>${esc(p.emoji)} <strong>${esc(p.name)}</strong></td><td class="num">${p.stamps_required}</td>
        <td>${esc(p.reward)}<div class="small muted">valid ${p.reward_valid_days} days</div></td>
        <td><span class="pill ${p.active ? '' : 'off'}">${p.active ? 'Active' : 'Off'}</span></td>
        <td style="text-align:right"><button class="btn sm" data-edit="${p.id}">Edit</button></td></tr>`
      )
      .join('')}</tbody></table>
      <p class="small muted">Turning a card off hides it from customers and staff; existing stamps are kept. Changing "stamps needed" applies from the next stamp.</p></div>`;
  const form = (p = {}) => `
    <div class="row"><label style="flex:0 0 90px">Emoji<input name="emoji" value="${esc(p.emoji || '⭐')}" /></label><label>Name<input name="name" value="${esc(p.name || '')}" required placeholder="e.g. Burger card" /></label></div>
    <label>Stamps needed for a reward<input name="stamps_required" type="number" min="2" max="50" value="${p.stamps_required || 9}" required /></label>
    <label>Reward<input name="reward" value="${esc(p.reward || '')}" required placeholder="e.g. Free burger" /></label>
    <label>Reward valid for (days)<input name="reward_valid_days" type="number" min="1" value="${p.reward_valid_days || 90}" /></label>
    <label>Display order<input name="sort" type="number" value="${p.sort ?? 0}" /></label>
    <label class="check"><input type="checkbox" name="active" ${p.active !== 0 ? 'checked' : ''} /> <span>Active</span></label>`;
  const read = (fd, f) => ({ ...Object.fromEntries(fd), active: f.active.checked });
  $('#add').onclick = () => dialog('New stamp card', form(), async (fd, f) => (await api('/api/s/programs', { body: read(fd, f) }), renderPrograms()), 'Create');
  $('#main').querySelectorAll('[data-edit]').forEach(
    (b) =>
      (b.onclick = () => {
        const p = list.find((x) => x.id === b.dataset.edit);
        dialog('Edit stamp card', form(p), async (fd, f) => (await api('/api/s/programs/' + p.id, { method: 'PATCH', body: read(fd, f) }), renderPrograms()));
      })
  );
}

// ------------------------------------------------------------------ specials
async function renderSpecials() {
  const list = await api('/api/s/specials');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const state = (s) => (s.ends_on && s.ends_on < today ? ['Ended', 'off'] : s.starts_on && s.starts_on > today ? ['Scheduled', 'off'] : ['Live', '']);
  $('#main').innerHTML = `
    <div class="toolbar"><h2>What's on</h2><button class="btn primary" id="add">+ New post</button></div>
    <p class="muted small" style="margin-top:0">Specials and events show in the "What's on" tab of the customer app between their start and end dates.</p>
    <div class="stack">${
      list
        .map((s) => {
          const [label, cls] = state(s);
          return `<div class="card"><div class="m-head"><div><strong>${s.pinned ? '📌 ' : ''}${esc(s.title)}</strong> <span class="pill ${cls}">${label}</span>
            <div class="small muted">${s.starts_on ? fmtDate(s.starts_on) : 'Now'} → ${s.ends_on ? fmtDate(s.ends_on) : 'no end date'}</div></div>
            <span class="row" style="flex:none"><button class="btn sm" data-edit="${s.id}">Edit</button><button class="btn sm danger" data-del="${s.id}">Delete</button></span></div>
            ${s.body ? `<p style="white-space:pre-wrap;margin:8px 0 0">${esc(s.body)}</p>` : ''}</div>`;
        })
        .join('') || '<div class="card muted">Nothing posted yet.</div>'
    }</div>`;
  const form = (s = {}) => `
    <label>Title<input name="title" value="${esc(s.title || '')}" required placeholder="e.g. Quiz night — Tuesday 7pm" /></label>
    <label>Details<textarea name="body" rows="4">${esc(s.body || '')}</textarea></label>
    <label>Image link (optional, https://)<input name="image_url" type="url" value="${esc(s.image_url || '')}" /></label>
    <div class="row"><label>Show from<input name="starts_on" type="date" value="${esc(s.starts_on || '')}" /></label><label>Until<input name="ends_on" type="date" value="${esc(s.ends_on || '')}" /></label></div>
    <label class="check"><input type="checkbox" name="pinned" ${s.pinned ? 'checked' : ''} /> <span>Feature at the top</span></label>`;
  const read = (fd, f) => ({ ...Object.fromEntries(fd), pinned: f.pinned.checked });
  $('#add').onclick = () => dialog('New post', form(), async (fd, f) => (await api('/api/s/specials', { body: read(fd, f) }), renderSpecials()), 'Publish');
  $('#main').onclick = async (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.edit) {
      const s = list.find((x) => x.id === b.dataset.edit);
      dialog('Edit post', form(s), async (fd, f) => (await api('/api/s/specials/' + s.id, { method: 'PUT', body: read(fd, f) }), renderSpecials()));
    } else if (b?.dataset.del && confirm('Delete this post?')) {
      await api('/api/s/specials/' + b.dataset.del, { method: 'DELETE' });
      renderSpecials();
    }
  };
}

// ------------------------------------------------------------------ messages
async function renderMessages() {
  const [{ counts, history }, settings] = await Promise.all([api('/api/s/campaigns'), api('/api/s/settings')]);
  const AUD = { all: 'All opted-in members', active30: 'Visited in the last 30 days', lapsed60: "Haven't visited in 60+ days", birthday_month: 'Birthday this month' };
  $('#main').innerHTML = `
    <div class="toolbar"><h2>Messages</h2></div>
    <form class="card" id="cf">
      <p class="small muted" style="margin-top:0">Messages only go to members who opted in to that channel (POPIA). Every email includes an unsubscribe link.</p>
      <div class="row">
        <label>Channel<select name="channel">
          <option value="email" ${settings.channels.email ? '' : 'disabled'}>Email${settings.channels.email ? '' : ' (not set up)'}</option>
          <option value="whatsapp" ${settings.channels.whatsapp ? '' : 'disabled'}>WhatsApp${settings.channels.whatsapp ? '' : ' (not set up)'}</option></select></label>
        <label>Audience<select name="audience"></select></label>
      </div>
      <div id="emailFields">
        <label>Subject<input name="subject" placeholder="e.g. {{name}}, the Springboks are on this Saturday 🏉" /></label>
        <label>Message<textarea name="body" rows="7" placeholder="Hi {{name}},&#10;&#10;…"></textarea></label>
        <p class="small muted">Use <code>{{name}}</code> for the member's first name.</p>
      </div>
      <div id="waFields" class="hidden">
        <label>Approved template name<input name="template" placeholder="e.g. weekly_specials" /></label>
        <label class="check"><input type="checkbox" name="uses_name" /> <span>Template has <code>{{1}}</code> for the member's first name</span></label>
        <p class="small muted">WhatsApp only allows marketing messages from templates approved in Meta's WhatsApp Manager. Meta charges per marketing message delivered.</p>
      </div>
      <p class="error" id="err"></p>
      <button class="btn primary" id="sendBtn">Send</button>
    </form>
    <div class="section-title">Sent</div>
    <div class="card"><table class="t"><thead><tr><th>When</th><th>Message</th><th>Audience</th><th class="num">Sent</th><th class="num">Failed</th></tr></thead><tbody>${
      history
        .map(
          (c) => `<tr><td class="small">${fmtTime(c.created_at)}<div class="muted">${esc(c.staff || '')}</div></td><td>${c.channel === 'email' ? '✉️ ' + esc(c.subject) : '💬 ' + esc(c.template)}</td>
          <td class="small">${esc(AUD[c.audience] || c.audience)}</td><td class="num">${c.sent}</td><td class="num">${c.failed}</td></tr>`
        )
        .join('') || '<tr><td colspan="5" class="muted">Nothing sent yet.</td></tr>'
    }</tbody></table></div>`;
  const f = $('#cf');
  if (!settings.channels.email && settings.channels.whatsapp) f.channel.value = 'whatsapp';
  const sync = () => {
    const ch = f.channel.value;
    const prev = f.audience.value;
    f.audience.innerHTML = Object.entries(AUD).map(([k, l]) => `<option value="${k}">${l} (${counts[`${ch}:${k}`]})</option>`).join('');
    if (prev) f.audience.value = prev;
    $('#emailFields').classList.toggle('hidden', ch !== 'email');
    $('#waFields').classList.toggle('hidden', ch !== 'whatsapp');
  };
  f.channel.onchange = sync;
  sync();
  if (!settings.channels.email && !settings.channels.whatsapp) {
    $('#sendBtn').disabled = true;
    $('#err').textContent = 'Neither email nor WhatsApp is set up on the server yet — see the README.';
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    const n = counts[`${f.channel.value}:${f.audience.value}`];
    if (!confirm(`Send this ${f.channel.value === 'email' ? 'email' : 'WhatsApp message'} to ${n} member${n === 1 ? '' : 's'}?`)) return;
    try {
      const r = await api('/api/s/campaigns', {
        body: { channel: f.channel.value, audience: f.audience.value, subject: f.subject.value, body: f.body.value, template: f.template.value.trim(), uses_name: f.uses_name.checked },
      });
      toast(`Sending to ${r.recipients} members…`);
      setTimeout(renderMessages, 1500);
    } catch (err) {
      $('#err').textContent = err.message;
    }
  };
}

// ------------------------------------------------------------------ team & settings
async function renderSettings() {
  const [staff, st] = await Promise.all([api('/api/s/staff'), api('/api/s/settings')]);
  const joinUrl = st.signup_url || location.origin;
  $('#main').innerHTML = `
    <div class="toolbar"><h2>Team & settings</h2></div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:4px"><strong>Staff accounts</strong><button class="btn sm primary" id="addStaff">+ Add staff</button></div>
      <table class="t"><tbody>${staff
        .map((u) => `<tr><td><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}</div></td><td>${u.role === 'admin' ? 'Manager' : 'Staff'}</td>
          <td style="text-align:right">${u.id !== me.id ? `<button class="btn sm danger" data-del="${u.id}">Remove</button>` : ''}</td></tr>`)
        .join('')}</tbody></table>
      <p class="small muted">Staff can scan, stamp and redeem. Managers can also see the dashboard, edit cards and posts, send messages and manage the team.</p>
    </div>
    <form class="card" id="bf" style="margin-top:16px">
      <strong>Birthday reward</strong>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="birthday_enabled" ${st.birthday_enabled ? 'checked' : ''} /> <span>Give members a reward in their birthday month</span></label>
      <label>Reward<input name="birthday_reward" value="${esc(st.birthday_reward)}" /></label>
      <button class="btn primary">Save</button>
    </form>
    <div class="card" style="margin-top:16px">
      <strong>Sign-up poster</strong>
      <p class="small muted">Print this and put it on tables and the bar. Customers scan it to join.</p>
      <p class="small">Join link: <code>${esc(joinUrl)}</code></p>
      <button class="btn" id="poster">Open printable poster</button>
    </div>
    <div class="card small" style="margin-top:16px">
      <strong>Channels</strong>
      <p>Email: ${st.channels.email ? '✅ connected' : '⚪ not set up'} · WhatsApp: ${st.channels.whatsapp ? '✅ connected' : '⚪ not set up'}</p>
      <p class="muted">WhatsApp templates — login code: ${esc(st.whatsapp_templates.otp || 'not set')}, birthday: ${esc(st.whatsapp_templates.birthday || 'not set')}. These are configured on the server (see README).</p>
    </div>`;
  $('#addStaff').onclick = () =>
    dialog(
      'Add staff member',
      `<label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label>
       <label>Temporary password (8+ characters)<input name="password" minlength="8" required /></label>
       <label>Role<select name="role"><option value="staff">Staff</option><option value="admin">Manager</option></select></label>`,
      async (fd) => (await api('/api/s/staff', { body: Object.fromEntries(fd) }), renderSettings()),
      'Add'
    );
  $('#main').querySelectorAll('[data-del]').forEach(
    (b) => (b.onclick = async () => confirm('Remove this staff account?') && (await api('/api/s/staff/' + b.dataset.del, { method: 'DELETE' }), renderSettings()))
  );
  $('#bf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/s/settings', { method: 'PATCH', body: { birthday_enabled: e.target.birthday_enabled.checked, birthday_reward: e.target.birthday_reward.value } });
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#poster').onclick = () => window.open('/api/s/poster', '_blank');
}

// ------------------------------------------------------------------ boot
async function boot() {
  brand = await fetch('/api/brand').then((r) => r.json()).catch(() => brand);
  document.title = `${brand.name} Rewards – Staff`;
  try {
    me = await api('/api/s/me');
  } catch {
    const { needed } = await fetch('/api/s/setup').then((r) => r.json());
    return showLogin(needed);
  }
  renderShell();
  go('scan');
}
boot();
