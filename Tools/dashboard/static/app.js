// StudioPulse front end: plain JS, data from server.py (/api/*). All times shown in WIB.
const TZ = 'Asia/Jakarta';
const HEX = /^#[0-9A-Fa-f]{6}$/;  // a channel's own colour comes from channels.json "color"
const EXTRA = ['#A78BFA', '#F472B6', '#34D399', '#FB923C'];
const S = { meta: null, sel: 'all', page: 'overview', data: {}, projects: [], quota: null, errors: {},
  synced: null, metric: 'views', filters: { q: '', fmt: 'all', status: 'all', sort: 'release', dir: -1 },
  weekOffset: 0, onlyOpen: false, loading: true };
const CHARTS = {};
let lastFocus = null;

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => Number(v || 0);
function fmt(v, d = 1) {
  v = n(v); const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(d).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(d).replace(/\.0$/, '') + 'K';
  return (Number.isInteger(v) ? v : Math.round(v * 10) / 10).toLocaleString('id-ID');
}
const pct = v => v == null ? '–' : n(v).toFixed(1) + '%';
function isoSec(d) { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return n(m[1]) * 3600 + n(m[2]) * 60 + n(m[3]); }
function mmss(s) { s = Math.round(n(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
const wib = (iso, o) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, ...o }).format(new Date(iso));
const wibDate = iso => wib(iso, { day: 'numeric', month: 'short', year: 'numeric' });
const wibTime = iso => wib(iso, { hour: '2-digit', minute: '2-digit' });
const wibKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d instanceof Date ? d : new Date(d));
const slotWib = h => String((h + 7) % 24).padStart(2, '0') + ':00 WIB';
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) { const h = -s / 3600; return h < 24 ? `dalam ${Math.ceil(h)} jam` : `dalam ${Math.ceil(h / 24)} hari`; }
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}
const chMeta = k => S.meta.channels.find(c => c.key === k) || { key: k, title: k };
const chTitle = k => S.data[k]?.channel?.title || chMeta(k).title;
const color = k => { const c = chMeta(k).color; return HEX.test(c || '') ? c : EXTRA[Math.max(0, S.meta.channels.findIndex(x => x.key === k)) % EXTRA.length]; };
const connected = () => S.meta.channels.filter(c => c.connected).map(c => c.key);
const chans = () => S.sel === 'all' ? connected() : [S.sel];
const initials = t => esc((t || '?').replace('@', '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
function avatar(k, cls = '') {
  const th = S.data[k]?.channel?.thumbnail;
  return `<span class="av ${cls}" style="background:${color(k)}" aria-hidden="true">${th ? `<img src="${esc(th)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : initials(chTitle(k))}</span>`;
}
const chBadge = k => `<span class="chb"><span class="sw" style="background:${color(k)}" aria-hidden="true"></span>${esc(chTitle(k))}</span>`;
const clickable = (attr, label) => `${attr} tabindex="0" role="button"${label ? ` aria-label="${esc(label)}"` : ''}`;
const icon = (name, extra = '') => `<span class="ms" aria-hidden="true" ${extra}>${name}</span>`;

async function api(path, opts) {
  const r = await fetch('/api/' + path, opts);
  const j = await r.json().catch(() => ({ error: 'respon tidak valid' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function vstate(v) {
  if (v.privacy === 'private' && v.publish_at && new Date(v.publish_at) > Date.now()) return { k: 'scheduled', t: v.publish_at, label: 'Terjadwal', cls: 'a' };
  if (v.privacy === 'public') return { k: 'public', t: v.publish_at || v.published, label: 'Publik', cls: 'g' };
  if (v.privacy === 'unlisted') return { k: 'unlisted', t: v.published, label: 'Unlisted', cls: 'n' };
  return { k: 'private', t: v.published, label: 'Privat', cls: 'n' };
}
function allVideos() {
  const out = [];
  for (const ch of chans()) {
    const d = S.data[ch]; if (!d || !d.videos) continue;
    const an = {}; (d.analytics?.videos || []).forEach(r => an[r.video] = r);
    d.videos.forEach(v => out.push({ ...v, ch, st: vstate(v), sec: isoSec(v.duration), an: an[v.id] }));
  }
  return out;
}

// ---------- charts ----------
function spark(vals, c) {
  if (!vals.length || !vals.some(Boolean)) return `<svg viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="200" y1="40" y2="40" stroke="${c}" stroke-width="2" opacity=".35" vector-effect="non-scaling-stroke"/></svg>`;
  const max = Math.max(...vals, 1), w = 200, h = 44;
  const pts = vals.map((v, i) => [i / Math.max(1, vals.length - 1) * w, h - 4 - v / max * (h - 8)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w} ${h}L0 ${h}Z" fill="${c}" opacity=".12"/><path d="${d}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
// series: [{name, color, dash, vals}]. Paths are SVG; every label is HTML so nothing squashes on narrow screens.
function chart(id, series, { labels = [], fmtY = fmt, h = 280, area = true, empty = '', summary = '' } = {}) {
  const all = series.flatMap(s => s.vals);
  const raw = Math.max(...all, 4) * 1.08, mag = 10 ** Math.floor(Math.log10(raw / 4)), max = Math.ceil(raw / 4 / mag) * mag * 4;
  const len = Math.max(...series.map(s => s.vals.length), 2);
  CHARTS[id] = { series, labels, fmtY, len, max };
  const X = i => i / (len - 1) * 1000, Y = v => (1 - v / max) * 100, yp = v => `calc(10px + (100% - 36px) * ${(1 - v / max).toFixed(4)})`;
  let svg = '', html = '';
  for (let k = 0; k <= 4; k++) { const v = max * k / 4; svg += `<line x1="0" x2="1000" y1="${Y(v)}" y2="${Y(v)}" stroke="#27272A" vector-effect="non-scaling-stroke"/>`; html += `<span class="yl" style="top:${yp(v)}">${fmtY(v)}</span>`; }
  const step = Math.max(1, Math.ceil(len / 7));
  labels.forEach((l, i) => { if (i % step === 0) html += `<span class="xl${(i / step) % 2 ? ' alt' : ''}" style="left:calc(var(--pl) + (100% - var(--pl) - var(--pr)) * ${(i / (len - 1)).toFixed(4)})">${esc(l)}</span>`; });
  for (const s of series) {
    const d = s.vals.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(2)).join('');
    if (area) svg += `<path d="${d}L${X(s.vals.length - 1)} 100L0 100Z" fill="${s.color}" opacity=".10"/>`;
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dash ? 'stroke-dasharray="6 5"' : ''} vector-effect="non-scaling-stroke"/>`;
  }
  // end-of-line labels, nudged apart when the last values sit close together
  const ends = series.filter(s => s.name).map(s => ({ s, v: s.vals[s.vals.length - 1] || 0 })).sort((a, b) => b.v - a.v);
  let prev = null, shift = 0;
  for (const e of ends) {
    shift = prev && (prev.v - e.v) / max < 0.08 ? shift + 18 : 0; prev = e;
    html += `<span class="el" style="top:calc(${yp(e.v)} + ${shift}px);color:${e.s.color}">${esc(e.s.name)}</span>`;
  }
  const isEmpty = empty && !all.some(Boolean);
  return `<div class="chartbox" data-chart="${id}" style="height:${h}px" tabindex="0" role="img" aria-label="${esc(summary)}. Arahkan kursor atau tekan panah kiri/kanan untuk melihat angka per titik.">
    <div class="plot"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${svg}</svg></div>${html}
    <div class="cross"></div><div class="tip"></div>${isEmpty ? `<div class="chart-empty"><div>${empty}</div></div>` : ''}</div>`;
}
function showTip(box, idx) {
  const c = CHARTS[box.dataset.chart]; if (!c) return;
  idx = Math.max(0, Math.min(c.len - 1, idx)); box.dataset.idx = idx;
  const plot = box.querySelector('.plot'), pr = plot.getBoundingClientRect(), br = box.getBoundingClientRect();
  const x = pr.left - br.left + idx / (c.len - 1) * pr.width;
  box.querySelector('.cross').style.left = x + 'px';
  const tip = box.querySelector('.tip');
  tip.innerHTML = `<b>${esc(c.labels[idx] ?? '')}</b>` + c.series.filter(s => s.name).map(s => `<div><span class="chb"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><span class="num" style="font-weight:600">${c.fmtY(s.vals[idx] || 0)}</span></div>`).join('');
  const tw = 170; tip.style.left = (x + 12 + tw > br.width ? x - tw - 12 : x + 12) + 'px';
  box.classList.add('active');
}
const barRow = (label, v, max, c, right) => `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between;gap:8px;font-size:13px"><span class="ellipsis">${esc(label)}</span><span class="num muted">${right}</span></div><div class="bar" role="img" aria-label="${esc(label)}: ${esc(right)}"><i style="width:${max ? v / max * 100 : 0}%;background:${c}"></i></div></div>`;

// ---------- states ----------
const skelCard = (h = 120) => `<div class="card"><div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:32px;width:55%;margin:16px 0 10px"></div><div class="sk" style="height:${h - 70}px"></div></div>`;
function skeleton() {
  return `<div aria-busy="true" aria-label="Memuat data"><div class="sk" style="height:14px;width:160px"></div><div class="sk" style="height:38px;width:360px;max-width:100%;margin:12px 0 26px"></div>
    <div class="grid g4">${skelCard().repeat(4)}</div><div class="grid main-side mt">${skelCard(320)}${skelCard(320)}</div></div>`;
}
const emptyState = (ic, html) => `<div class="empty">${icon(ic)}${html}</div>`;
function setupPage(k) {
  const c = chMeta(k);
  return `<div class="eyebrow"><span class="tag a">Belum terhubung</span></div><h1>${esc(c.title)}</h1>
  <div class="card setup"><h2>Hubungkan channel ini</h2><p class="muted">Channel sudah ditambahkan, tapi dasbor belum boleh membaca datanya.</p>
  <p>Buka <a href="#account" data-page="account" style="color:var(--cyan)">Informasi akun</a> channel ini dan ikuti langkahnya: ${c.has_client ? 'klik <b>Login Google &amp; hubungkan API</b>, lalu <b>Izinkan</b> di jendela Chrome channel.' : 'Panduan Google Cloud membuka setiap halaman yang perlu, lalu klik <b>Login Google &amp; hubungkan API</b>.'}</p>
  <button class="btn primary" data-page="account">${icon('badge')}Buka Informasi akun</button></div>`;
}

// ---------- loading ----------
async function loadCore(fresh) {
  const f = fresh ? '&fresh=1' : '';
  setSync('busy');
  await Promise.all(S.meta.channels.filter(c => c.connected).map(async ({ key }) => {
    const d = S.data[key] = S.data[key] || {};
    delete S.errors[key];
    try {
      // channel + videos are required; analytics is optional (API may be disabled or still processing)
      const opt = k => api(`${k}?ch=${key}${f}`).catch(e => { d.analyticsError = e.message; return null; });
      delete d.analyticsError;
      const [channel, videos, analytics, daily] = await Promise.all([api(`channel?ch=${key}${f}`), api(`videos?ch=${key}${f}`), opt('analytics'), opt('daily')]);
      Object.assign(d, { channel, videos, analytics, daily });
      if (fresh) { delete d.sources; delete d.comments; }
    } catch (e) { S.errors[key] = e.message; }
  }));
  [S.projects, S.quota] = await Promise.all([api('projects'), api('quota')]);
  S.synced = new Date(); S.loading = false;
  setSync(Object.keys(S.errors).length ? 'partial' : 'ok');
}
function setSync(state) {
  const dot = { busy: 'warn', ok: 'ok', partial: 'err' }[state];
  $('#liveDot').className = $('#syncDot').className = 'dot ' + dot;
  $('#syncIcon').classList.toggle('spin', state === 'busy');
  $('#syncText').textContent = state === 'busy' ? 'Sinkronisasi…' : (state === 'partial' ? 'Sebagian gagal · ' : 'Tersinkron · ') + wibTime(S.synced) + ' WIB';
}
async function loadExtra(kind) {
  await Promise.all(chans().map(async ch => {
    const d = S.data[ch]; if (!d || d[kind] || S.errors[ch]) return;
    try { d[kind] = await api(`${kind}?ch=${ch}`); } catch (e) { d[kind] = { error: e.message }; }
  }));
}

// ---------- pages ----------
function metricCard(label, ic, val, extra, sub, sparkVals, c, hero) {
  return `<div class="card metric${hero ? ' hero' : ''}"><div class="lbl">${esc(label)}${icon(ic, `style="color:${c || '#A1A1AA'}"`)}</div>
    <div class="val">${val}${extra}</div><div class="sub">${sub}</div>${sparkVals ? spark(sparkVals, c) : ''}</div>`;
}
const thumb = v => `<div class="thumb">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : ''}<span class="dur">${mmss(v.sec)}</span></div>`;

function overview() {
  const cs = chans().filter(c => S.data[c]?.channel);
  if (!S.meta.channels.length) return welcome();
  if (!cs.length) return emptyState('link_off', 'Belum ada channel yang terhubung.<br>Klik nama channel di sidebar lalu <b>Informasi akun</b> untuk menyelesaikan koneksi, atau baca <a href="#help" data-page="help" style="color:var(--cyan)">Panduan</a>.');
  const subs = cs.reduce((a, c) => a + n(S.data[c].channel.stats.subscriberCount), 0);
  const totalViews = cs.reduce((a, c) => a + n(S.data[c].channel.stats.viewCount), 0);
  const days = cs.map(c => S.data[c].daily?.days || []);
  const len = Math.max(0, ...days.map(d => d.length));
  const sum = (k, from = 0, to = 99) => days.reduce((a, d) => a + d.slice(Math.max(0, from), to).reduce((b, r) => b + n(r[k]), 0), 0);
  const views = sum('views'), last14 = sum('views', len - 14, len), prev14 = sum('views', len - 28, len - 14);
  const delta = prev14 ? (last14 - prev14) / prev14 * 100 : null;
  const netSubs = sum('subscribersGained') - sum('subscribersLost');
  const hours = sum('estimatedMinutesWatched') / 60;
  const vids = allVideos();
  const queue = vids.filter(v => v.st.k === 'scheduled').sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
  const pad = d => Array(len - d.length).fill(0);
  const daySeries = k => { const out = Array(len).fill(0); days.forEach(d => d.forEach((r, i) => out[i + len - d.length] += n(r[k]))); return out; };
  const labels = (days.find(d => d.length === len) || []).map(r => wib(r.day + 'T12:00:00Z', { day: 'numeric', month: 'short' }));
  const mlabel = { views: 'Views', estimatedMinutesWatched: 'Menit ditonton', subscribersGained: 'Subscriber baru' }[S.metric];
  const series = cs.map((c, i) => ({ name: chTitle(c), color: color(c), dash: i % 2 === 1, vals: pad(S.data[c].daily?.days || []).concat((S.data[c].daily?.days || []).map(r => n(r[S.metric]))) }));
  const top = vids.filter(v => v.st.k === 'public').sort((a, b) => n(b.stats.viewCount) - n(a.stats.viewCount)).slice(0, 5);
  const ins = insights();
  const summary = `${mlabel} per hari, 28 hari terakhir: ` + series.map(s => `${s.name} total ${fmt(s.vals.reduce((a, b) => a + b, 0))}`).join(', ');

  return `
  <div class="eyebrow"><span class="tag">Network Hub</span>${cs.length} channel tersambung</div>
  <h1>Ringkasan Portofolio</h1>
  <p class="lead">Metrik gabungan ${cs.map(c => `<b>${esc(chTitle(c))}</b>`).join(', ')}. Subscriber dan total views real-time; angka 28 hari dari YouTube Analytics (tertunda ±2 hari).</p>
  <div class="grid g4">
    ${metricCard('Total views', 'visibility', fmt(totalViews), delta == null ? '' : `<small class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</small>`, `Real-time · analytics 28 hari: <b class="num">${fmt(views)}</b>`, daySeries('views'), '#06B6D4', true)}
    ${metricCard('Total subscriber', 'group', fmt(subs), netSubs ? `<small class="${netSubs > 0 ? 'up' : 'down'}">${netSubs > 0 ? '+' : ''}${netSubs}</small>` : '', `Bersih 28 hari: ${netSubs >= 0 ? '+' : ''}${netSubs}`, daySeries('subscribersGained'), '#10B981')}
    ${metricCard('Jam tonton 28 hari', 'schedule', fmt(hours, 1), '', 'Total menit ditonton ÷ 60', daySeries('estimatedMinutesWatched'), '#3B82F6')}
    ${metricCard('Antrean tayang', 'event_upcoming', queue.length, '', queue[0] ? `Berikutnya: ${wib(queue[0].st.t, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} WIB` : 'Tidak ada video terjadwal', null)}
  </div>
  <div class="grid main-side mt">
    <div class="card">
      <div class="card-head"><div><h2>Volume Penayangan Harian</h2><p>${esc(mlabel)} per hari, per channel</p></div>
        <div class="seg" role="group" aria-label="Pilih metrik grafik">${[['views', 'Views'], ['estimatedMinutesWatched', 'Menit'], ['subscribersGained', 'Subs']].map(([k, l]) => `<button data-metric="${k}" aria-pressed="${S.metric === k}">${l}</button>`).join('')}</div></div>
      <div class="legend">${series.map(s => `<span><span class="swl${s.dash ? ' dash' : ''}" style="border-color:${s.color}"></span>${esc(s.name)}</span>`).join('')}</div>
      ${len ? chart('daily', series, { labels, summary, empty: `${icon('hourglass_top', 'style="display:block;margin:0 auto 6px;color:#F59E0B"')}<b>Data analytics belum masuk.</b><br>YouTube Analytics butuh ±2 hari setelah video tayang. Sementara ini total views real-time: <b>${fmt(totalViews)}</b>.` })
        : emptyState('hourglass_top', 'Belum ada data harian.')}
    </div>
    <div class="card"><div class="card-head"><h2>Creator Intelligence</h2><span class="tag">${ins.length} catatan</span></div>
      <div class="list">${ins.map(i => `<div class="insight ${i.lvl}"><div class="h">${icon(i.icon)}${esc(i.title)}</div><p>${i.html}</p>${i.act ? `<button class="btn secondary" style="margin-top:8px" data-page="${i.act[0]}">${esc(i.act[1])}${icon('arrow_forward')}</button>` : ''}</div>`).join('')}</div></div>
  </div>
  <div class="grid main-side mt">
    <div><div class="card-head"><div><h2>Daftar Channel</h2><p>Metrik individual dan aksi cepat</p></div></div>
      <div class="list">${cs.map(channelRow).join('')}${S.meta.channels.filter(c => !c.connected).map(c => `<div class="chrow">${avatar(c.key, 'lg')}<div style="min-width:0"><h3>${esc(c.title)}</h3><span class="tag a">Belum terhubung</span></div><span class="hide-sm"></span><span class="hide-sm"></span><span class="hide-sm"></span><button class="btn secondary" data-sel="${c.key}">Atur${icon('arrow_forward')}</button></div>`).join('')}</div></div>
    <div class="card"><div class="card-head"><div><h2>Video Teratas</h2><p>Views publik sepanjang masa</p></div></div>
      <div class="list">${top.map(v => `<div class="vid" ${clickable(`data-vid="${v.id}"`, 'Detail video ' + v.title)}>${thumb(v)}<div style="min-width:0"><div class="tt">${esc(v.title)}</div><div class="chb">${chBadge(v.ch)} · <span class="up num">${fmt(v.stats.viewCount)} views</span></div></div></div>`).join('') || emptyState('smart_display', 'Belum ada video publik.')}</div></div>
  </div>`;
}
function channelRow(c) {
  const d = S.data[c], st = d.channel.stats, dd = d.daily?.days || [];
  const v28 = dd.reduce((a, r) => a + n(r.views), 0);
  const an = d.analytics?.videos || [], av = an.reduce((a, r) => a + n(r.views), 0);
  const avgPct = av ? an.reduce((a, r) => a + n(r.averageViewPercentage) * n(r.views), 0) / av : null;
  const states = d.videos.map(vstate);
  const last = states.filter(s => s.k === 'public').sort((a, b) => new Date(b.t) - new Date(a.t))[0];
  const queued = states.some(s => s.k === 'scheduled');
  const status = !last ? (queued ? ['Tayang perdana segera', 'c'] : ['Belum ada video publik', 'n']) : (Date.now() - new Date(last.t)) / 864e5 > 3 && !queued ? ['Perlu upload', ''] : ['Aktif', 'g'];
  return `<div class="chrow">${avatar(c, 'lg')}
    <div style="min-width:0"><h3 class="ellipsis">${esc(d.channel.title)}</h3>
      <div class="muted" style="font-size:13px;margin:2px 0 4px">${esc(d.channel.handle || '')} · ${fmt(st.subscriberCount)} subscriber</div><span class="tag ${status[1]}">${status[0]}</span></div>
    <div class="hide-sm"><div class="k">Total views</div><div class="v">${fmt(st.viewCount)}</div><div class="dim" style="font-size:12px">28 hari: ${fmt(v28)}</div></div>
    <div class="hide-sm"><div class="k">Rata² ditonton</div><div class="v">${pct(avgPct)}</div></div>
    <div class="hide-sm"><div class="k">Upload terakhir</div><div style="font-size:13px">${last ? ago(last.t) : '–'}</div></div>
    <button class="btn secondary" data-yt="channel" data-ch="${c}" aria-label="Buka ${esc(d.channel.title)} di YouTube Studio (Chrome channel)">Studio${icon('arrow_outward')}</button></div>`;
}
function insights() {
  const out = [], vids = allVideos();
  for (const c of chans()) {
    if (S.errors[c]) { out.push({ lvl: 'bad', icon: 'error', title: chTitle(c) + ': gagal memuat', html: esc(S.errors[c]) }); continue; }
    const d = S.data[c]; if (!d?.videos) continue;
    if (d.analyticsError) out.push({ lvl: 'warn', icon: 'query_stats', title: `${chTitle(c)}: analytics tidak tersedia`, html: /has not been used|disabled/.test(d.analyticsError) ? 'YouTube Analytics API belum diaktifkan di project Google Cloud channel ini.' : esc(d.analyticsError.slice(0, 160)) });
    const next = vids.filter(v => v.ch === c && v.st.k === 'scheduled').sort((a, b) => new Date(a.st.t) - new Date(b.st.t))[0];
    if (!next) out.push({ lvl: 'warn', icon: 'event_busy', title: `${chTitle(c)}: antrean kosong`, html: `Belum ada video terjadwal. Slot tayang channel ini <b>${slotWib(chMeta(c).slot_utc_hour)}</b>.`, act: ['schedule', 'Lihat kalender'] });
    else if ((new Date(next.st.t) - Date.now()) / 36e5 < 48) out.push({ lvl: 'good', icon: 'rocket_launch', title: `${chTitle(c)}: tayang ${ago(next.st.t)}`, html: `<b>${esc(next.title)}</b>, ${wib(next.st.t, { weekday: 'long', hour: '2-digit', minute: '2-digit' })} WIB.` });
    const ready = S.projects.filter(p => p.channel === c && p.status === 'ready');
    if (ready.length) out.push({ lvl: 'info', icon: 'upload', title: `${chTitle(c)}: ${ready.length} siap upload`, html: ready.map(p => `<b>${esc(p.title || p.name)}</b>`).join(', ') + '. Minta agent jalankan dry-run publish.' });
    const an = (d.analytics?.videos || []).filter(r => n(r.views) >= 50).sort((a, b) => n(b.averageViewPercentage) - n(a.averageViewPercentage));
    if (an.length >= 2) {
      const t = d.videos.find(v => v.id === an[0].video);
      out.push({ lvl: 'good', icon: 'trending_up', title: `${chTitle(c)}: retensi terbaik`, html: `<b>${esc(t?.title || an[0].video)}</b> ditonton rata-rata <b>${pct(an[0].averageViewPercentage)}</b>. Pola hook-nya layak diulang.` });
    }
    const cm = d.comments;
    if (Array.isArray(cm)) { const open = cm.filter(x => !x.replies).length; if (open) out.push({ lvl: 'info', icon: 'forum', title: `${chTitle(c)}: ${open} komentar belum dibalas`, html: 'Balasan di jam pertama membantu interaksi.', act: ['comments', 'Buka komentar'] }); }
  }
  for (const c of S.meta.channels.filter(c => !c.connected)) out.push({ lvl: 'warn', icon: 'link_off', title: `${c.title}: belum terhubung`, html: 'Client OAuth sudah terdaftar, tinggal login sekali.' });
  const q = S.quota?.channels || {};
  for (const c of chans()) { const u = q[c]?.units || 0; if (u > 7000) out.push({ lvl: 'bad', icon: 'bolt', title: `Kuota ${chTitle(c)} menipis`, html: `${fmt(u)} / 10.000 unit terpakai hari ini.`, act: ['quota', 'Lihat kuota'] }); }
  return out.length ? out : [{ lvl: 'good', icon: 'check_circle', title: 'Semua aman', html: 'Tidak ada yang perlu ditindaklanjuti.' }];
}

function compare() {
  const cs = chans().filter(c => S.data[c]?.channel);
  if (!cs.length) return emptyState('link_off', 'Belum ada channel yang terhubung.');
  const an = c => S.data[c].analytics?.videos || [], vsum = c => an(c).reduce((s, r) => s + n(r.views), 0);
  const rows = [
    ['Subscriber', c => fmt(S.data[c].channel.stats.subscriberCount)],
    ['Total views', c => fmt(S.data[c].channel.stats.viewCount)],
    ['Video publik', c => n(S.data[c].channel.stats.videoCount)],
    ['Views 28 hari', c => fmt((S.data[c].daily?.days || []).reduce((a, r) => a + n(r.views), 0))],
    ['Jam tonton 28 hari', c => fmt((S.data[c].daily?.days || []).reduce((a, r) => a + n(r.estimatedMinutesWatched), 0) / 60)],
    ['Subscriber bersih 28 hari', c => (S.data[c].daily?.days || []).reduce((a, r) => a + n(r.subscribersGained) - n(r.subscribersLost), 0)],
    ['Rata² % ditonton', c => vsum(c) ? pct(an(c).reduce((s, r) => s + n(r.averageViewPercentage) * n(r.views), 0) / vsum(c)) : '–'],
    ['Rata² durasi tonton', c => vsum(c) ? mmss(an(c).reduce((s, r) => s + n(r.averageViewDuration) * n(r.views), 0) / vsum(c)) : '–'],
    ['Slot tayang', c => slotWib(chMeta(c).slot_utc_hour)],
  ];
  const src = { SHORTS: 'Feed Shorts', YT_SEARCH: 'Pencarian YouTube', RELATED_VIDEO: 'Video terkait', SUBSCRIBER: 'Feed subscriber', BROWSE: 'Beranda / jelajah',
    EXT_URL: 'Link eksternal', NO_LINK_OTHER: 'Langsung / lainnya', PLAYLIST: 'Playlist', NOTIFICATION: 'Notifikasi', YT_CHANNEL: 'Halaman channel',
    YT_OTHER_PAGE: 'Halaman YouTube lain', END_SCREEN: 'End screen', HASHTAGS: 'Hashtag', SOUND_PAGE: 'Halaman audio', ANNOTATION: 'Kartu' };
  const region = new Intl.DisplayNames(['id'], { type: 'region' });
  const reg = code => { try { return `${region.of(code)} (${code})`; } catch { return code; } };
  return `<div class="eyebrow"><span class="tag c">Komparasi</span>28 hari terakhir</div><h1>Komparasi Channel</h1>
  <p class="lead">Bandingkan performa, sumber trafik, dan negara penonton. Angka 28 hari dari YouTube Analytics (tertunda ±2 hari); subscriber dan total views real-time.</p>
  <div class="card"><div class="table-wrap"><table><caption class="sr-only">Perbandingan metrik antar channel</caption><thead><tr><th scope="col">Metrik</th>${cs.map(c => `<th scope="col" class="r">${chBadge(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([l, f]) => `<tr><th scope="row" class="muted" style="text-transform:none;font-size:14px;font-weight:400;letter-spacing:0;padding:12px">${l}</th>${cs.map(c => `<td class="r" style="font-weight:600">${f(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
  <div class="grid g2 mt">${cs.map(c => { const s = S.data[c].sources;
    if (!s) return skelCard(260);
    if (s.error) return `<div class="card"><div class="err">${esc(s.error)}</div></div>`;
    const tm = Math.max(1, ...s.traffic.map(r => n(r.views))), cm = Math.max(1, ...s.countries.map(r => n(r.views)));
    const none = emptyState('hourglass_top', 'Belum ada data. Analytics masuk ±2 hari setelah ada views.');
    return `<div class="card"><div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c)}${esc(chTitle(c))}</h2></div>
      <div class="sub-h">Sumber trafik</div>${s.traffic.map(r => barRow(src[r.insightTrafficSourceType] || r.insightTrafficSourceType, n(r.views), tm, color(c), fmt(r.views) + ' views')).join('') || none}
      <div class="sub-h" style="margin-top:18px">Negara teratas</div>${s.countries.slice(0, 8).map(r => barRow(reg(r.country), n(r.views), cm, '#3B82F6', fmt(r.views) + ' views')).join('') || none}</div>`; }).join('')}</div>`;
}

function content() {
  const F = S.filters; let vids = allVideos();
  if (F.q) { const q = F.q.toLowerCase(); vids = vids.filter(v => v.title.toLowerCase().includes(q) || v.id.toLowerCase().includes(q) || (v.tags || []).some(t => t.toLowerCase().includes(q))); }
  if (F.fmt !== 'all') vids = vids.filter(v => (v.sec <= 180) === (F.fmt === 'short'));
  if (F.status !== 'all') vids = vids.filter(v => v.st.k === F.status);
  const key = { release: v => new Date(v.st.t), views: v => n(v.stats.viewCount), likes: v => n(v.stats.likeCount), comments: v => n(v.stats.commentCount),
    pct: v => n(v.an?.averageViewPercentage), avd: v => n(v.an?.averageViewDuration), subs: v => n(v.an?.subscribersGained), title: v => v.title.toLowerCase() }[F.sort];
  vids.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * F.dir);
  const all = allVideos(), cnt = f => all.filter(f).length;
  const th = (k, l, r) => `<th class="${r ? 'r' : ''}" ${F.sort === k ? `aria-sort="${F.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button class="thb" data-sort="${k}" aria-label="Urutkan menurut ${l}">${l}${icon(F.sort === k ? (F.dir > 0 ? 'arrow_upward' : 'arrow_downward') : 'unfold_more')}</button></th>`;
  const dash = '<span class="dim" title="Analytics belum tersedia">–</span>';
  return `<div class="eyebrow"><span class="tag g">Konten</span>${all.length} video</div><h1>Performa Konten</h1>
  <p class="lead">Semua video di channel terpilih. Klik baris (atau Enter) untuk retensi dan detail. Kolom % ditonton, durasi, dan +Subs dari analytics 28 hari.</p>
  <div class="card"><div class="filters">
    <label class="sr-only" for="fq">Cari video</label><input class="search" id="fq" type="search" placeholder="Cari judul, tag, atau ID video…" value="${esc(F.q)}">
    <div class="seg" role="group" aria-label="Format video">${[['all', `Semua (${all.length})`], ['short', `Shorts (${cnt(v => v.sec <= 180)})`], ['long', `Video panjang (${cnt(v => v.sec > 180)})`]].map(([k, l]) => `<button data-fmt="${k}" aria-pressed="${F.fmt === k}">${l}</button>`).join('')}</div>
    <label class="sr-only" for="fstatus">Status</label><select id="fstatus">${[['all', 'Semua status'], ['public', 'Publik'], ['scheduled', 'Terjadwal'], ['unlisted', 'Unlisted'], ['private', 'Privat']].map(([k, l]) => `<option value="${k}" ${F.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="grow"></span><span class="muted" style="font-size:12px" role="status">Menampilkan ${vids.length} dari ${all.length}</span></div>
  <div class="table-wrap"><table><caption class="sr-only">Daftar video</caption><thead><tr>${th('title', 'Video')}${th('release', 'Status & rilis')}${th('views', 'Views', 1)}${th('likes', 'Likes', 1)}${th('comments', 'Komentar', 1)}${th('pct', '% ditonton', 1)}${th('avd', 'Rata² durasi', 1)}${th('subs', '+Subs', 1)}</tr></thead>
  <tbody>${vids.map(v => `<tr class="click" ${clickable(`data-vid="${v.id}"`, 'Detail video ' + v.title)}><td style="min-width:320px"><div class="vid">${thumb(v)}<div style="min-width:0"><div class="tt">${esc(v.title)}</div>${chBadge(v.ch)}</div></div></td>
    <td style="white-space:nowrap"><span class="tag ${v.st.cls}">${v.st.label}</span><div class="muted" style="font-size:12px;margin-top:4px">${wibDate(v.st.t)} ${wibTime(v.st.t)}</div></td>
    <td class="r" style="font-weight:600">${fmt(v.stats.viewCount)}</td><td class="r">${fmt(v.stats.likeCount)}</td><td class="r">${fmt(v.stats.commentCount)}</td>
    <td class="r">${v.an ? `${pct(v.an.averageViewPercentage)}<div class="bar" style="width:70px;margin-left:auto;margin-top:4px"><i style="width:${Math.min(100, n(v.an.averageViewPercentage))}%;background:${n(v.an.averageViewPercentage) >= 70 ? '#10B981' : '#06B6D4'}"></i></div>` : dash}</td>
    <td class="r">${v.an ? mmss(v.an.averageViewDuration) : dash}</td><td class="r">${v.an ? (n(v.an.subscribersGained) ? '<span class="up">+' + n(v.an.subscribersGained) + '</span>' : '0') : dash}</td></tr>`).join('')}</tbody></table>
  ${vids.length ? '' : emptyState('search_off', `Tidak ada video yang cocok. <button class="btn ghost" data-act="reset">Reset filter</button>`)}</div></div>`;
}

async function openVideo(id) {
  const v = allVideos().find(x => x.id === id); if (!v) return;
  lastFocus = document.activeElement;
  const dr = $('#drawer');
  dr.setAttribute('aria-label', 'Detail video ' + v.title);
  dr.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">${chBadge(v.ch)}<button class="icon-btn" id="drClose" aria-label="Tutup detail">${icon('close')}</button></div>
    ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="Thumbnail ${esc(v.title)}" style="width:100%;border-radius:8px;display:block">` : ''}
    <h2 style="margin-top:12px">${esc(v.title)}</h2>
    <div class="muted" style="font-size:13px;margin-top:4px"><span class="tag ${v.st.cls}">${v.st.label}</span> ${wib(v.st.t, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WIB · ${mmss(v.sec)}</div>
    <div class="kv"><div><div class="k">Views</div><div class="v">${fmt(v.stats.viewCount)}</div></div><div><div class="k">Likes</div><div class="v">${fmt(v.stats.likeCount)}</div></div><div><div class="k">Komentar</div><div class="v">${fmt(v.stats.commentCount)}</div></div>
      <div><div class="k">% ditonton</div><div class="v">${pct(v.an?.averageViewPercentage)}</div></div><div><div class="k">Rata² durasi</div><div class="v">${v.an ? mmss(v.an.averageViewDuration) : '–'}</div></div><div><div class="k">+Subs 28h</div><div class="v">${v.an ? n(v.an.subscribersGained) : '–'}</div></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-yt="watch" data-ch="${v.ch}" data-id="${esc(v.id)}">${icon('play_arrow')}Tonton</button>
      <button class="btn secondary" data-yt="edit" data-ch="${v.ch}" data-id="${esc(v.id)}">Edit di Studio</button>
      <button class="btn secondary" data-yt="analytics" data-ch="${v.ch}" data-id="${esc(v.id)}">Analytics</button></div>
    <h3 style="margin-top:20px">Retensi penonton</h3><div id="ret"><div class="sk" style="height:220px;margin-top:10px" aria-busy="true"></div></div>
    ${(v.tags || []).length ? `<h3 style="margin-top:16px">Tag</h3><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${v.tags.map(t => `<span class="tag n" style="text-transform:none">${esc(t)}</span>`).join('')}</div>` : ''}`;
  dr.classList.add('open'); $('#drawerBg').classList.add('open');
  $('#drClose').focus();
  try {
    const r = await api(`retention?ch=${v.ch}&id=${v.id}`);
    $('#ret').innerHTML = r.length ? `<div class="legend" style="margin-top:8px"><span><span class="swl" style="border-color:#FF0033"></span>Penonton tersisa</span><span><span class="swl dash" style="border-color:#8B8B94"></span>Awal (100%)</span></div>` +
      chart('ret', [{ name: 'Tersisa', color: '#FF0033', vals: r.map(x => n(x.audienceWatchRatio) * 100) }, { name: '', color: '#8B8B94', dash: 1, vals: r.map(() => 100) }],
        { labels: r.map(x => Math.round(n(x.elapsedVideoTimeRatio) * 100) + '%'), fmtY: y => Math.round(y) + '%', h: 220, area: false, summary: 'Kurva retensi penonton' })
      : emptyState('hourglass_top', 'Belum ada data retensi. Analytics butuh ±2 hari dan cukup views.');
  } catch (e) { $('#ret').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function closeDrawer() {
  if (!$('#drawer').classList.contains('open')) return;
  $('#drawer').classList.remove('open'); $('#drawerBg').classList.remove('open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function schedule() {
  const vids = allVideos().filter(v => v.st.k === 'public' || v.st.k === 'scheduled');
  const todayKey = wibKey(new Date()); const [ty, tm, td] = todayKey.split('-').map(Number);
  const base = new Date(Date.UTC(ty, tm - 1, td)); const dow = (base.getUTCDay() + 6) % 7;
  const monday = new Date(base - dow * 864e5 + S.weekOffset * 7 * 864e5);
  const days = [...Array(7)].map((_, i) => new Date(+monday + i * 864e5));
  const dkey = d => d.toISOString().slice(0, 10);
  const byDay = {}; vids.forEach(v => (byDay[wibKey(v.st.t)] = byDay[wibKey(v.st.t)] || []).push(v));
  const dfmt = o => new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', ...o });
  const range = `${dfmt({ day: 'numeric', month: 'short' }).format(days[0])} – ${dfmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(days[6])}`;
  const up = vids.filter(v => new Date(v.st.t) > Date.now() - 864e5).sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
  const clashes = []; for (let i = 1; i < up.length; i++) if (up[i].ch !== up[i - 1].ch && (new Date(up[i].st.t) - new Date(up[i - 1].st.t)) < 2 * 36e5) clashes.push([up[i - 1], up[i]]);
  const queue = vids.filter(v => v.st.k === 'scheduled').sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
  const projs = S.projects.filter(p => chans().includes(p.channel) && p.status !== 'uploaded');
  const pst = { ready: ['Siap upload', 'g'], animating: ['Animasi', 'c'], script: ['Naskah', 'a'], idea: ['Ide', 'n'] };
  return `<div class="eyebrow"><span class="tag a">Studio</span>Jadwal tayang & antrean produksi</div><h1>Kalender & Antrean</h1>
  <p class="lead">Rilis semua channel dalam satu minggu (WIB). ${chans().map(c => `<b>${esc(chTitle(c))}</b> slot ${slotWib(chMeta(c).slot_utc_hour)}`).join(' · ')}.</p>
  <div class="grid g4" style="margin-bottom:16px">
    ${metricCard('Antrean terjadwal', 'event_upcoming', queue.length, '', queue[0] ? 'Berikutnya ' + ago(queue[0].st.t) : 'Kosong', null)}
    ${metricCard('Siap upload', 'upload', projs.filter(p => p.status === 'ready').length, '', 'Proyek lokal lengkap, belum diupload', null)}
    ${metricCard('Dalam produksi', 'movie_edit', projs.filter(p => p.status !== 'ready').length, '', 'Naskah / animasi', null)}
    ${metricCard('Collision guard', 'shield', clashes.length ? clashes.length + ' bentrok' : 'Aman', '', clashes.length ? 'Rilis antar channel < 2 jam' : 'Jarak rilis antar channel ≥ 2 jam', null, clashes.length ? '#F59E0B' : '#10B981')}
  </div>
  <div class="grid main-side">
    <div class="card"><div class="card-head"><div class="wk-nav"><button class="icon-btn" data-week="-1" aria-label="Minggu sebelumnya">${icon('chevron_left')}</button><h2 aria-live="polite">${range}</h2><button class="icon-btn" data-week="1" aria-label="Minggu berikutnya">${icon('chevron_right')}</button>${S.weekOffset ? '<button class="btn ghost" data-week="0">Minggu ini</button>' : ''}</div>
      <div class="legend">${chans().map(c => `<span><span class="sw" style="background:${color(c)}"></span>${esc(chTitle(c))}</span>`).join('')}</div></div>
      <div class="week">${days.map(d => { const k = dkey(d), ev = (byDay[k] || []).sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
        return `<div class="day ${k === todayKey ? 'today' : ''}" role="group" aria-label="${dfmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(d)}"><div class="dh"><div class="dn">${dfmt({ weekday: 'short' }).format(d)}${k === todayKey ? ' · hari ini' : ''}</div><div class="dd">${d.getUTCDate()}</div></div>
        <div class="slots">${ev.map(v => `<div class="ev" style="--c:${color(v.ch)}" ${clickable(`data-vid="${v.id}"`, `${wibTime(v.st.t)} ${v.title}`)}><div class="tm">${wibTime(v.st.t)}</div><div class="tt">${esc(v.title)}</div><div class="st">${v.st.k === 'scheduled' ? 'Terjadwal' : fmt(v.stats.viewCount) + ' views'} · ${v.sec <= 180 ? 'Short' : 'Panjang'}</div></div>`).join('') || '<div class="dim" style="font-size:12px;text-align:center;padding:12px 0">Kosong</div>'}</div></div>`; }).join('')}</div>
      ${clashes.map(([a, b]) => `<div class="insight warn mt"><div class="h">${icon('warning')}Rilis berdekatan</div><p><b>${esc(a.title)}</b> (${esc(chTitle(a.ch))}, ${wibTime(a.st.t)}) dan <b>${esc(b.title)}</b> (${esc(chTitle(b.ch))}, ${wibTime(b.st.t)}).</p></div>`).join('')}
    </div>
    <div class="card"><div class="card-head"><h2>Antrean</h2><span class="tag n">${queue.length + projs.length}</span></div>
      <div class="sub-h">Terjadwal di YouTube</div>
      ${queue.map(v => `<div class="qitem vid" ${clickable(`data-vid="${v.id}"`, 'Detail video ' + v.title)}>${thumb(v)}<div style="min-width:0"><span class="tag a">${wib(v.st.t, { weekday: 'short', day: 'numeric', month: 'short' })} · ${wibTime(v.st.t)} WIB</span><div class="tt" style="margin-top:4px">${esc(v.title)}</div>${chBadge(v.ch)}</div></div>`).join('') || emptyState('event_busy', 'Tidak ada video terjadwal.')}
      <div class="sub-h">Proyek lokal</div>
      ${projs.map(p => `<div class="qitem">${icon(p.status === 'ready' ? 'task_alt' : 'movie_edit', `style="color:${color(p.channel)}"`)}<div style="min-width:0"><span class="tag ${pst[p.status][1]}">${pst[p.status][0]}</span>
        <div style="font-weight:600;font-size:13px;margin-top:4px">${esc(p.title || p.name)}</div><div class="muted" style="font-size:12px">${chBadge(p.channel)} · ${esc(p.name)}${p.video_mb ? ' · ' + p.video_mb + ' MB' : ''}</div></div></div>`).join('') || emptyState('inventory_2', 'Semua proyek sudah diupload.')}
    </div></div>`;
}

function comments() {
  const blocks = chans().map(c => ({ c, d: S.errors[c] ? { error: S.errors[c] } : S.data[c]?.comments }));
  if (blocks.some(b => !b.d)) return `<div class="eyebrow"><span class="tag">Komunitas</span></div><h1>Komentar</h1><div class="card" aria-busy="true">${'<div style="display:flex;gap:12px;padding:14px 0"><div class="sk" style="width:36px;height:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="height:12px;width:30%"></div><div class="sk" style="height:12px;width:80%;margin-top:10px"></div></div></div>'.repeat(4)}</div>`;
  let list = blocks.flatMap(({ c, d }) => Array.isArray(d) ? d.map(x => ({ ...x, ch: c })) : []);
  list.sort((a, b) => new Date(b.published) - new Date(a.published));
  const total = list.length, open = list.filter(x => !x.replies).length;
  if (S.onlyOpen) list = list.filter(x => !x.replies);
  return `<div class="eyebrow"><span class="tag">Komunitas</span>8 video publik terbaru per channel</div><h1>Komentar</h1>
  <p class="lead">Balasan langsung tampil publik atas nama channel, jadi setiap kirim diminta konfirmasi. <b>${open}</b> komentar belum dibalas.</p>
  ${blocks.filter(b => b.d.error).map(b => `<div class="err">${esc(chTitle(b.c))}: ${esc(b.d.error)}</div>`).join('')}
  <div class="card"><div class="filters"><div class="seg" role="group" aria-label="Saring komentar"><button data-open="0" aria-pressed="${!S.onlyOpen}">Semua (${total})</button><button data-open="1" aria-pressed="${S.onlyOpen}">Belum dibalas (${open})</button></div></div>
  ${list.map(x => `<div class="cmt"><div class="avc" aria-hidden="true">${initials(x.author)}</div><div style="min-width:0">
    <div class="meta"><b style="color:#fff">${esc(x.author)}</b><span>${ago(x.published)}</span>${chBadge(x.ch)}<a ${clickable(`data-vid="${x.video_id}"`)} style="color:var(--cyan)" class="ellipsis">${esc(x.video_title)}</a></div>
    <div class="txt">${esc(x.text)}</div>
    <div class="meta"><span>${icon('thumb_up', 'style="font-size:16px"')} ${n(x.likes)}</span><span>${n(x.replies)} balasan</span>
      <button class="btn ghost" data-reply="${esc(x.id)}" data-ch="${x.ch}" aria-expanded="false">${icon('reply', 'style="font-size:16px"')}Balas</button>
      <button class="btn ghost" data-yt="watch" data-ch="${x.ch}" data-id="${esc(x.video_id)}" data-lc="${esc(x.id)}">Lihat di YouTube</button></div>
    <div id="rb-${esc(x.id)}"></div></div></div>`).join('') || emptyState('forum', S.onlyOpen ? 'Semua komentar sudah dibalas.' : 'Belum ada komentar. Komentar dari video publik akan muncul di sini.')}</div>`;
}

function quota() {
  const q = S.quota; const now = new Date();
  const pt = new Date(now.getTime() - 8 * 36e5); const reset = new Date(Date.UTC(pt.getUTCFullYear(), pt.getUTCMonth(), pt.getUTCDate() + 1, 8));
  return `<div class="eyebrow"><span class="tag c">Developer</span>Hari kuota ${esc(q.day)} (Pacific)</div><h1>Kuota API</h1>
  <p class="lead">Estimasi dari semua panggilan lewat <b>yt.py</b> (dasbor + CLI). Tiap channel punya project Google Cloud sendiri, jadi kuotanya terpisah. Reset ${wib(reset, { weekday: 'long', hour: '2-digit', minute: '2-digit' })} WIB.</p>
  <div class="grid g2">${S.meta.channels.map(c => { const r = q.channels[c.key] || { units: 0, analytics: 0, calls: {} }; const left = q.limit - r.units;
    return `<div class="card"><div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c.key)}${esc(chTitle(c.key))}</h2>${c.connected ? `<span class="tag ${left < 3000 ? '' : 'g'}">${fmt(left)} sisa</span>` : '<span class="tag a">Belum terhubung</span>'}</div>
      <div class="metric"><div class="val">${fmt(r.units)}<small class="muted">/ ${fmt(q.limit)} unit</small></div></div>
      <div class="bar" style="height:10px" role="progressbar" aria-valuemin="0" aria-valuemax="${q.limit}" aria-valuenow="${r.units}" aria-label="Kuota terpakai ${esc(chTitle(c.key))}"><i style="width:${Math.min(100, r.units / q.limit * 100)}%;background:${r.units > 7000 ? '#FF0033' : color(c.key)}"></i></div>
      <p class="muted" style="font-size:13px">Cukup untuk ±${Math.max(0, Math.floor(left / 2150))} upload lagi hari ini (upload + subtitle + thumbnail + terjemahan ≈ 2.150 unit). Analytics API: ${r.analytics} request.</p>
      <table><thead><tr><th scope="col" style="padding:10px 12px">Panggilan</th><th scope="col" class="r" style="padding:10px 12px">Jumlah</th></tr></thead><tbody>${Object.entries(r.calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="r">${v}</td></tr>`).join('') || '<tr><td colspan="2" class="dim">Belum ada panggilan hari ini</td></tr>'}</tbody></table></div>`; }).join('')}</div>`;
}

// ---------- manager: login health + Studio launcher ----------
const HST = {
  ok: ['Login aktif', 'g', 'verified_user'], expiring: ['Segera kedaluwarsa', 'a', 'timer'],
  unknown_age: ['Umur login tak diketahui', 'a', 'help'], expired: ['Login kedaluwarsa', '', 'gpp_bad'],
  missing: ['Belum login', 'n', 'link_off'], offline: ['Tidak bisa dicek (offline)', 'n', 'wifi_off'], error: ['Error', '', 'error'],
};
async function loadManager(fresh) {
  const [h, p] = await Promise.all([api('health' + (fresh ? '?fresh=1' : '')), api('chrome-profiles')]);
  S.health = h; S.profiles = p.profiles; S.channelIds = p.channel_ids; S.sessions = p.sessions || {};
  S.auth = await api('auth-status').catch(() => ({}));
  if (Object.values(S.auth).some(j => j.state === 'running')) pollAuth();
}
let authTimer = null;
function pollAuth() {
  if (authTimer) return;
  authTimer = setInterval(async () => {
    const prev = S.auth || {};
    S.auth = await api('auth-status').catch(() => prev);
    const finished = Object.keys(S.auth).filter(k => prev[k]?.state === 'running' && S.auth[k].state !== 'running');
    if (!Object.values(S.auth).some(j => j.state === 'running')) { clearInterval(authTimer); authTimer = null; }
    if (finished.length) {
      await loadManager(true).catch(() => {});
      S.meta = await api('meta').catch(() => S.meta);
      finished.forEach(k => delete S.acc[k]);
      if (finished.some(k => S.auth[k].state === 'ok' && !S.data[k]?.channel)) loadCore(true).then(render).catch(() => {});
    }
    if (S.page === 'manager' || S.page === 'account') render(); else renderRail();
  }, 3000);
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': window.API_TOKEN }, body: JSON.stringify(body) });
const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`;
function managerCard(c) {
  const h = S.health[c.key] || { state: 'error', detail: 'tidak ada data' };
  const [label, cls, ic] = HST[h.state] || HST.error;
  const units = S.quota?.channels[c.key]?.units || 0;
  const prof = (S.profiles || []).find(p => p.dir === c.chrome_profile);
  const store = h.store === 'vault' ? `${icon('lock', 'style="font-size:16px;color:var(--green)"')} Vault terenkripsi (DPAPI)`
    : h.store === 'plain' ? `${icon('lock_open', 'style="font-size:16px;color:var(--amber)"')} File polos di Secrets` : '–';
  const age = h.days_left != null ? `${h.days_left <= 0 ? 'sudah lewat' : 'sisa ' + h.days_left.toFixed(1) + ' hari'} (mati ${wibDate(h.expires_at)})`
    : h.oauth_mode === 'production' ? 'tidak kedaluwarsa (production)' : (h.login_at ? '–' : 'belum tercatat');
  const needLogin = ['expired', 'missing', 'expiring', 'unknown_age'].includes(h.state);
  return `<div class="card mgr" style="border-top:3px solid ${color(c.key)}">
    <div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c.key)}${esc(chTitle(c.key))}</h2><span class="tag ${cls}">${icon(ic, 'style="font-size:14px;vertical-align:-3px"')} ${esc(label)}</span></div>
    ${h.detail ? `<p class="muted" style="font-size:13px;margin:-6px 0 10px">${esc(h.detail)}</p>` : ''}
    ${kv('Token', store)}
    ${kv('Mode OAuth', h.oauth_mode === 'production' ? 'Production' : 'Testing (refresh token 7 hari)')}
    ${kv('Login terakhir', h.login_at ? `${wibDate(h.login_at)} · ${ago(h.login_at)}` : 'belum tercatat')}
    ${kv('Masa berlaku', age)}
    ${kv('Kuota hari ini', `<span class="num">${fmt(units)}</span> / ${fmt(S.quota?.limit || 10000)} unit`)}
    <div class="sub-h">YouTube Studio</div>
    <div class="mgr-row">
      <label class="sr-only" for="cp-${c.key}">Profil Chrome ${esc(c.title)}</label>
      <select id="cp-${c.key}" data-profile-ch="${c.key}">
        <option value="">Sesi khusus channel (disarankan)</option>
        ${(S.profiles || []).map(p => `<option value="${esc(p.dir)}" ${p.dir === c.chrome_profile ? 'selected' : ''}>Profil Chrome biasa: ${esc(p.name)}${p.email ? ' · ' + esc(p.email) : ''}</option>`).join('')}
      </select>
      <button class="btn primary" data-launch="${c.key}" ${c.chrome_profile && !prof ? 'aria-disabled="true"' : ''}>${icon('open_in_new')}Buka Studio</button>
    </div>
    ${c.chrome_profile && !prof ? `<p class="muted" style="font-size:12px">Profil <b>${esc(c.chrome_profile)}</b> tidak ditemukan lagi; pilih ulang.</p>` : ''}
    ${!c.chrome_profile ? (() => { const s = S.sessions?.[c.key] || {};
      if (!s.exists) return `<p class="muted" style="font-size:12px;margin:8px 0 0">${icon('login', 'style="font-size:14px;vertical-align:-2px"')} Belum ada login tersimpan. Klik <b>Buka Studio</b>: jendela Chrome khusus channel ini terbuka di halaman login Google. Login dengan akun pemilik <b>${esc(chTitle(c.key))}</b> sekali saja; berikutnya Studio langsung terbuka tanpa login.</p>`;
      return `<div class="mgr-row" style="margin-top:8px;font-size:12px"><span class="muted" style="flex:1;min-width:0">${icon('verified_user', 'style="font-size:14px;vertical-align:-2px;color:var(--green)"')} Login tersimpan${s.emails?.length ? ': <b style="color:#fff">' + s.emails.map(esc).join(', ') + '</b>' : ' (email terlihat setelah Chrome diminta "login ke Chrome")'}${s.last_opened ? ' · dibuka ' + ago(s.last_opened) : ''}</span>
        <button class="btn ghost" data-forget="${c.key}">${icon('logout', 'style="font-size:16px"')}Lupakan login</button></div>`; })() : ''}
    ${(() => { const shared = prof ? S.meta.channels.filter(o => o.key !== c.key && o.chrome_profile === c.chrome_profile) : [];
      return shared.length ? `<p style="font-size:12px;color:var(--amber);margin:8px 0 0">${icon('warning', 'style="font-size:14px;vertical-align:-2px"')} Profil ini juga dipakai ${shared.map(o => esc(chTitle(o.key))).join(', ')}. Satu profil Chrome hanya login ke akun Google <b>${esc(prof.email || prof.name)}</b>; kalau channel ini milik akun lain, Studio akan menolak ("Anda tidak diizinkan melihat halaman ini"). Buat profil terpisah untuk akun Google channel ini.</p>` : ''; })()}
    ${(() => { const j = S.auth?.[c.key] || { state: 'idle' }, run = j.state === 'running';
      const sess = !c.chrome_profile && S.sessions?.[c.key]?.exists;
      const msg = run ? `<p style="font-size:12px;color:var(--cyan);margin:8px 0 0">${icon('progress_activity', 'class="ms spin" style="font-size:14px;vertical-align:-2px"')} ${esc(j.message)}<button class="btn ghost" data-auth-cancel="${c.key}" style="margin-left:6px;padding:2px 8px;min-height:0">${icon('close', 'style="font-size:14px"')}Batalkan</button></p>`
        : j.state === 'ok' ? `<p style="font-size:12px;color:var(--green);margin:8px 0 0">${icon('task_alt', 'style="font-size:14px;vertical-align:-2px"')} ${esc(j.message)}</p>`
        : j.state === 'failed' ? `<p style="font-size:12px;color:var(--soft-red);margin:8px 0 0">${icon('error', 'style="font-size:14px;vertical-align:-2px"')} Gagal: ${esc(j.message)}</p>` : '';
      return `<div class="sub-h">Login API (upload, statistik, komentar)</div>
        <div class="mgr-row"><span class="muted" style="flex:1 1 200px;font-size:12px">${sess
          ? 'Halaman izin Google terbuka di jendela Chrome channel ini yang sudah login. Cukup klik <b>Lanjutkan/Izinkan</b>.'
          : 'Login di <b>Buka Studio</b> dulu, supaya perpanjangan berikutnya cukup satu klik Izinkan.'}</span>
        <button class="btn ${needLogin ? 'primary' : 'secondary'}" data-auth="${c.key}" ${run ? 'aria-disabled="true"' : ''}>${icon('key')}Perpanjang login API</button></div>${msg}`; })()}
  </div>`;
}
function manager() {
  if (!S.health) return `<div class="eyebrow"><span class="tag c">Manager</span></div><h1>Channel &amp; Login</h1><div class="grid g2">${skelCard(260).repeat(2)}</div>`;
  const cs = S.sel === 'all' ? S.meta.channels : S.meta.channels.filter(c => c.key === S.sel);
  const hs = cs.map(c => S.health[c.key] || {});
  const plain = cs.filter(c => S.health[c.key]?.store === 'plain' || S.health[c.key]?.plain_file);
  const testing = hs.filter(h => h.oauth_mode !== 'production').length;
  const bad = hs.filter(h => ['expired', 'missing', 'error'].includes(h.state)).length;
  const noProf = cs.filter(c => !c.chrome_profile).length;
  const ins = [];
  if (bad) ins.push(['bad', 'gpp_bad', `${bad} channel perlu login ulang`, 'Upload dan statistik channel itu tidak jalan sampai login diperbarui.']);
  const unmigrated = plain.filter(c => S.health[c.key]?.store === 'plain');
  if (plain.length) ins.push(['warn', 'lock_open', `${plain.length} file token polos masih ada`, unmigrated.length
    ? `Belum dienkripsi: ${unmigrated.map(c => esc(chTitle(c.key))).join(', ')}. Jalankan <code>yt.cmd --ch &lt;channel&gt; vault-migrate</code>.`
    : `Semua token sudah dipakai dari vault terenkripsi, tapi salinan JSON polos lamanya masih ada di <code>Secrets</code> (${plain.map(c => esc(chTitle(c.key))).join(', ')}). Hapus dengan <code>yt.cmd --ch &lt;channel&gt; vault-remove-plain</code> (ke Recycle Bin) setelah disetujui.`]);
  if (testing) ins.push(['info', 'science', `${testing} app OAuth masih mode Testing`, 'Refresh token mati 7 hari setelah login. Ubah app ke <b>In production</b> di Google Cloud Console agar tidak perlu login ulang tiap minggu, lalu set <code>"oauth_mode": "production"</code> di channels.json.']);
  if (noProf) ins.push(['info', 'account_circle', `${noProf} channel belum punya profil Chrome`, 'Buat satu profil Chrome per akun Google channel, login sekali secara manual, lalu pilih profilnya di kartu channel.']);
  if (!ins.length) ins.push(['good', 'task_alt', 'Semua channel sehat', 'Token tersimpan di vault, login aktif, dan profil Chrome sudah diatur.']);
  const checked = hs.map(h => h.checked_at).filter(Boolean).sort()[0];
  return `<div class="eyebrow"><span class="tag c">Manager</span>${cs.length} channel${checked ? ' · dicek ' + ago(checked) : ''}</div>
  <h1>Channel &amp; Login</h1>
  <p class="lead">Status login OAuth tiap channel (dicek lewat refresh token, tanpa memakai kuota) dan pintasan YouTube Studio di profil Chrome masing-masing. Isi token tidak pernah dikirim ke halaman ini.</p>
  <div style="display:flex;gap:8px;margin-bottom:16px"><button class="btn secondary" data-health="1">${icon('refresh')}Cek ulang login</button></div>
  <div class="grid g2" style="margin-bottom:16px">${ins.map(([lvl, ic, t, p]) => `<div class="insight ${lvl}"><div class="h">${icon(ic)}${esc(t)}</div><p>${p}</p></div>`).join('')}</div>
  <div class="grid g2">${cs.map(managerCard).join('')}</div>`;
}

// ---------- accounts: add channel, account info (credentials masked), API key, revoke, remove ----------
S.acc = {}; S.reveal = {}; S.clientFiles = null;
const accKey = () => { const ks = S.meta.channels.map(c => c.key); return ks.includes(S.sel) ? S.sel : ks.includes(S.accSel) ? S.accSel : ks[0]; };
async function loadAccount(k) { S.acc[k] = await api('account?ch=' + encodeURIComponent(k)); }
const scopeName = s => s.replace('https://www.googleapis.com/auth/', '').replace(/^youtube\.?/, 'youtube.').replace(/\.$/, '');
function secretRow(k, label, field, masked, extra = '') {
  const shown = S.reveal[k + ':' + field];
  return `<div class="cred"><div class="cred-l">${esc(label)}</div><div class="cred-v"><code class="${shown ? 'shown' : ''}">${esc(shown ?? masked ?? '–')}</code>
    ${masked ? `<button class="icon-btn" data-acc="reveal" data-field="${field}" aria-label="${shown ? 'Sembunyikan' : 'Tampilkan'} ${esc(label)}" title="${shown ? 'Sembunyikan' : 'Tampilkan'}">${icon(shown ? 'visibility_off' : 'visibility')}</button>
    <button class="icon-btn" data-acc="copy" data-field="${field}" aria-label="Salin ${esc(label)}" title="Salin">${icon('content_copy')}</button>` : ''}${extra}</div></div>`;
}
// ---------- Google Cloud setup guide (any user: opens each Console page in the channel's own Chrome) ----------
S.gcpProj = {}; S.downloads = null; S.apiCheck = {}; S.wizOpen = {};
const PROJ_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
function gsteps(email, title) {
  return [
    ['gcp_project', 'add_box', 'Buat project Google Cloud', `Login dengan akun Google pemilik <b>${title}</b> bila diminta. Beri nama project (misalnya nama channel), lalu klik <b>Create</b>. Pertama kali memakai Google Cloud? Setujui dulu Terms of Service-nya. Gratis, tidak perlu kartu kredit.`],
    ['gcp_enable', 'toggle_on', 'Aktifkan YouTube Data API v3 dan YouTube Analytics API', 'Pastikan project yang baru dibuat terpilih di bagian atas halaman, lalu klik <b>Next</b> dan <b>Enable</b>. Kedua API diaktifkan sekaligus.'],
    ['gcp_branding', 'badge', 'Atur layar izin OAuth', 'Klik <b>Get started</b>. Isi nama app (bebas, misalnya StudioPulse) dan email Anda, pilih <b>External</b>, centang persetujuan, lalu <b>Create</b>.'],
    ['gcp_audience', 'group_add', 'Tambahkan email channel sebagai Test user', `Di bagian <b>Test users</b> klik <b>Add users</b>, masukkan ${email ? `<code>${esc(email)}</code><button class="icon-btn" data-acc="copytext" data-text="${esc(email)}" aria-label="Salin email" title="Salin">${icon('content_copy')}</button>` : 'email Google pemilik channel'}, lalu <b>Save</b>. Tanpa ini Google menolak login ("Access blocked").`],
    ['gcp_client', 'key', 'Buat OAuth client "Desktop app", lalu download JSON', 'Application type: <b>Desktop app</b>, nama bebas, klik <b>Create</b>, lalu <b>Download JSON</b>. Kalau Chrome menanyakan lokasi, simpan di folder Downloads.'],
  ];
}
function wizard(k, a) {
  const proj = S.gcpProj[k] ?? (a.client?.project_id || '');
  const email = a.session?.emails?.[0];
  return `<div class="wiz"><p class="muted" style="margin:0 0 12px;font-size:13px">Setiap tombol <b>Buka</b> membuka halaman Google Cloud Console yang tepat di jendela Chrome khusus channel ini. Kerjakan berurutan, sekitar 5 menit.</p>
    <ol class="wsteps">${gsteps(email, esc(a.title)).map(([kind, ic, t, d], i) => `<li><span class="wn" aria-hidden="true">${i + 1}</span><div class="wbody"><b>${t}</b><p>${d}</p>${i === 0 ? `<label for="gcpProj">Project ID (opsional; terlihat di Google Cloud, membuat tombol berikutnya langsung ke project yang benar)</label><input id="gcpProj" data-proj-ch="${k}" value="${esc(proj)}" placeholder="mis. dapur-santai-123456" autocomplete="off" spellcheck="false">` : ''}</div>
      <button class="btn secondary" data-yt="${kind}" data-ch="${k}" data-id="${PROJ_RE.test(proj) ? esc(proj) : ''}" data-gcp="1">${icon(ic)}Buka</button></li>`).join('')}
      <li><span class="wn" aria-hidden="true">6</span><div class="wbody"><b>File .json diambil otomatis</b><p>Dasbor memantau folder Downloads. Klik <b>Pakai file ini</b> pada file yang muncul: file dipindah ke folder Secrets dan dihapus dari Downloads.</p><div id="dlList" aria-live="polite">${dlList()}</div></div></li></ol></div>`;
}
function dlList() {
  const wait = t => `<p class="note c">${icon('progress_activity', 'class="ms spin"')} ${t}</p>`;
  if (!S.downloads) return wait('Mencari file di Downloads…');
  const fs = S.downloads.files.filter(f => f.valid);
  if (!fs.length) return wait(`Menunggu file <code>client_secret_….json</code> di <code>${esc(S.downloads.dir)}</code>…`);
  return fs.slice(0, 4).map(f => `<div class="dl"><span class="dl-i">${icon('description')}<span><b>${esc(f.project_id || f.name)}</b><br><span class="muted">${esc(f.client_id)} · ${ago(f.modified)}${f.used_by?.length ? ' · sudah dipakai ' + f.used_by.map(esc).join(', ') : ''}</span></span></span>
    <button class="btn primary" data-acc="import" data-name="${esc(f.name)}">${icon('check')}Pakai file ini</button></div>`).join('');
}
let dlTimer = null;
function pollDownloads() {
  if (dlTimer) return;
  const tick = async () => {
    if (!document.querySelector('#dlList')) { clearInterval(dlTimer); dlTimer = null; return; }
    try { S.downloads = await api('account/downloads'); } catch { return; }
    const el = document.querySelector('#dlList'); if (el) el.innerHTML = dlList();
  };
  tick(); dlTimer = setInterval(tick, 3000);
}
document.addEventListener('input', e => {
  const k = e.target.dataset?.projCh; if (!k) return;
  const v = e.target.value.trim().toLowerCase(); S.gcpProj[k] = v;
  document.querySelectorAll('[data-gcp]').forEach(b => { b.dataset.id = PROJ_RE.test(v) ? v : ''; });
});

// ---------- help page and first-run welcome (written for anyone who receives the app) ----------
const FEATURES = [
  ['space_dashboard', 'overview', 'Ringkasan', 'Subscriber, views, jam tonton, dan tren 28 hari semua channel; video terbaru dan komentar yang belum dibalas.'],
  ['compare_arrows', 'compare', 'Komparasi Channel', 'Bandingkan channel berdampingan: pertumbuhan, retensi, dan sumber trafik.'],
  ['video_library', 'content', 'Performa Konten', 'Tabel semua video dengan filter dan urutan; klik video untuk detail, retensi, dan tombol Edit di Studio.'],
  ['calendar_month', 'schedule', 'Kalender & Antrean', 'Jadwal tayang per minggu, slot upload tiap channel, peringatan jadwal yang bertabrakan, dan status proyek lokal.'],
  ['forum', 'comments', 'Komentar', 'Komentar terbaru semua channel. Balas langsung dari dasbor (selalu ada konfirmasi sebelum terkirim).'],
  ['bolt', 'quota', 'Kuota API', 'Pemakaian kuota YouTube Data API hari ini per channel (10.000 unit/hari per project Google Cloud).'],
  ['manage_accounts', 'manager', 'Channel & Login', 'Kesehatan login semua channel, sisa masa login, sesi Chrome tiap channel, dan tombol Perpanjang login.'],
];
function startSteps() {
  return `<ol class="wsteps">
    <li><span class="wn" aria-hidden="true">1</span><div class="wbody"><b>Tambah channel</b><p>Klik <b>Tambah Channel</b> di sidebar kiri. Isi nama channel, bahasa, dan jam upload.</p></div><button class="btn primary" data-acc="add">${icon('add')}Tambah Channel</button></li>
    <li><span class="wn" aria-hidden="true">2</span><div class="wbody"><b>Ikuti Panduan Google Cloud</b><p>Dasbor membuka setiap halaman Google Cloud yang perlu di jendela Chrome khusus channel: buat project, aktifkan YouTube Data API dan Analytics API, tambah Test user, buat client "Desktop app". File <code>.json</code> diambil otomatis dari Downloads.</p></div></li>
    <li><span class="wn" aria-hidden="true">3</span><div class="wbody"><b>Login Google &amp; hubungkan API</b><p>Login dengan akun pemilik channel di jendela Chrome itu, lalu klik <b>Izinkan</b>. Login ini juga dipakai untuk membuka YouTube Studio, jadi cukup sekali.</p></div></li>
    <li><span class="wn" aria-hidden="true">4</span><div class="wbody"><b>Selesai</b><p>Data channel muncul di semua halaman. Klik nama channel di sidebar untuk menu cepat: Informasi akun, Buka Studio, Lihat di YouTube, Folder proyek, Perpanjang login.</p></div></li></ol>`;
}
function welcome() {
  return `<img class="wlogo" src="logo.svg" alt="" aria-hidden="true"><div class="eyebrow"><span class="tag c">Mulai</span>Belum ada channel</div><h1>Selamat datang di StudioPulse</h1>
  <p class="lead">Dasbor lokal untuk mengelola beberapa channel YouTube sekaligus: statistik, konten, jadwal, komentar, kuota API, dan login, semuanya di satu tempat. Berjalan di komputer Anda sendiri.</p>
  <div class="card"><h2>Mulai dalam 4 langkah</h2>${startSteps()}</div>
  <p class="muted mt">Butuh penjelasan fitur atau ada masalah? Buka <a href="#help" data-page="help" style="color:var(--cyan)">Panduan</a>.</p>`;
}
function help() {
  const faq = [
    ['Muncul "Access blocked" atau "akses ditolak" saat login', 'Email Google channel belum terdaftar sebagai <b>Test user</b>. Buka Informasi akun → Panduan Google Cloud → langkah 4.'],
    ['Muncul "Google hasn\'t verified this app"', 'Normal untuk app milik Anda sendiri yang masih mode Testing. Klik <b>Continue</b>.'],
    ['Kenapa harus login ulang tiap 7 hari?', 'Google menghapus izin app yang masih mode <b>Testing</b> setelah 7 hari. Ubah app ke <b>In production</b> di Google Cloud (Audience → Publish app) supaya login bertahan, lalu set <code>"oauth_mode": "production"</code> untuk channel itu di <code>channels.json</code>.'],
    ['Login tertahan "Menunggu Izinkan"', 'Tab Google tertutup sebelum Anda klik Izinkan. Klik <b>Batalkan login</b> di menu channel, lalu coba lagi.'],
    ['YouTube Studio menolak ("tidak diizinkan melihat halaman ini")', 'Chrome channel itu login ke akun Google lain. Di Channel &amp; Login klik <b>Lupakan login</b>, lalu Buka Studio dan login dengan akun pemilik channel.'],
    ['Kuota API habis', 'Setiap project Google Cloud punya 10.000 unit/hari, reset tengah malam waktu Pasifik (14.00/15.00 WIB). Satu project per channel supaya kuota tidak berbagi.'],
    ['Statistik retensi atau trafik masih kosong', 'YouTube Analytics butuh 2–3 hari sebelum data muncul.'],
  ];
  return `<div class="eyebrow"><span class="tag c">Bantuan</span>Panduan</div><h1>Panduan StudioPulse</h1>
  <p class="lead">Semua yang perlu diketahui untuk mulai memakai dasbor ini, tanpa pengaturan manual di luar dasbor.</p>
  <div class="card"><h2>Mulai</h2>${startSteps()}</div>
  <h2 class="mt" style="margin-top:28px">Fitur</h2>
  <div class="grid g2 mt">${FEATURES.map(([ic, p, t, d]) => `<a class="card feat" href="#${p}" data-page="${p}"><div class="h">${icon(ic)}<b>${t}</b></div><p class="muted">${d}</p></a>`).join('')}
    <div class="card feat"><div class="h">${icon('menu_open')}<b>Menu channel di sidebar</b></div><p class="muted">Klik nama channel: status login, kuota hari ini, <b>Informasi akun</b> (Channel ID, file .json, API key, cek API, log audit, cabut akses, hapus dari dasbor), Buka Studio, Lihat di YouTube, Folder proyek, Perpanjang login.</p></div></div>
  <div class="grid g2 mt">
    <div class="card"><h2>Privasi &amp; keamanan</h2><ul class="plain">
      <li>${icon('computer')} Berjalan hanya di komputer ini (<code>127.0.0.1</code>); tidak ada server luar selain Google.</li>
      <li>${icon('lock')} Token login dan API key disimpan terenkripsi Windows (DPAPI) untuk akun Windows ini.</li>
      <li>${icon('password')} Dasbor tidak pernah menyimpan atau mengetik password Google; sesi login disimpan oleh Chrome.</li>
      <li>${icon('visibility_off')} Kredensial disamarkan dan baru tampil saat diklik; setiap tampil, salin, dan unduh tercatat.</li>
      <li>${icon('verified')} Tindakan publik (membalas komentar) selalu minta konfirmasi.</li></ul></div>
    <div class="card"><h2>Masalah umum</h2>${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p class="muted">${a}</p></details>`).join('')}</div>
  </div>`;
}

function account() {
  const chips = S.meta.channels.map(c => `<button class="chipbtn" data-acc="pick" data-ch="${c.key}" aria-pressed="${c.key === accKey()}">${avatar(c.key)}${esc(chTitle(c.key))}${c.pending ? ' <span class="tag a">baru</span>' : ''}</button>`).join('');
  const head = `<div class="eyebrow"><span class="tag c">Manager</span>Akun &amp; kredensial</div>
  <div class="acc-top"><div><h1>Informasi Akun</h1><p class="lead">Akun Google, file OAuth client (.json) dan API key tiap channel. Semua kredensial tersimpan di PC ini; di halaman ini disamarkan dan baru tampil saat Anda klik ikon mata. Setiap tampil, salin, unduh, dan ganti tercatat di log audit.</p></div></div>
  ${S.sel === 'all' ? `<div class="chips" role="group" aria-label="Pilih channel">${chips}</div>` : ''}`;
  const k = accKey();
  if (!k) return head + emptyState('person_add', '<b>Belum ada channel.</b><br>Klik <b>Tambah Channel</b> di sidebar untuk menghubungkan akun YouTube pertama.');
  const a = S.acc[k];
  if (!a) return head + `<div class="grid main-side mt">${skelCard(300)}${skelCard(300)}</div>`;
  const h = S.health?.[k] || a.health || {}, [hl, hc, hi] = a.pending ? ['Menunggu login', 'a', 'hourglass_top'] : (HST[h.state] || ['Belum dicek', 'n', 'help']);
  const job = S.auth?.[k] || { state: 'idle' }, run = job.state === 'running';
  const emails = a.session?.emails || [];
  const t = a.token || {}, cl = a.client || {};
  const jobMsg = run ? `<p class="note c">${icon('progress_activity', 'class="ms spin"')} ${esc(job.message)}<button class="btn ghost" data-auth-cancel="${k}" style="margin-left:6px;padding:2px 8px;min-height:0">${icon('close', 'style="font-size:14px"')}Batalkan</button></p>`
    : job.state === 'ok' ? `<p class="note g">${icon('task_alt')} ${esc(job.message)}</p>`
    : job.state === 'failed' ? `<p class="note r">${icon('error')} Gagal: ${esc(job.message)}</p>` : '';
  const pending = a.pending ? `<div class="card steps mt" style="border-color:rgba(245,158,11,.4)"><h2>${icon('pending_actions')} Selesaikan koneksi ${esc(a.title)}</h2>
    ${!cl.exists ? `<p class="muted" style="margin:8px 0 14px">Langkah 1 dari 2: siapkan project Google Cloud gratis supaya dasbor boleh membaca data channel ini.</p>${wizard(k, a)}<p class="muted" style="font-size:12px;margin:12px 0 0">Sudah punya file .json? Upload lewat kartu <b>File OAuth client</b> di bawah.</p></div>` : `
    <p class="muted" style="margin:8px 0 10px">Langkah 2 dari 2. File OAuth client siap (project <code>${esc(cl.project_id || '?')}</code>).</p>
    <ol><li>Pastikan email Google pemilik channel sudah jadi <b>Test user</b> di project itu (langkah 4 <button class="linkbtn" data-acc="wizard">Panduan Google Cloud</button>). Tanpa itu Google menolak dengan "Access blocked".</li>
    <li>Klik <b>Login Google &amp; hubungkan API</b>. Jendela Chrome khusus channel ini terbuka: login dengan akun pemilik channel (sekali saja), pilih channel-nya, lalu klik <b>Izinkan</b>. Muncul "Google hasn't verified this app"? Klik <b>Continue</b>, app ini milik Anda sendiri.</li>
    <li>Login yang sama tersimpan untuk <b>Buka Studio</b>, jadi Anda tidak perlu login lagi.</li></ol>
    <button class="btn primary" data-auth="${k}" ${run ? 'aria-disabled="true"' : ''}>${icon('login')}Login Google &amp; hubungkan API</button>${jobMsg}</div>`}` : '';
  const ids = `<div class="card mt acc-head" style="border-top:3px solid ${color(k)}">
    <div class="card-head"><h2 style="display:flex;gap:12px;align-items:center">${avatar(k, 'lg')}<span>${esc(chTitle(k))}<br><span class="muted" style="font-size:13px;font-weight:400">kunci <code>${esc(k)}</code> · ${a.language === 'id' ? 'Bahasa Indonesia' : 'English'} · slot ${slotWib(a.slot_utc_hour)}</span></span></h2>
    <span class="tag ${hc}">${icon(hi, 'style="font-size:14px;vertical-align:-3px"')} ${esc(hl)}</span></div>
    <div class="grid g4 facts">
      <div><div class="k">Channel ID</div><div class="v">${a.channel_id ? `<code>${esc(a.channel_id)}</code><button class="icon-btn" data-acc="copytext" data-text="${esc(a.channel_id)}" aria-label="Salin Channel ID">${icon('content_copy')}</button>` : '<span class="muted">setelah login</span>'}</div></div>
      <div><div class="k">Akun Google (Chrome)</div><div class="v">${emails.length ? emails.map(esc).join('<br>') : `<span class="muted">${a.session?.exists ? 'login tersimpan' : 'belum login'}</span>`}</div></div>
      <div><div class="k">Login API terakhir</div><div class="v">${t.login_at ? `${wibDate(t.login_at)} <span class="muted">· ${ago(t.login_at)}</span>` : '<span class="muted">belum tercatat</span>'}</div></div>
      <div><div class="k">Token</div><div class="v">${t.stored ? `${icon('lock', 'style="font-size:16px;color:var(--green)"')} Vault DPAPI` : t.error ? `<span class="down">${esc(t.error)}</span>` : '<span class="muted">belum ada</span>'}</div></div>
    </div>
    ${t.scopes?.length ? `<div class="sub-h">Izin OAuth (scope)</div><div class="scopes">${t.scopes.map(s => `<span class="tag n">${esc(scopeName(s))}</span>`).join('')}</div>` : ''}
    ${!a.pending ? `<div class="mgr-row mt"><button class="btn secondary" data-auth="${k}" ${run ? 'aria-disabled="true"' : ''}>${icon('key')}Perpanjang login API</button><button class="btn secondary" data-launch="${k}">${icon('open_in_new')}Buka Studio</button></div>${jobMsg}` : ''}
  </div>`;
  const shared = a.client_shared_with?.length ? `<p class="note a">${icon('share')} File client ini juga dipakai ${a.client_shared_with.map(esc).join(', ')}. Kuota 10.000 unit/hari project <code>${esc(cl.project_id)}</code> dibagi bersama.</p>` : '';
  const chk = S.apiCheck[k];
  const apiBox = a.channel_id && !a.pending && t.stored ? `<div class="sub-h" style="margin-top:18px">API di project ini</div>
    ${chk ? [['data', 'YouTube Data API v3', 'gcp_data'], ['analytics', 'YouTube Analytics API', 'gcp_analytics']].map(([n_, nm, kind]) => { const r = chk[n_] || {};
      return `<div class="cred"><div class="cred-l">${nm}</div><div class="cred-v">${r.ok ? `<span class="up">${icon('check_circle', 'style="font-size:16px"')} Aktif</span>`
        : `<span class="down">${esc(r.message || 'gagal')}</span>${r.disabled ? `<button class="btn secondary" data-yt="${kind}" data-ch="${k}" data-id="${esc(cl.project_id || '')}" style="margin-left:auto">${icon('toggle_on')}Aktifkan</button>` : ''}`}</div></div>`; }).join('') : ''}
    <div class="mgr-row" style="margin-top:8px"><button class="btn secondary" data-acc="checkapi">${icon('fact_check')}Cek API</button><span class="muted" style="font-size:12px">${chk ? 'dicek ' + ago(chk.checked_at) + ' · ' : ''}memakai 1 unit kuota</span></div>` : '';
  const creds = `<div class="card"><div class="card-head"><div><h2>API Keys &amp; Client Secrets</h2><p>OAuth client dari Google Cloud Console, dipakai untuk login API channel ini.</p></div></div>
    ${!cl.exists ? `<p class="note r">${icon('error')} File client <code>${esc(cl.file || '–')}</code> tidak ditemukan di Secrets. Upload ulang lewat kartu JSON.</p>` : cl.error ? `<p class="note r">${icon('error')} ${esc(cl.error)}</p>` : `
    ${secretRow(k, 'OAuth Client ID', 'client_id', cl.client_id)}
    ${secretRow(k, 'Client Secret', 'client_secret', cl.client_secret)}
    <div class="cred"><div class="cred-l">Project Google Cloud</div><div class="cred-v"><code>${esc(cl.project_id || '–')}</code></div></div>
    <div class="cred"><div class="cred-l">Jenis client</div><div class="cred-v">${cl.kind === 'installed' ? 'Desktop app (installed)' : esc(cl.kind)}</div></div>`}
    ${shared}${apiBox}
    <div class="sub-h" style="margin-top:18px">YouTube Data API key (opsional)</div>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Untuk panggilan publik tanpa login (cek channel, statistik publik). Disimpan terenkripsi DPAPI di <code>Secrets\\vault</code>. Dasbor tetap memakai login OAuth untuk data channel.</p>
    ${a.api_key ? secretRow(k, 'API key', 'api_key', a.api_key) + `<div class="mgr-row" style="margin-top:8px"><button class="btn secondary" data-acc="testkey">${icon('network_check')}Tes API key</button><button class="btn ghost" data-acc="delkey">${icon('delete')}Hapus API key</button></div>` : ''}
    <div class="mgr-row" style="margin-top:8px"><label class="sr-only" for="akey">API key baru</label><input id="akey" type="password" autocomplete="off" spellcheck="false" placeholder="${a.api_key ? 'Ganti dengan API key baru (AIza…)' : 'Tempel API key (AIza…)'}" style="flex:1 1 220px;min-width:0"><button class="btn primary" data-acc="setkey">${icon('save')}Simpan</button></div>
    <p class="note" id="keyMsg" role="status"></p>
  </div>`;
  const json = `<div class="card"><div class="card-head"><div><h2>File OAuth client (.json)</h2><p><code>${esc(cl.file || '–')}</code>${cl.bytes ? ` · ${fmt(cl.bytes)} byte · diubah ${wibDate(cl.modified)}` : ''}</p></div></div>
    ${cl.json_masked ? `<pre class="json" aria-label="Isi JSON (disamarkan)">${esc(cl.json_masked)}</pre>` : '<p class="muted">Belum ada file.</p>'}
    <div class="mgr-row mt">${cl.exists ? `<button class="btn secondary" data-acc="copyjson">${icon('content_copy')}Salin JSON</button><button class="btn secondary" data-acc="download">${icon('download')}Download .json</button>` : ''}
    <label class="btn secondary" for="cjFile" tabindex="0" role="button">${icon('upload_file')}Upload / ganti file .json</label><input id="cjFile" type="file" accept=".json,application/json" class="sr-only" data-acc-file="replace">
    <button class="btn secondary" data-acc="wizard" aria-expanded="${!!S.wizOpen[k]}">${icon('assistant_navigation')}Panduan ambil .json &amp; aktifkan API</button></div>
    ${S.wizOpen[k] && cl.exists ? `<div class="mt">${wizard(k, a)}</div>` : ''}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Mengganti file client membuat token lama tidak berlaku; setelah ganti, klik <b>Perpanjang login API</b>.</p>
  </div>`;
  const used = a.units_today || 0;
  const quota = `<div class="card"><h2>Kuota hari ini</h2><div class="metric"><div class="val">${fmt(used)}<small class="muted">/ ${fmt(10000)} unit</small></div></div><div class="bar"><i style="width:${Math.min(100, used / 100)}%;background:${used > 8000 ? 'var(--red)' : 'var(--green)'}"></i></div>
    <p class="muted" style="font-size:12px">Mode OAuth: ${a.oauth_mode === 'production' ? 'Production' : 'Testing (refresh token mati 7 hari setelah login)'}</p></div>`;
  const LBL = { reveal_client_id: 'Client ID ditampilkan', reveal_client_secret: 'Client secret ditampilkan', reveal_api_key: 'API key ditampilkan', copy_json: 'JSON disalin', download_json: 'JSON diunduh', oauth_cancelled: 'Login dibatalkan',
    apikey_set: 'API key disimpan', apikey_removed: 'API key dihapus', apikey_test: 'API key dites', client_json_replaced: 'File client diganti', channel_added: 'Channel ditambahkan',
    oauth_connected: 'Channel terhubung', oauth_login: 'Login API', oauth_revoked: 'Akses OAuth dicabut', channel_removed: 'Channel dihapus' };
  const audit = `<div class="card"><h2>Log audit kredensial</h2>${a.audit?.length ? `<ul class="audit">${a.audit.map(r => `<li><span>${esc(LBL[r.action] || r.action)}${r.detail && !r.action.startsWith('reveal') ? `<br><span class="muted">${esc(r.detail)}</span>` : ''}</span><time class="muted">${wibDate(r.t)} ${wibTime(r.t)}</time></li>`).join('')}</ul>` : '<p class="muted">Belum ada aktivitas.</p>'}</div>`;
  const danger = `<div class="card danger mt"><h2>${icon('warning')} Danger zone</h2>
    <div class="dz"><div><h3>Cabut akses OAuth</h3><p class="muted">Memberi tahu Google untuk membatalkan izin dasbor ini, lalu menyimpan token ke arsip. Channel tetap ada di dasbor; untuk memakainya lagi klik Perpanjang login API.</p></div>
      <button class="btn secondary" data-acc="revoke" ${!t.stored ? 'aria-disabled="true"' : ''}>${icon('link_off')}Cabut akses</button></div>
    <div class="dz"><div><h3>Hapus akun dari dasbor</h3><p class="muted">Channel hilang dari StudioPulse dan <code>channels.json</code>. Token, API key, dan file client (kalau tidak dipakai channel lain) dipindah ke <code>Secrets\\_removed</code>, jadi masih bisa dipulihkan. Folder video di <code>Channels\\</code> tidak disentuh. Channel YouTube-nya sendiri tidak dihapus.</p>
      <label for="rmName" style="font-size:12px">Ketik <b>${esc(a.title)}</b> untuk konfirmasi</label>
      <div class="mgr-row" style="margin-top:6px"><input id="rmName" autocomplete="off" spellcheck="false" style="flex:1 1 200px;min-width:0"><button class="btn primary danger-btn" data-acc="remove">${icon('delete_forever')}Hapus dari dasbor</button></div>
      <label class="check"><input type="checkbox" id="rmChrome"> Hapus juga login Google yang tersimpan di Chrome channel ini (tutup dulu jendelanya)</label></div></div>
  </div>`;
  return head + pending + ids + `<div class="grid main-side mt"><div class="grid">${creds}${json}</div><div class="grid" style="align-content:start">${quota}${audit}</div></div>` + danger;
}

// modal: add a channel
async function openAdd() {
  const dlg = $('#addDlg');
  try { S.clientFiles = await api('client-files'); } catch (e) { S.clientFiles = []; }
  const opts = S.clientFiles.map(f => `<option value="${esc(f.file)}">${esc(f.project_id || f.file)}${f.used_by.length ? ' · dipakai ' + f.used_by.map(chTitle).map(esc).join(', ') : ' · belum dipakai'}</option>`).join('');
  dlg.innerHTML = `<form method="dialog" id="addForm" novalidate>
    <div class="dlg-head"><h2 id="addDlgTitle">Tambah Channel YouTube</h2><button type="button" class="icon-btn" data-acc="close" aria-label="Tutup">${icon('close')}</button></div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">Dasbor menyimpan konfigurasi channel, lalu membuka Chrome khusus channel ini untuk login Google. Password tidak pernah disimpan dasbor; Chrome yang menyimpan sesi login.</p>
    <label for="nTitle">Nama channel</label><input id="nTitle" required maxlength="60" placeholder="mis. Dapur Santai" autocomplete="off">
    <div class="grid g2" style="gap:10px;margin-top:10px">
      <div><label for="nLang">Bahasa konten</label><select id="nLang"><option value="id">Bahasa Indonesia</option><option value="en">English</option></select></div>
      <div><label for="nSlot">Jam upload</label><select id="nSlot">${Array.from({ length: 24 }, (_, w) => `<option value="${(w + 17) % 24}" ${w === 19 ? 'selected' : ''}>${String(w).padStart(2, '0')}:00 WIB</option>`).join('')}</select></div>
    </div>
    <fieldset><legend>File OAuth client (.json)</legend>
      <label class="check"><input type="radio" name="src" value="guide" checked> <span><b>Belum punya file .json:</b> pandu saya membuatnya di Google Cloud (gratis, sekitar 5 menit, file diambil otomatis)</span></label>
      <label class="check"><input type="radio" name="src" value="upload"> Upload file .json yang sudah ada (satu project Google Cloud per channel supaya kuota tidak berbagi)</label>
      <input id="nFile" type="file" accept=".json,application/json" aria-label="File OAuth client JSON">
      ${opts ? `<label class="check"><input type="radio" name="src" value="existing"> Pakai file yang sudah ada</label><select id="nExisting" aria-label="File client yang sudah ada">${opts}</select>` : ''}
    </fieldset>
    <div class="insight info" style="margin-top:12px"><div class="h">${icon('info')}Apa yang terjadi berikutnya</div><p>Dasbor membuka jendela Chrome khusus channel ini. Anda login dengan akun Google pemilik channel, membuat project Google Cloud lewat panduan, lalu klik <b>Izinkan</b>. Login itu tersimpan di Chrome, jadi YouTube Studio juga langsung terbuka tanpa login lagi.</p></div>
    <p class="note r" id="addErr" role="alert"></p>
    <div class="dlg-foot"><button type="button" class="btn ghost" data-acc="close">Batal</button><button type="submit" class="btn primary" id="addGo">${icon('login')}Tambahkan channel</button></div>
  </form>`;
  lastFocus = document.activeElement;
  dlg.showModal(); $('#nTitle').focus();
  $('#addForm').onsubmit = submitAdd;
}
const readFile = f => new Promise((ok, no) => { if (f.size > 64 * 1024) return no(new Error('file terlalu besar untuk OAuth client JSON')); const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsText(f); });
async function submitAdd(e) {
  e.preventDefault();
  const err = $('#addErr'), go = $('#addGo'); err.textContent = '';
  const body = { title: $('#nTitle').value.trim(), language: $('#nLang').value, slot_utc_hour: Number($('#nSlot').value) };
  if (body.title.length < 2) { err.textContent = 'Isi nama channel.'; return $('#nTitle').focus(); }
  const src = document.querySelector('input[name=src]:checked').value;
  try {
    if (src === 'upload') { const f = $('#nFile').files[0]; if (!f) { err.textContent = 'Pilih file OAuth client .json.'; return; } body.client_json = await readFile(f); }
    else if (src === 'existing') body.client_file = $('#nExisting').value;
    go.setAttribute('aria-disabled', 'true'); go.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Menyimpan…`;
    const r = await postJson('account/add', body);
    S.meta = await api('meta'); S.accSel = r.key; S.sel = r.key; S.health = null;
    $('#addDlg').close();
    if (body.client_json || body.client_file) { const st = await postJson('auth', { ch: r.key }); S.auth = { ...(S.auth || {}), [r.key]: st }; pollAuth(); }
    if (S.page !== 'account') go_('account'); else render();
  } catch (ex) { err.textContent = ex.message; go.removeAttribute('aria-disabled'); go.innerHTML = `${icon('login')}Tambahkan channel`; }
}
const go_ = p => go(p);
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { return alert('Clipboard tidak bisa diakses browser ini.'); }
  if (btn) { const o = btn.innerHTML; btn.innerHTML = icon('check'); setTimeout(() => { btn.innerHTML = o; }, 1200); }
}
async function accAction(t) {
  const ds = t.dataset, k = ds.ch && ds.acc === 'pick' ? ds.ch : accKey(), a = S.acc[k];
  if (t.getAttribute('aria-disabled') === 'true') return;
  if (ds.acc === 'pick') { S.sel = ds.ch; S.reveal = {}; return render(); }
  if (ds.acc === 'folder') { try { await postJson('open-folder', { ch: ds.ch }); } catch (ex) { alert('Gagal membuka folder: ' + ex.message); } return; }
  if (ds.acc === 'add') return openAdd();
  if (ds.acc === 'close') { $('#addDlg').close(); return; }
  if (ds.acc === 'copytext') return copyText(ds.text, t);
  if (ds.acc === 'reveal' || ds.acc === 'copy') {
    const id = k + ':' + ds.field;
    if (ds.acc === 'reveal' && S.reveal[id]) { delete S.reveal[id]; return render(); }
    try {
      const v = S.reveal[id] ?? (await postJson('account/reveal', { ch: k, field: ds.field })).value;
      if (ds.acc === 'copy') { await copyText(v, t); await loadAccount(k); if (!S.reveal[id]) return render(); return; }
      S.reveal[id] = v; setTimeout(() => { if (S.reveal[id]) { delete S.reveal[id]; if (S.page === 'account') render(); } }, 30000);
      await loadAccount(k); render();
    } catch (ex) { alert('Gagal: ' + ex.message); }
    return;
  }
  if (ds.acc === 'copyjson' || ds.acc === 'download') {
    try {
      const r = await postJson('account/download', { ch: k, mode: ds.acc === 'copyjson' ? 'copy' : 'download' });
      if (ds.acc === 'copyjson') await copyText(r.json, t);
      else { const u = URL.createObjectURL(new Blob([r.json], { type: 'application/json' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
      await loadAccount(k); render();
    } catch (ex) { alert('Gagal: ' + ex.message); }
    return;
  }
  if (ds.acc === 'wizard') { S.wizOpen[k] = !S.wizOpen[k]; await render(); document.querySelector('.wiz')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
  if (ds.acc === 'import') {
    if (!confirm(`Pakai ${ds.name} untuk ${a.title}?\n\nFile disalin ke folder Secrets lalu dihapus dari Downloads.`)) return;
    try {
      const r = await postJson('account/import-json', { ch: k, name: ds.name });
      S.downloads = null; S.wizOpen[k] = false; S.meta = await api('meta'); await loadAccount(k); render();
      if (!a.pending && r.changed) alert('File client diganti. Klik "Perpanjang login" supaya login memakai client baru.');
    } catch (ex) { alert('Gagal: ' + ex.message); }
    return;
  }
  if (ds.acc === 'checkapi') {
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Mengecek…`;
    try { S.apiCheck[k] = await postJson('account/check-apis', { ch: k }); } catch (ex) { alert('Gagal cek API: ' + ex.message); }
    return render();
  }
  const msg = $('#keyMsg');
  if (ds.acc === 'setkey') {
    const v = $('#akey').value.trim(); if (!v) return $('#akey').focus();
    try { await postJson('account/apikey', { ch: k, key: v }); delete S.reveal[k + ':api_key']; await loadAccount(k); render(); }
    catch (ex) { msg.className = 'note r'; msg.textContent = ex.message; }
    return;
  }
  if (ds.acc === 'testkey') {
    t.setAttribute('aria-disabled', 'true');
    try { const r = await postJson('account/apikey-test', { ch: k }); await loadAccount(k); render(); const m = $('#keyMsg'); m.className = 'note ' + (r.ok ? 'g' : 'r'); m.textContent = r.message; }
    catch (ex) { msg.className = 'note r'; msg.textContent = ex.message; t.removeAttribute('aria-disabled'); }
    return;
  }
  if (ds.acc === 'delkey') {
    if (!confirm(`Hapus API key ${a.title}?`)) return;
    try { await postJson('account/apikey-remove', { ch: k }); delete S.reveal[k + ':api_key']; await loadAccount(k); render(); } catch (ex) { alert('Gagal: ' + ex.message); }
    return;
  }
  if (ds.acc === 'revoke') {
    if (!confirm(`Cabut akses OAuth ${a.title}?\n\nGoogle akan membatalkan izin dasbor ini. Upload, statistik, dan komentar channel ini berhenti sampai Anda login API lagi.`)) return;
    try { const r = await postJson('account/revoke', { ch: k }); delete S.data[k]; S.health = null; S.meta = await api('meta'); await loadAccount(k); render(); alert('Selesai: ' + r.detail); }
    catch (ex) { alert('Gagal: ' + ex.message); }
    return;
  }
  if (ds.acc === 'remove') {
    const name = $('#rmName').value.trim();
    if (name !== a.title) { alert(`Ketik "${a.title}" persis untuk konfirmasi.`); return $('#rmName').focus(); }
    if (!confirm(`Hapus ${a.title} dari dasbor?\n\nFile kredensialnya dipindah ke Secrets\\_removed (bisa dipulihkan). Channel YouTube-nya tidak dihapus.`)) return;
    try {
      const r = await postJson('account/remove', { ch: k, confirm: name, forget_chrome: $('#rmChrome').checked });
      delete S.acc[k]; delete S.data[k]; delete S.errors[k]; S.health = null; S.accSel = null; if (S.sel === k) S.sel = 'all';
      S.meta = await api('meta'); render();
      alert(`${a.title} dihapus dari dasbor. Arsip: ${r.archive}` + (r.chrome && !r.chrome.forgotten && r.chrome.reason ? `\n\nLogin Chrome tidak dihapus: ${r.chrome.reason}` : ''));
    } catch (ex) { alert('Gagal: ' + ex.message); }
  }
}
document.addEventListener('change', async e => {
  if (e.target.dataset?.accFile !== 'replace') return;
  const f = e.target.files[0]; if (!f) return;
  const k = accKey();
  if (!confirm(`Ganti file OAuth client ${chTitle(k)} dengan ${f.name}?\n\nSetelah diganti, login API perlu diperbarui.`)) { e.target.value = ''; return; }
  try { const r = await postJson('account/client-json', { ch: k, json: await readFile(f) }); await loadAccount(k); render(); if (r.changed) alert('File client diganti. Klik "Perpanjang login API" supaya token baru dibuat dengan client ini.'); }
  catch (ex) { alert('Gagal: ' + ex.message); e.target.value = ''; }
});

// ---------- shell ----------
function chMenu(c) {
  const k = c.key, h = S.health?.[k], j = S.auth?.[k] || {}, run = j.state === 'running';
  const [lbl, cls] = c.pending ? ['Menunggu login', 'a'] : h ? (HST[h.state] || HST.error) : ['Mengecek login…', 'n'];
  const dot = { g: 'ok', a: 'warn', '': 'err' }[cls] || '';
  const left = h?.days_left != null ? ` · sisa ${Math.max(0, h.days_left).toFixed(1).replace('.', ',')} hari` : '';
  const units = S.quota?.channels[k]?.units;
  const it = (attrs, ic, text, extra = '') => `<button class="sub-it" ${attrs}>${icon(ic, extra)}<span>${text}</span></button>`;
  return `<div class="ch-menu${railSel !== S.sel ? ' menu-enter' : ''}" role="group" aria-label="Menu ${esc(chTitle(k))}" style="--c:${color(k)}">
    <div class="ch-stat"><span class="dot ${dot}"></span><span>${esc(lbl)}${left}${units != null ? ` · ${fmt(units)} unit` : ''}</span></div>
    ${it(`data-page="account"${S.page === 'account' ? ' aria-current="page"' : ''}`, 'badge', 'Informasi akun')}
    ${run ? `<div class="ch-stat" style="color:var(--cyan)">${icon('progress_activity', 'class="ms spin" style="font-size:14px"')}<span>Menunggu Izinkan di Chrome…</span></div>` + it(`data-auth-cancel="${k}"`, 'close', 'Batalkan login')
      : c.pending ? (c.has_client ? it(`data-auth="${k}"`, 'login', 'Login Google') : it('data-page="account"', 'assistant_navigation', 'Siapkan Google Cloud')) : ''}
    ${it(`data-launch="${k}"`, 'open_in_new', 'Buka Studio')}
    ${c.connected ? it(`data-yt="public" data-ch="${k}"`, 'smart_display', 'Lihat di YouTube') : ''}
    ${it(`data-acc="folder" data-ch="${k}"`, 'folder_open', 'Folder proyek')}
    ${!c.pending && !run ? it(`data-auth="${k}"`, 'key', 'Perpanjang login') : ''}
  </div>`;
}
let railSel = null;  // channel whose sidebar menu was drawn last: its menu animates in only when this changes
function renderRail() {
  const tot = connected().reduce((a, k) => a + n(S.data[k]?.channel?.stats.subscriberCount), 0);
  const opt = (k, title, sub, av, off) => `<button data-sel="${k}" aria-pressed="${S.sel === k}">${av}<span style="min-width:0"><div class="t ellipsis">${esc(title)}</div><div class="s${off ? ' off' : ''}">${sub}</div></span></button>`;
  const subLine = k => S.loading ? 'Memuat…' : S.errors[k] ? 'Gagal memuat' : fmt(S.data[k]?.channel?.stats.subscriberCount) + ' subscriber';
  $('#switcher').innerHTML = opt('all', `Semua Channel (${connected().length})`, S.loading ? 'Memuat…' : fmt(tot) + ' subscriber', `<span class="av" style="background:#3F3F46" aria-hidden="true">${icon('hub', 'style="color:#4cd7f6;font-size:18px"')}</span>`) +
    S.meta.channels.map(c => opt(c.key, chTitle(c.key), c.connected ? subLine(c.key) : 'Belum terhubung', avatar(c.key), !c.connected || S.errors[c.key]) + (S.sel === c.key ? chMenu(c) : '')).join('') +
    `<button class="add-ch" data-acc="add">${icon('add_circle')}<span>Tambah Channel</span></button>`;
  railSel = S.sel;
  document.querySelectorAll('nav a').forEach(a => a.dataset.page === S.page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  const used = S.quota ? Math.max(0, ...connected().map(k => S.quota.channels[k]?.units || 0)) : 0;
  $('#quotaMini').innerHTML = `<div style="display:flex;gap:8px;align-items:center">${icon('bolt', 'style="color:#10B981"')}<b>Kuota API</b><span class="grow"></span><span class="muted">${Math.round(100 - used / 100)}% sisa</span></div><div class="bar"><i style="width:${100 - used / 100}%;background:#10B981"></i></div>`;
}
const PAGES = { overview, compare, content, schedule, comments, quota, manager, account, help };
let healthJob = null;
function ensureHealth() {  // token status for the sidebar menu and the account page (refresh only, no API quota)
  if (S.health) return Promise.resolve();
  return healthJob ||= loadManager(false).catch(() => {}).finally(() => { healthJob = null; renderRail(); });
}
let viewKey = '';
function setView(html, kind = 'page') {
  const v = $('#view'), key = `${S.page}|${S.sel}|${kind}`;
  v.classList.remove('enter');
  v.innerHTML = html;
  if (key === viewKey) return;
  viewKey = key;
  if (kind === 'skeleton') return;
  const stagger = el => [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  stagger(v); v.querySelectorAll('.grid, .list, .wsteps').forEach(stagger);
  void v.offsetWidth;  // restart the animation for the new content
  v.classList.add('enter');
  clearTimeout(setView.t);  // drop the class once played, so later partial updates (polls) never re-animate
  setView.t = setTimeout(() => v.classList.remove('enter'), 1400);
}
async function render() {
  renderRail();
  if (S.sel !== 'all' && !S.health) ensureHealth();
  $('#errors').innerHTML = Object.entries(S.errors).filter(([c]) => chans().includes(c)).map(([c, e]) => `<div class="err" role="alert"><b>${esc(chTitle(c))}:</b> ${esc(e)}</div>`).join('');
  const page = S.page;
  if (S.loading && !['account', 'manager', 'help'].includes(page) && S.meta.channels.length) { setView(skeleton(), 'skeleton'); return; }
  if (S.sel !== 'all' && !chMeta(S.sel).connected && page !== 'quota' && page !== 'manager' && page !== 'account' && page !== 'help') { setView(setupPage(S.sel), 'setup'); return; }
  setView(PAGES[page]());
  if (page === 'account') {
    const k = accKey();
    if (!S.health) ensureHealth().then(() => { if (S.page === 'account') setView(account()); });
    if (k && !S.acc[k]) {
      try { await loadAccount(k); } catch (e) { $('#errors').innerHTML += `<div class="err" role="alert">Info akun gagal dimuat: ${esc(e.message)}</div>`; }
      if (S.page === page) setView(PAGES[page]());
    }
    if ($('#dlList')) pollDownloads();
    return;
  }
  if (page === 'manager' && !S.health) {
    try { await loadManager(false); } catch (e) { S.health = {}; $('#errors').innerHTML += `<div class="err" role="alert">Status login gagal dimuat: ${esc(e.message)}</div>`; }
    if (S.page === page) setView(PAGES[page]());
    return;
  }
  const need = { compare: 'sources', comments: 'comments', overview: 'comments' }[page];
  if (need && chans().some(c => S.data[c] && !S.data[c][need] && !S.errors[c])) {
    await loadExtra(need);
    if (S.page === page) setView(PAGES[page]());
  }
}
function go(page) {
  S.page = page; history.replaceState(null, '', '#' + page);
  $('#rail').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-page],[data-sel],[data-metric],[data-vid],[data-sort],[data-fmt],[data-week],[data-open],[data-reply],[data-send],[data-act],[data-launch],[data-health],[data-forget],[data-auth],[data-auth-cancel],[data-yt],[data-acc]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.acc) { e.preventDefault(); return accAction(t); }
  if (ds.yt) {  // YouTube/Studio pages open in the channel's own Chrome session (signed in as that channel)
    e.preventDefault();
    const old = t.innerHTML; t.setAttribute('aria-disabled', 'true');
    try { await postJson('launch', { ch: ds.ch, kind: ds.yt, id: ds.id, lc: ds.lc }); }
    catch (err) { alert(`Gagal membuka di Chrome ${chTitle(ds.ch)}: ${err.message}`); }
    finally { t.removeAttribute('aria-disabled'); t.innerHTML = old; }
    return;
  }
  if (ds.page) { e.preventDefault(); return go(ds.page); }
  if (ds.sel) { S.sel = ds.sel; return render(); }
  if (ds.metric) { S.metric = ds.metric; return render(); }
  if (ds.sort) { S.filters.dir = S.filters.sort === ds.sort ? -S.filters.dir : -1; S.filters.sort = ds.sort; await render(); return $(`[data-sort="${ds.sort}"]`)?.focus(); }
  if (ds.fmt) { S.filters.fmt = ds.fmt; return render(); }
  if (ds.week) { S.weekOffset = ds.week === '0' ? 0 : S.weekOffset + Number(ds.week); await render(); return $(`[data-week="${ds.week}"]`)?.focus(); }
  if (ds.open) { S.onlyOpen = ds.open === '1'; return render(); }
  if (ds.act === 'reset') { Object.assign(S.filters, { q: '', fmt: 'all', status: 'all' }); return render(); }
  if (ds.vid) return openVideo(ds.vid);
  if (ds.health) {
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Mengecek…`;
    try { await loadManager(true); } catch (err) { alert('Gagal mengecek: ' + err.message); }
    return render();
  }
  if (ds.launch) {
    if (t.getAttribute('aria-disabled') === 'true') return alert('Profil Chrome yang dipilih tidak ditemukan; pilih ulang.');
    try { await postJson('launch', { ch: ds.launch }); } catch (err) { return alert('Gagal membuka Studio: ' + err.message); }
    setTimeout(() => api('chrome-profiles').then(p => { S.sessions = p.sessions || {}; if (S.page === 'manager') render(); }).catch(() => {}), 4000);
    return;
  }
  if (ds.authCancel) {
    try { const st = await postJson('auth-cancel', { ch: ds.authCancel }); S.auth = { ...(S.auth || {}), [ds.authCancel]: st }; render(); }
    catch (err) { alert('Gagal membatalkan: ' + err.message); }
    return;
  }
  if (ds.auth) {
    if (t.getAttribute('aria-disabled') === 'true') return;
    try { const st = await postJson('auth', { ch: ds.auth }); S.auth = { ...(S.auth || {}), [ds.auth]: st }; pollAuth(); render(); }
    catch (err) { alert('Gagal memulai login: ' + err.message); }
    return;
  }
  if (ds.forget) {
    if (!confirm(`Hapus login Google yang tersimpan untuk ${chTitle(ds.forget)}?\n\nJendela Chrome channel ini harus ditutup dulu. Setelah dihapus, klik Buka Studio akan meminta login lagi.`)) return;
    try { await postJson('forget-session', { ch: ds.forget }); const p = await api('chrome-profiles'); S.sessions = p.sessions || {}; render(); }
    catch (err) { alert('Gagal: ' + err.message); }
    return;
  }
  if (ds.reply) {
    const box = $('#rb-' + CSS.escape(ds.reply)), opening = !box.innerHTML;
    t.setAttribute('aria-expanded', String(opening));
    box.innerHTML = opening ? `<label class="sr-only" for="rt-${esc(ds.reply)}">Balasan</label><textarea id="rt-${esc(ds.reply)}" placeholder="Tulis balasan sebagai ${esc(chTitle(ds.ch))}…"></textarea><div style="margin-top:6px;display:flex;gap:8px"><button class="btn primary" data-send="${esc(ds.reply)}" data-ch="${ds.ch}">${icon('send')}Kirim balasan</button></div>` : '';
    if (opening) box.querySelector('textarea').focus();
    return;
  }
  if (ds.send) {
    const text = $('#rt-' + CSS.escape(ds.send)).value.trim(); if (!text) return;
    if (!confirm(`Balasan ini akan langsung tampil PUBLIK di YouTube atas nama ${chTitle(ds.ch)}:\n\n"${text}"\n\nKirim sekarang?`)) return;
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Mengirim…`;
    try {
      await api('reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': window.API_TOKEN }, body: JSON.stringify({ ch: ds.ch, comment_id: ds.send, text }) });
      delete S.data[ds.ch].comments; S.quota = await api('quota'); render();
    } catch (err) { alert('Gagal mengirim: ' + err.message); t.removeAttribute('aria-disabled'); t.innerHTML = `${icon('send')}Kirim balasan`; }
  }
});
// Enter/Space on role=button elements (rows, cards) acts like a click
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return closeDrawer();
  const box = e.target.closest?.('.chartbox');
  if (box && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); return showTip(box, n(box.dataset.idx ?? (CHARTS[box.dataset.chart]?.len - 1)) + (e.key === 'ArrowRight' ? 1 : -1)); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute?.('role') === 'button' && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.target.click(); }
  if (e.key === 'Tab' && $('#drawer').classList.contains('open')) {  // keep focus inside the open drawer
    const f = [...$('#drawer').querySelectorAll('a,button,[tabindex="0"]')]; if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});
document.addEventListener('mousemove', e => {
  const box = e.target.closest?.('.chartbox'); if (!box) return;
  const c = CHARTS[box.dataset.chart], pr = box.querySelector('.plot').getBoundingClientRect();
  showTip(box, Math.round((e.clientX - pr.left) / pr.width * (c.len - 1)));
});
document.addEventListener('mouseout', e => { const box = e.target.closest?.('.chartbox'); if (box && !box.contains(e.relatedTarget)) box.classList.remove('active'); });
document.addEventListener('focusout', e => { if (e.target.classList?.contains('chartbox')) e.target.classList.remove('active'); });
let qTimer;
document.addEventListener('input', e => {
  if (e.target.id !== 'fq') return;
  S.filters.q = e.target.value; clearTimeout(qTimer);
  qTimer = setTimeout(() => { const pos = e.target.selectionStart; render().then(() => { const i = $('#fq'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); }, 180);
});
document.addEventListener('change', async e => {
  if (e.target.id === 'fstatus') { S.filters.status = e.target.value; return render(); }
  const ch = e.target.dataset?.profileCh; if (!ch) return;
  try {
    await postJson('chrome-profile', { ch, profile: e.target.value });
    S.meta = await api('meta'); render();
  } catch (err) { alert('Gagal menyimpan profil: ' + err.message); render(); }
});
$('#drawerBg').onclick = closeDrawer;
$('#menuBtn').onclick = () => { const o = $('#rail').classList.toggle('open'); $('#menuBtn').setAttribute('aria-expanded', String(o)); };
$('#syncBtn').onclick = async () => { const b = $('#syncBtn'); b.setAttribute('aria-disabled', 'true'); S.meta = await api('meta'); if (S.page === 'manager') await loadManager(true).catch(() => {}); await loadCore(true); await render(); b.removeAttribute('aria-disabled'); };
window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (PAGES[p] && p !== S.page) go(p); });

(async () => {
  S.page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  try { S.meta = await api('meta'); } catch (e) { $('#view').innerHTML = `<div class="err">Server tidak merespons: ${esc(e.message)}</div>`; return; }
  render();
  await loadCore(false); await render();
  setInterval(async () => { S.quota = await api('quota').catch(() => S.quota); renderRail(); }, 60000);
})();
