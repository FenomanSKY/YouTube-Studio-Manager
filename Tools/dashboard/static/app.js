// YouTube Studio Manager front end: plain JS, data from server.py (/api/*). Times are shown in the viewer's time zone.
const LOCALE = 'en-US';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TZL = (new Intl.DateTimeFormat(LOCALE, { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName') || {}).value || '';
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
  return (Number.isInteger(v) ? v : Math.round(v * 10) / 10).toLocaleString(LOCALE);
}
const pct = v => v == null ? '–' : n(v).toFixed(1) + '%';
function isoSec(d) { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return n(m[1]) * 3600 + n(m[2]) * 60 + n(m[3]); }
function mmss(s) { s = Math.round(n(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
const localFmt = (iso, o) => new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...o }).format(new Date(iso));
const fmtDate = iso => localFmt(iso, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = iso => localFmt(iso, { hour: '2-digit', minute: '2-digit' });
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d instanceof Date ? d : new Date(d));
const slotLocal = h => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return localFmt(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' ' + TZL; };
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  const u = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  if (s < 0) { const h = -s / 3600; return h < 24 ? `in ${u(Math.ceil(h), 'hour')}` : `in ${u(Math.ceil(h / 24), 'day')}`; }
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${u(Math.round(s / 3600), 'hour')} ago`;
  return `${u(Math.round(s / 86400), 'day')} ago`;
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
  const j = await r.json().catch(() => ({ error: 'invalid response' }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function vstate(v) {
  if (v.privacy === 'private' && v.publish_at && new Date(v.publish_at) > Date.now()) return { k: 'scheduled', t: v.publish_at, label: 'Scheduled', cls: 'a' };
  if (v.privacy === 'public') return { k: 'public', t: v.publish_at || v.published, label: 'Public', cls: 'g' };
  if (v.privacy === 'unlisted') return { k: 'unlisted', t: v.published, label: 'Unlisted', cls: 'n' };
  return { k: 'private', t: v.published, label: 'Private', cls: 'n' };
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
  return `<div class="chartbox" data-chart="${id}" style="height:${h}px" tabindex="0" role="img" aria-label="${esc(summary)}. Hover or press the left/right arrow keys to read each point.">
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
  return `<div aria-busy="true" aria-label="Loading data"><div class="sk" style="height:14px;width:160px"></div><div class="sk" style="height:38px;width:360px;max-width:100%;margin:12px 0 26px"></div>
    <div class="grid g4">${skelCard().repeat(4)}</div><div class="grid main-side mt">${skelCard(320)}${skelCard(320)}</div></div>`;
}
const emptyState = (ic, html) => `<div class="empty">${icon(ic)}${html}</div>`;
function setupPage(k) {
  const c = chMeta(k);
  return `<div class="eyebrow"><span class="tag a">Not connected</span></div><h1>${esc(c.title)}</h1>
  <div class="card setup"><h2>Connect this channel</h2><p class="muted">The channel has been added, but the dashboard is not allowed to read its data yet.</p>
  <p>Open this channel's <a href="#account" data-page="account" style="color:var(--cyan)">Account info</a> and follow the steps: ${c.has_client ? 'click <b>Sign in with Google &amp; connect API</b>, then <b>Allow</b> in the channel\'s Chrome window.' : 'the Google Cloud guide opens every page you need, then click <b>Sign in with Google &amp; connect API</b>.'}</p>
  <button class="btn primary" data-page="account">${icon('badge')}Open Account info</button></div>`;
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
  $('#syncText').textContent = state === 'busy' ? 'Syncing…' : (state === 'partial' ? 'Partly failed · ' : 'Synced · ') + fmtTime(S.synced) + ' ' + TZL;
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
  if (!cs.length) return emptyState('link_off', 'No channel is connected yet.<br>Click a channel name in the sidebar, then <b>Account info</b> to finish connecting it, or read the <a href="#help" data-page="help" style="color:var(--cyan)">Guide</a>.');
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
  const labels = (days.find(d => d.length === len) || []).map(r => localFmt(r.day + 'T12:00:00Z', { day: 'numeric', month: 'short' }));
  const mlabel = { views: 'Views', estimatedMinutesWatched: 'Minutes watched', subscribersGained: 'New subscribers' }[S.metric];
  const series = cs.map((c, i) => ({ name: chTitle(c), color: color(c), dash: i % 2 === 1, vals: pad(S.data[c].daily?.days || []).concat((S.data[c].daily?.days || []).map(r => n(r[S.metric]))) }));
  const top = vids.filter(v => v.st.k === 'public').sort((a, b) => n(b.stats.viewCount) - n(a.stats.viewCount)).slice(0, 5);
  const ins = insights();
  const summary = `${mlabel} per day, last 28 days: ` + series.map(s => `${s.name} total ${fmt(s.vals.reduce((a, b) => a + b, 0))}`).join(', ');

  return `
  <div class="eyebrow"><span class="tag">Network Hub</span>${cs.length} connected channel${cs.length === 1 ? '' : 's'}</div>
  <h1>Portfolio Overview</h1>
  <p class="lead">Combined metrics for ${cs.map(c => `<b>${esc(chTitle(c))}</b>`).join(', ')}. Subscribers and total views are real-time; 28-day figures come from YouTube Analytics (about 2 days behind).</p>
  <div class="grid g4">
    ${metricCard('Total views', 'visibility', fmt(totalViews), delta == null ? '' : `<small class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</small>`, `Real-time · 28-day analytics: <b class="num">${fmt(views)}</b>`, daySeries('views'), '#06B6D4', true)}
    ${metricCard('Total subscribers', 'group', fmt(subs), netSubs ? `<small class="${netSubs > 0 ? 'up' : 'down'}">${netSubs > 0 ? '+' : ''}${netSubs}</small>` : '', `Net, 28 days: ${netSubs >= 0 ? '+' : ''}${netSubs}`, daySeries('subscribersGained'), '#10B981')}
    ${metricCard('Watch hours, 28 days', 'schedule', fmt(hours, 1), '', 'Total minutes watched ÷ 60', daySeries('estimatedMinutesWatched'), '#3B82F6')}
    ${metricCard('Release queue', 'event_upcoming', queue.length, '', queue[0] ? `Next: ${localFmt(queue[0].st.t, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ${TZL}` : 'No scheduled videos', null)}
  </div>
  <div class="grid main-side mt">
    <div class="card">
      <div class="card-head"><div><h2>Daily Views</h2><p>${esc(mlabel)} per day, per channel</p></div>
        <div class="seg" role="group" aria-label="Chart metric">${[['views', 'Views'], ['estimatedMinutesWatched', 'Minutes'], ['subscribersGained', 'Subs']].map(([k, l]) => `<button data-metric="${k}" aria-pressed="${S.metric === k}">${l}</button>`).join('')}</div></div>
      <div class="legend">${series.map(s => `<span><span class="swl${s.dash ? ' dash' : ''}" style="border-color:${s.color}"></span>${esc(s.name)}</span>`).join('')}</div>
      ${len ? chart('daily', series, { labels, summary, empty: `${icon('hourglass_top', 'style="display:block;margin:0 auto 6px;color:#F59E0B"')}<b>No analytics data yet.</b><br>YouTube Analytics needs about 2 days after a video goes live. Real-time total views for now: <b>${fmt(totalViews)}</b>.` })
        : emptyState('hourglass_top', 'No daily data yet.')}
    </div>
    <div class="card"><div class="card-head"><h2>Creator Intelligence</h2><span class="tag">${ins.length} note${ins.length === 1 ? '' : 's'}</span></div>
      <div class="list">${ins.map(i => `<div class="insight ${i.lvl}"><div class="h">${icon(i.icon)}${esc(i.title)}</div><p>${i.html}</p>${i.act ? `<button class="btn secondary" style="margin-top:8px" data-page="${i.act[0]}">${esc(i.act[1])}${icon('arrow_forward')}</button>` : ''}</div>`).join('')}</div></div>
  </div>
  <div class="grid main-side mt">
    <div><div class="card-head"><div><h2>Channels</h2><p>Per-channel metrics and quick actions</p></div></div>
      <div class="list">${cs.map(channelRow).join('')}${S.meta.channels.filter(c => !c.connected).map(c => `<div class="chrow">${avatar(c.key, 'lg')}<div style="min-width:0"><h3>${esc(c.title)}</h3><span class="tag a">Not connected</span></div><span class="hide-sm"></span><span class="hide-sm"></span><span class="hide-sm"></span><button class="btn secondary" data-sel="${c.key}">Set up${icon('arrow_forward')}</button></div>`).join('')}</div></div>
    <div class="card"><div class="card-head"><div><h2>Top Videos</h2><p>All-time public views</p></div></div>
      <div class="list">${top.map(v => `<div class="vid" ${clickable(`data-vid="${v.id}"`, 'Video details: ' + v.title)}>${thumb(v)}<div style="min-width:0"><div class="tt">${esc(v.title)}</div><div class="chb">${chBadge(v.ch)} · <span class="up num">${fmt(v.stats.viewCount)} views</span></div></div></div>`).join('') || emptyState('smart_display', 'No public videos yet.')}</div></div>
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
  const status = !last ? (queued ? ['Premiering soon', 'c'] : ['No public videos yet', 'n']) : (Date.now() - new Date(last.t)) / 864e5 > 3 && !queued ? ['Needs an upload', ''] : ['Active', 'g'];
  return `<div class="chrow">${avatar(c, 'lg')}
    <div style="min-width:0"><h3 class="ellipsis">${esc(d.channel.title)}</h3>
      <div class="muted" style="font-size:13px;margin:2px 0 4px">${esc(d.channel.handle || '')} · ${fmt(st.subscriberCount)} subscribers</div><span class="tag ${status[1]}">${status[0]}</span></div>
    <div class="hide-sm"><div class="k">Total views</div><div class="v">${fmt(st.viewCount)}</div><div class="dim" style="font-size:12px">28 days: ${fmt(v28)}</div></div>
    <div class="hide-sm"><div class="k">Avg. viewed</div><div class="v">${pct(avgPct)}</div></div>
    <div class="hide-sm"><div class="k">Last upload</div><div style="font-size:13px">${last ? ago(last.t) : '–'}</div></div>
    <button class="btn secondary" data-yt="channel" data-ch="${c}" aria-label="Open ${esc(d.channel.title)} in YouTube Studio (channel's Chrome)">Studio${icon('arrow_outward')}</button></div>`;
}
function insights() {
  const out = [], vids = allVideos();
  for (const c of chans()) {
    if (S.errors[c]) { out.push({ lvl: 'bad', icon: 'error', title: chTitle(c) + ': failed to load', html: esc(S.errors[c]) }); continue; }
    const d = S.data[c]; if (!d?.videos) continue;
    if (d.analyticsError) out.push({ lvl: 'warn', icon: 'query_stats', title: `${chTitle(c)}: analytics unavailable`, html: /has not been used|disabled/.test(d.analyticsError) ? 'The YouTube Analytics API is not enabled in this channel\'s Google Cloud project.' : esc(d.analyticsError.slice(0, 160)) });
    const next = vids.filter(v => v.ch === c && v.st.k === 'scheduled').sort((a, b) => new Date(a.st.t) - new Date(b.st.t))[0];
    if (!next) out.push({ lvl: 'warn', icon: 'event_busy', title: `${chTitle(c)}: queue is empty`, html: `No scheduled videos. This channel's release slot is <b>${slotLocal(chMeta(c).slot_utc_hour)}</b>.`, act: ['schedule', 'Open calendar'] });
    else if ((new Date(next.st.t) - Date.now()) / 36e5 < 48) out.push({ lvl: 'good', icon: 'rocket_launch', title: `${chTitle(c)}: goes live ${ago(next.st.t)}`, html: `<b>${esc(next.title)}</b>, ${localFmt(next.st.t, { weekday: 'long', hour: '2-digit', minute: '2-digit' })} ${TZL}.` });
    const ready = S.projects.filter(p => p.channel === c && p.status === 'ready');
    if (ready.length) out.push({ lvl: 'info', icon: 'upload', title: `${chTitle(c)}: ${ready.length} ready to upload`, html: ready.map(p => `<b>${esc(p.title || p.name)}</b>`).join(', ') + '. Video, description and thumbnail are in place.' });
    const an = (d.analytics?.videos || []).filter(r => n(r.views) >= 50).sort((a, b) => n(b.averageViewPercentage) - n(a.averageViewPercentage));
    if (an.length >= 2) {
      const t = d.videos.find(v => v.id === an[0].video);
      out.push({ lvl: 'good', icon: 'trending_up', title: `${chTitle(c)}: best retention`, html: `<b>${esc(t?.title || an[0].video)}</b> is watched <b>${pct(an[0].averageViewPercentage)}</b> on average. Its hook is worth repeating.` });
    }
    const cm = d.comments;
    if (Array.isArray(cm)) { const open = cm.filter(x => !x.replies).length; if (open) out.push({ lvl: 'info', icon: 'forum', title: `${chTitle(c)}: ${open} unanswered comment${open === 1 ? '' : 's'}`, html: 'Replying within the first hour helps engagement.', act: ['comments', 'Open comments'] }); }
  }
  for (const c of S.meta.channels.filter(c => !c.connected)) out.push({ lvl: 'warn', icon: 'link_off', title: `${c.title}: not connected`, html: 'Finish the setup in Account info, then sign in once.' });
  const q = S.quota?.channels || {};
  for (const c of chans()) { const u = q[c]?.units || 0; if (u > 7000) out.push({ lvl: 'bad', icon: 'bolt', title: `${chTitle(c)}: quota running low`, html: `${fmt(u)} / 10,000 units used today.`, act: ['quota', 'Open quota'] }); }
  return out.length ? out : [{ lvl: 'good', icon: 'check_circle', title: 'All good', html: 'Nothing needs your attention.' }];
}

function compare() {
  const cs = chans().filter(c => S.data[c]?.channel);
  if (!cs.length) return emptyState('link_off', 'No channel is connected yet.');
  const an = c => S.data[c].analytics?.videos || [], vsum = c => an(c).reduce((s, r) => s + n(r.views), 0);
  const rows = [
    ['Subscribers', c => fmt(S.data[c].channel.stats.subscriberCount)],
    ['Total views', c => fmt(S.data[c].channel.stats.viewCount)],
    ['Public videos', c => n(S.data[c].channel.stats.videoCount)],
    ['Views, 28 days', c => fmt((S.data[c].daily?.days || []).reduce((a, r) => a + n(r.views), 0))],
    ['Watch hours, 28 days', c => fmt((S.data[c].daily?.days || []).reduce((a, r) => a + n(r.estimatedMinutesWatched), 0) / 60)],
    ['Net subscribers, 28 days', c => (S.data[c].daily?.days || []).reduce((a, r) => a + n(r.subscribersGained) - n(r.subscribersLost), 0)],
    ['Avg. % viewed', c => vsum(c) ? pct(an(c).reduce((s, r) => s + n(r.averageViewPercentage) * n(r.views), 0) / vsum(c)) : '–'],
    ['Avg. view duration', c => vsum(c) ? mmss(an(c).reduce((s, r) => s + n(r.averageViewDuration) * n(r.views), 0) / vsum(c)) : '–'],
    ['Release slot', c => slotLocal(chMeta(c).slot_utc_hour)],
  ];
  const src = { SHORTS: 'Feed Shorts', YT_SEARCH: 'YouTube search', RELATED_VIDEO: 'Suggested videos', SUBSCRIBER: 'Subscriptions feed', BROWSE: 'Home / browse',
    EXT_URL: 'External links', NO_LINK_OTHER: 'Direct / other', PLAYLIST: 'Playlists', NOTIFICATION: 'Notifications', YT_CHANNEL: 'Channel pages',
    YT_OTHER_PAGE: 'Other YouTube pages', END_SCREEN: 'End screens', HASHTAGS: 'Hashtags', SOUND_PAGE: 'Sound pages', ANNOTATION: 'Cards' };
  const region = new Intl.DisplayNames(['en'], { type: 'region' });
  const reg = code => { try { return `${region.of(code)} (${code})`; } catch { return code; } };
  return `<div class="eyebrow"><span class="tag c">Compare</span>Last 28 days</div><h1>Channel Comparison</h1>
  <p class="lead">Compare performance, traffic sources and viewer countries. 28-day figures come from YouTube Analytics (about 2 days behind); subscribers and total views are real-time.</p>
  <div class="card"><div class="table-wrap"><table><caption class="sr-only">Metrics compared across channels</caption><thead><tr><th scope="col">Metric</th>${cs.map(c => `<th scope="col" class="r">${chBadge(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([l, f]) => `<tr><th scope="row" class="muted" style="text-transform:none;font-size:14px;font-weight:400;letter-spacing:0;padding:12px">${l}</th>${cs.map(c => `<td class="r" style="font-weight:600">${f(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
  <div class="grid g2 mt">${cs.map(c => { const s = S.data[c].sources;
    if (!s) return skelCard(260);
    if (s.error) return `<div class="card"><div class="err">${esc(s.error)}</div></div>`;
    const tm = Math.max(1, ...s.traffic.map(r => n(r.views))), cm = Math.max(1, ...s.countries.map(r => n(r.views)));
    const none = emptyState('hourglass_top', 'No data yet. Analytics arrive about 2 days after the first views.');
    return `<div class="card"><div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c)}${esc(chTitle(c))}</h2></div>
      <div class="sub-h">Traffic sources</div>${s.traffic.map(r => barRow(src[r.insightTrafficSourceType] || r.insightTrafficSourceType, n(r.views), tm, color(c), fmt(r.views) + ' views')).join('') || none}
      <div class="sub-h" style="margin-top:18px">Top countries</div>${s.countries.slice(0, 8).map(r => barRow(reg(r.country), n(r.views), cm, '#3B82F6', fmt(r.views) + ' views')).join('') || none}</div>`; }).join('')}</div>`;
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
  const th = (k, l, r) => `<th class="${r ? 'r' : ''}" ${F.sort === k ? `aria-sort="${F.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button class="thb" data-sort="${k}" aria-label="Sort by ${l}">${l}${icon(F.sort === k ? (F.dir > 0 ? 'arrow_upward' : 'arrow_downward') : 'unfold_more')}</button></th>`;
  const dash = '<span class="dim" title="Analytics not available yet">–</span>';
  return `<div class="eyebrow"><span class="tag g">Content</span>${all.length} video${all.length === 1 ? '' : 's'}</div><h1>Content Performance</h1>
  <p class="lead">Every video on the selected channels. Click a row (or press Enter) for retention and details. % viewed, duration and +Subs come from 28-day analytics.</p>
  <div class="card"><div class="filters">
    <label class="sr-only" for="fq">Search videos</label><input class="search" id="fq" type="search" placeholder="Search title, tag or video ID…" value="${esc(F.q)}">
    <div class="seg" role="group" aria-label="Video format">${[['all', `All (${all.length})`], ['short', `Shorts (${cnt(v => v.sec <= 180)})`], ['long', `Long videos (${cnt(v => v.sec > 180)})`]].map(([k, l]) => `<button data-fmt="${k}" aria-pressed="${F.fmt === k}">${l}</button>`).join('')}</div>
    <label class="sr-only" for="fstatus">Status</label><select id="fstatus">${[['all', 'All statuses'], ['public', 'Public'], ['scheduled', 'Scheduled'], ['unlisted', 'Unlisted'], ['private', 'Private']].map(([k, l]) => `<option value="${k}" ${F.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="grow"></span><span class="muted" style="font-size:12px" role="status">Showing ${vids.length} of ${all.length}</span></div>
  <div class="table-wrap"><table><caption class="sr-only">Videos</caption><thead><tr>${th('title', 'Video')}${th('release', 'Status & release')}${th('views', 'Views', 1)}${th('likes', 'Likes', 1)}${th('comments', 'Comments', 1)}${th('pct', '% viewed', 1)}${th('avd', 'Avg. duration', 1)}${th('subs', '+Subs', 1)}</tr></thead>
  <tbody>${vids.map(v => `<tr class="click" ${clickable(`data-vid="${v.id}"`, 'Video details: ' + v.title)}><td style="min-width:320px"><div class="vid">${thumb(v)}<div style="min-width:0"><div class="tt">${esc(v.title)}</div>${chBadge(v.ch)}</div></div></td>
    <td style="white-space:nowrap"><span class="tag ${v.st.cls}">${v.st.label}</span><div class="muted" style="font-size:12px;margin-top:4px">${fmtDate(v.st.t)} ${fmtTime(v.st.t)}</div></td>
    <td class="r" style="font-weight:600">${fmt(v.stats.viewCount)}</td><td class="r">${fmt(v.stats.likeCount)}</td><td class="r">${fmt(v.stats.commentCount)}</td>
    <td class="r">${v.an ? `${pct(v.an.averageViewPercentage)}<div class="bar" style="width:70px;margin-left:auto;margin-top:4px"><i style="width:${Math.min(100, n(v.an.averageViewPercentage))}%;background:${n(v.an.averageViewPercentage) >= 70 ? '#10B981' : '#06B6D4'}"></i></div>` : dash}</td>
    <td class="r">${v.an ? mmss(v.an.averageViewDuration) : dash}</td><td class="r">${v.an ? (n(v.an.subscribersGained) ? '<span class="up">+' + n(v.an.subscribersGained) + '</span>' : '0') : dash}</td></tr>`).join('')}</tbody></table>
  ${vids.length ? '' : emptyState('search_off', `No matching videos. <button class="btn ghost" data-act="reset">Reset filters</button>`)}</div></div>`;
}

async function openVideo(id) {
  const v = allVideos().find(x => x.id === id); if (!v) return;
  lastFocus = document.activeElement;
  const dr = $('#drawer');
  dr.setAttribute('aria-label', 'Video details: ' + v.title);
  dr.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">${chBadge(v.ch)}<button class="icon-btn" id="drClose" aria-label="Close details">${icon('close')}</button></div>
    ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="Thumbnail ${esc(v.title)}" style="width:100%;border-radius:8px;display:block">` : ''}
    <h2 style="margin-top:12px">${esc(v.title)}</h2>
    <div class="muted" style="font-size:13px;margin-top:4px"><span class="tag ${v.st.cls}">${v.st.label}</span> ${localFmt(v.st.t, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} ${TZL} · ${mmss(v.sec)}</div>
    <div class="kv"><div><div class="k">Views</div><div class="v">${fmt(v.stats.viewCount)}</div></div><div><div class="k">Likes</div><div class="v">${fmt(v.stats.likeCount)}</div></div><div><div class="k">Comments</div><div class="v">${fmt(v.stats.commentCount)}</div></div>
      <div><div class="k">% viewed</div><div class="v">${pct(v.an?.averageViewPercentage)}</div></div><div><div class="k">Avg. duration</div><div class="v">${v.an ? mmss(v.an.averageViewDuration) : '–'}</div></div><div><div class="k">+Subs 28d</div><div class="v">${v.an ? n(v.an.subscribersGained) : '–'}</div></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-yt="watch" data-ch="${v.ch}" data-id="${esc(v.id)}">${icon('play_arrow')}Watch</button>
      <button class="btn secondary" data-yt="edit" data-ch="${v.ch}" data-id="${esc(v.id)}">Edit in Studio</button>
      <button class="btn secondary" data-yt="analytics" data-ch="${v.ch}" data-id="${esc(v.id)}">Analytics</button></div>
    <h3 style="margin-top:20px">Audience retention</h3><div id="ret"><div class="sk" style="height:220px;margin-top:10px" aria-busy="true"></div></div>
    ${(v.tags || []).length ? `<h3 style="margin-top:16px">Tags</h3><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${v.tags.map(t => `<span class="tag n" style="text-transform:none">${esc(t)}</span>`).join('')}</div>` : ''}`;
  dr.classList.add('open'); $('#drawerBg').classList.add('open');
  $('#drClose').focus();
  try {
    const r = await api(`retention?ch=${v.ch}&id=${v.id}`);
    $('#ret').innerHTML = r.length ? `<div class="legend" style="margin-top:8px"><span><span class="swl" style="border-color:#FF0033"></span>Viewers remaining</span><span><span class="swl dash" style="border-color:#8B8B94"></span>Start (100%)</span></div>` +
      chart('ret', [{ name: 'Remaining', color: '#FF0033', vals: r.map(x => n(x.audienceWatchRatio) * 100) }, { name: '', color: '#8B8B94', dash: 1, vals: r.map(() => 100) }],
        { labels: r.map(x => Math.round(n(x.elapsedVideoTimeRatio) * 100) + '%'), fmtY: y => Math.round(y) + '%', h: 220, area: false, summary: 'Audience retention curve' })
      : emptyState('hourglass_top', 'No retention data yet. Analytics need about 2 days and enough views.');
  } catch (e) { $('#ret').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function closeDrawer() {
  if (!$('#drawer').classList.contains('open')) return;
  $('#drawer').classList.remove('open'); $('#drawerBg').classList.remove('open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function schedule() {
  const vids = allVideos().filter(v => v.st.k === 'public' || v.st.k === 'scheduled');
  const todayKey = dayKey(new Date()); const [ty, tm, td] = todayKey.split('-').map(Number);
  const base = new Date(Date.UTC(ty, tm - 1, td)); const dow = (base.getUTCDay() + 6) % 7;
  const monday = new Date(base - dow * 864e5 + S.weekOffset * 7 * 864e5);
  const days = [...Array(7)].map((_, i) => new Date(+monday + i * 864e5));
  const dkey = d => d.toISOString().slice(0, 10);
  const byDay = {}; vids.forEach(v => (byDay[dayKey(v.st.t)] = byDay[dayKey(v.st.t)] || []).push(v));
  const dfmt = o => new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...o });
  const range = `${dfmt({ day: 'numeric', month: 'short' }).format(days[0])} – ${dfmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(days[6])}`;
  const up = vids.filter(v => new Date(v.st.t) > Date.now() - 864e5).sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
  const clashes = []; for (let i = 1; i < up.length; i++) if (up[i].ch !== up[i - 1].ch && (new Date(up[i].st.t) - new Date(up[i - 1].st.t)) < 2 * 36e5) clashes.push([up[i - 1], up[i]]);
  const queue = vids.filter(v => v.st.k === 'scheduled').sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
  const projs = S.projects.filter(p => chans().includes(p.channel) && p.status !== 'uploaded');
  const pst = { ready: ['Ready to upload', 'g'], animating: ['Animating', 'c'], script: ['Script', 'a'], idea: ['Idea', 'n'] };
  return `<div class="eyebrow"><span class="tag a">Studio</span>Release schedule & production queue</div><h1>Calendar & Queue</h1>
  <p class="lead">Releases of every channel in one week (${TZL}). ${chans().map(c => `<b>${esc(chTitle(c))}</b> slot ${slotLocal(chMeta(c).slot_utc_hour)}`).join(' · ')}.</p>
  <div class="grid g4" style="margin-bottom:16px">
    ${metricCard('Scheduled', 'event_upcoming', queue.length, '', queue[0] ? 'Next ' + ago(queue[0].st.t) : 'Empty', null)}
    ${metricCard('Ready to upload', 'upload', projs.filter(p => p.status === 'ready').length, '', 'Complete local projects, not uploaded yet', null)}
    ${metricCard('In production', 'movie_edit', projs.filter(p => p.status !== 'ready').length, '', 'Script / animation', null)}
    ${metricCard('Collision guard', 'shield', clashes.length ? clashes.length + ' clash' + (clashes.length === 1 ? '' : 'es') : 'Clear', '', clashes.length ? 'Releases of different channels < 2 h apart' : 'Releases of different channels ≥ 2 h apart', null, clashes.length ? '#F59E0B' : '#10B981')}
  </div>
  <div class="grid main-side">
    <div class="card"><div class="card-head"><div class="wk-nav"><button class="icon-btn" data-week="-1" aria-label="Previous week">${icon('chevron_left')}</button><h2 aria-live="polite">${range}</h2><button class="icon-btn" data-week="1" aria-label="Next week">${icon('chevron_right')}</button>${S.weekOffset ? '<button class="btn ghost" data-week="0">This week</button>' : ''}</div>
      <div class="legend">${chans().map(c => `<span><span class="sw" style="background:${color(c)}"></span>${esc(chTitle(c))}</span>`).join('')}</div></div>
      <div class="week">${days.map(d => { const k = dkey(d), ev = (byDay[k] || []).sort((a, b) => new Date(a.st.t) - new Date(b.st.t));
        return `<div class="day ${k === todayKey ? 'today' : ''}" role="group" aria-label="${dfmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(d)}"><div class="dh"><div class="dn">${dfmt({ weekday: 'short' }).format(d)}${k === todayKey ? ' · today' : ''}</div><div class="dd">${d.getUTCDate()}</div></div>
        <div class="slots">${ev.map(v => `<div class="ev" style="--c:${color(v.ch)}" ${clickable(`data-vid="${v.id}"`, `${fmtTime(v.st.t)} ${v.title}`)}><div class="tm">${fmtTime(v.st.t)}</div><div class="tt">${esc(v.title)}</div><div class="st">${v.st.k === 'scheduled' ? 'Scheduled' : fmt(v.stats.viewCount) + ' views'} · ${v.sec <= 180 ? 'Short' : 'Long'}</div></div>`).join('') || '<div class="dim" style="font-size:12px;text-align:center;padding:12px 0">Empty</div>'}</div></div>`; }).join('')}</div>
      ${clashes.map(([a, b]) => `<div class="insight warn mt"><div class="h">${icon('warning')}Releases close together</div><p><b>${esc(a.title)}</b> (${esc(chTitle(a.ch))}, ${fmtTime(a.st.t)}) and <b>${esc(b.title)}</b> (${esc(chTitle(b.ch))}, ${fmtTime(b.st.t)}).</p></div>`).join('')}
    </div>
    <div class="card"><div class="card-head"><h2>Queue</h2><span class="tag n">${queue.length + projs.length}</span></div>
      <div class="sub-h">Scheduled on YouTube</div>
      ${queue.map(v => `<div class="qitem vid" ${clickable(`data-vid="${v.id}"`, 'Video details: ' + v.title)}>${thumb(v)}<div style="min-width:0"><span class="tag a">${localFmt(v.st.t, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(v.st.t)} ${TZL}</span><div class="tt" style="margin-top:4px">${esc(v.title)}</div>${chBadge(v.ch)}</div></div>`).join('') || emptyState('event_busy', 'No scheduled videos.')}
      <div class="sub-h">Local projects</div>
      ${projs.map(p => `<div class="qitem">${icon(p.status === 'ready' ? 'task_alt' : 'movie_edit', `style="color:${color(p.channel)}"`)}<div style="min-width:0"><span class="tag ${pst[p.status][1]}">${pst[p.status][0]}</span>
        <div style="font-weight:600;font-size:13px;margin-top:4px">${esc(p.title || p.name)}</div><div class="muted" style="font-size:12px">${chBadge(p.channel)} · ${esc(p.name)}${p.video_mb ? ' · ' + p.video_mb + ' MB' : ''}</div></div></div>`).join('') || emptyState('inventory_2', 'Every project has been uploaded.')}
    </div></div>`;
}

function comments() {
  const blocks = chans().map(c => ({ c, d: S.errors[c] ? { error: S.errors[c] } : S.data[c]?.comments }));
  if (blocks.some(b => !b.d)) return `<div class="eyebrow"><span class="tag">Community</span></div><h1>Comments</h1><div class="card" aria-busy="true">${'<div style="display:flex;gap:12px;padding:14px 0"><div class="sk" style="width:36px;height:36px;border-radius:50%"></div><div style="flex:1"><div class="sk" style="height:12px;width:30%"></div><div class="sk" style="height:12px;width:80%;margin-top:10px"></div></div></div>'.repeat(4)}</div>`;
  let list = blocks.flatMap(({ c, d }) => Array.isArray(d) ? d.map(x => ({ ...x, ch: c })) : []);
  list.sort((a, b) => new Date(b.published) - new Date(a.published));
  const total = list.length, open = list.filter(x => !x.replies).length;
  if (S.onlyOpen) list = list.filter(x => !x.replies);
  return `<div class="eyebrow"><span class="tag">Community</span>Latest 8 public videos per channel</div><h1>Comments</h1>
  <p class="lead">Replies are posted publicly as the channel, so every reply asks for confirmation first. <b>${open}</b> unanswered comment${open === 1 ? '' : 's'}.</p>
  ${blocks.filter(b => b.d.error).map(b => `<div class="err">${esc(chTitle(b.c))}: ${esc(b.d.error)}</div>`).join('')}
  <div class="card"><div class="filters"><div class="seg" role="group" aria-label="Filter comments"><button data-open="0" aria-pressed="${!S.onlyOpen}">All (${total})</button><button data-open="1" aria-pressed="${S.onlyOpen}">Unanswered (${open})</button></div></div>
  ${list.map(x => `<div class="cmt"><div class="avc" aria-hidden="true">${initials(x.author)}</div><div style="min-width:0">
    <div class="meta"><b style="color:#fff">${esc(x.author)}</b><span>${ago(x.published)}</span>${chBadge(x.ch)}<a ${clickable(`data-vid="${x.video_id}"`)} style="color:var(--cyan)" class="ellipsis">${esc(x.video_title)}</a></div>
    <div class="txt">${esc(x.text)}</div>
    <div class="meta"><span>${icon('thumb_up', 'style="font-size:16px"')} ${n(x.likes)}</span><span>${n(x.replies)} repl${n(x.replies) === 1 ? 'y' : 'ies'}</span>
      <button class="btn ghost" data-reply="${esc(x.id)}" data-ch="${x.ch}" aria-expanded="false">${icon('reply', 'style="font-size:16px"')}Reply</button>
      <button class="btn ghost" data-yt="watch" data-ch="${x.ch}" data-id="${esc(x.video_id)}" data-lc="${esc(x.id)}">View on YouTube</button></div>
    <div id="rb-${esc(x.id)}"></div></div></div>`).join('') || emptyState('forum', S.onlyOpen ? 'Every comment has a reply.' : 'No comments yet. Comments on public videos appear here.')}</div>`;
}

function quota() {
  const q = S.quota; const now = new Date();
  const pt = new Date(now.getTime() - 8 * 36e5); const reset = new Date(Date.UTC(pt.getUTCFullYear(), pt.getUTCMonth(), pt.getUTCDate() + 1, 8));
  return `<div class="eyebrow"><span class="tag c">Developer</span>Quota day ${esc(q.day)} (Pacific)</div><h1>API Quota</h1>
  <p class="lead">Estimated from every call made through <b>yt.py</b> (dashboard + CLI). Each channel has its own Google Cloud project, so quotas are separate. Resets ${localFmt(reset, { weekday: 'long', hour: '2-digit', minute: '2-digit' })} ${TZL}.</p>
  <div class="grid g2">${S.meta.channels.map(c => { const r = q.channels[c.key] || { units: 0, analytics: 0, calls: {} }; const left = q.limit - r.units;
    return `<div class="card"><div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c.key)}${esc(chTitle(c.key))}</h2>${c.connected ? `<span class="tag ${left < 3000 ? '' : 'g'}">${fmt(left)} left</span>` : '<span class="tag a">Not connected</span>'}</div>
      <div class="metric"><div class="val">${fmt(r.units)}<small class="muted">/ ${fmt(q.limit)} units</small></div></div>
      <div class="bar" style="height:10px" role="progressbar" aria-valuemin="0" aria-valuemax="${q.limit}" aria-valuenow="${r.units}" aria-label="Quota used by ${esc(chTitle(c.key))}"><i style="width:${Math.min(100, r.units / q.limit * 100)}%;background:${r.units > 7000 ? '#FF0033' : color(c.key)}"></i></div>
      <p class="muted" style="font-size:13px">Enough for about ${Math.max(0, Math.floor(left / 2150))} more upload(s) today (upload + captions + thumbnail + translations ≈ 2,150 units). Analytics API: ${r.analytics} request(s).</p>
      <table><thead><tr><th scope="col" style="padding:10px 12px">Call</th><th scope="col" class="r" style="padding:10px 12px">Count</th></tr></thead><tbody>${Object.entries(r.calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="r">${v}</td></tr>`).join('') || '<tr><td colspan="2" class="dim">No calls today</td></tr>'}</tbody></table></div>`; }).join('')}</div>`;
}

// ---------- manager: login health + Studio launcher ----------
const HST = {
  ok: ['Signed in', 'g', 'verified_user'], expiring: ['Expiring soon', 'a', 'timer'],
  unknown_age: ['Login age unknown', 'a', 'help'], expired: ['Login expired', '', 'gpp_bad'],
  missing: ['Not signed in', 'n', 'link_off'], offline: ['Cannot check (offline)', 'n', 'wifi_off'], error: ['Error', '', 'error'],
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
  const h = S.health[c.key] || { state: 'error', detail: 'no data' };
  const [label, cls, ic] = HST[h.state] || HST.error;
  const units = S.quota?.channels[c.key]?.units || 0;
  const prof = (S.profiles || []).find(p => p.dir === c.chrome_profile);
  const store = h.store === 'vault' ? `${icon('lock', 'style="font-size:16px;color:var(--green)"')} Encrypted vault (DPAPI)`
    : h.store === 'plain' ? `${icon('lock_open', 'style="font-size:16px;color:var(--amber)"')} Plain file in Secrets` : '–';
  const age = h.days_left != null ? `${h.days_left <= 0 ? 'expired' : h.days_left.toFixed(1) + ' days left'} (ends ${fmtDate(h.expires_at)})`
    : h.oauth_mode === 'production' ? 'does not expire (production)' : (h.login_at ? '–' : 'not recorded');
  const needLogin = ['expired', 'missing', 'expiring', 'unknown_age'].includes(h.state);
  return `<div class="card mgr" style="border-top:3px solid ${color(c.key)}">
    <div class="card-head"><h2 style="display:flex;gap:10px;align-items:center">${avatar(c.key)}${esc(chTitle(c.key))}</h2><span class="tag ${cls}">${icon(ic, 'style="font-size:14px;vertical-align:-3px"')} ${esc(label)}</span></div>
    ${h.detail ? `<p class="muted" style="font-size:13px;margin:-6px 0 10px">${esc(h.detail)}</p>` : ''}
    ${kv('Token', store)}
    ${kv('OAuth mode', h.oauth_mode === 'production' ? 'Production' : 'Testing (7-day refresh token)')}
    ${kv('Last sign-in', h.login_at ? `${fmtDate(h.login_at)} · ${ago(h.login_at)}` : 'not recorded')}
    ${kv('Valid for', age)}
    ${kv('Quota today', `<span class="num">${fmt(units)}</span> / ${fmt(S.quota?.limit || 10000)} units`)}
    <div class="sub-h">YouTube Studio</div>
    <div class="mgr-row">
      <label class="sr-only" for="cp-${c.key}">Chrome profile for ${esc(c.title)}</label>
      <select id="cp-${c.key}" data-profile-ch="${c.key}">
        <option value="">Channel's own session (recommended)</option>
        ${(S.profiles || []).map(p => `<option value="${esc(p.dir)}" ${p.dir === c.chrome_profile ? 'selected' : ''}>Regular Chrome profile: ${esc(p.name)}${p.email ? ' · ' + esc(p.email) : ''}</option>`).join('')}
      </select>
      <button class="btn primary" data-launch="${c.key}" ${c.chrome_profile && !prof ? 'aria-disabled="true"' : ''}>${icon('open_in_new')}Open Studio</button>
    </div>
    ${c.chrome_profile && !prof ? `<p class="muted" style="font-size:12px">Profile <b>${esc(c.chrome_profile)}</b> no longer exists; pick another one.</p>` : ''}
    ${!c.chrome_profile ? (() => { const s = S.sessions?.[c.key] || {};
      if (!s.exists) return `<p class="muted" style="font-size:12px;margin:8px 0 0">${icon('login', 'style="font-size:14px;vertical-align:-2px"')} No saved sign-in yet. Click <b>Open Studio</b>: this channel's own Chrome window opens on the Google sign-in page. Sign in once with the account that owns <b>${esc(chTitle(c.key))}</b>; after that Studio opens without signing in.</p>`;
      return `<div class="mgr-row" style="margin-top:8px;font-size:12px"><span class="muted" style="flex:1;min-width:0">${icon('verified_user', 'style="font-size:14px;vertical-align:-2px;color:var(--green)"')} Sign-in saved${s.emails?.length ? ': <b style="color:#fff">' + s.emails.map(esc).join(', ') + '</b>' : ' (the email shows once Chrome is signed in)'}${s.last_opened ? ' · opened ' + ago(s.last_opened) : ''}</span>
        <button class="btn ghost" data-forget="${c.key}">${icon('logout', 'style="font-size:16px"')}Forget sign-in</button></div>`; })() : ''}
    ${(() => { const shared = prof ? S.meta.channels.filter(o => o.key !== c.key && o.chrome_profile === c.chrome_profile) : [];
      return shared.length ? `<p style="font-size:12px;color:var(--amber);margin:8px 0 0">${icon('warning', 'style="font-size:14px;vertical-align:-2px"')} This profile is also used by ${shared.map(o => esc(chTitle(o.key))).join(', ')}. A Chrome profile is signed in to one Google account, <b>${esc(prof.email || prof.name)}</b>; if this channel belongs to another account, Studio refuses ("You don't have permission to view this page"). Create a separate profile for this channel's Google account.</p>` : ''; })()}
    ${(() => { const j = S.auth?.[c.key] || { state: 'idle' }, run = j.state === 'running';
      const sess = !c.chrome_profile && S.sessions?.[c.key]?.exists;
      const msg = run ? `<p style="font-size:12px;color:var(--cyan);margin:8px 0 0">${icon('progress_activity', 'class="ms spin" style="font-size:14px;vertical-align:-2px"')} ${esc(j.message)}<button class="btn ghost" data-auth-cancel="${c.key}" style="margin-left:6px;padding:2px 8px;min-height:0">${icon('close', 'style="font-size:14px"')}Cancel</button></p>`
        : j.state === 'ok' ? `<p style="font-size:12px;color:var(--green);margin:8px 0 0">${icon('task_alt', 'style="font-size:14px;vertical-align:-2px"')} ${esc(j.message)}</p>`
        : j.state === 'failed' ? `<p style="font-size:12px;color:var(--soft-red);margin:8px 0 0">${icon('error', 'style="font-size:14px;vertical-align:-2px"')} Failed: ${esc(j.message)}</p>` : '';
      return `<div class="sub-h">API sign-in (uploads, stats, comments)</div>
        <div class="mgr-row"><span class="muted" style="flex:1 1 200px;font-size:12px">${sess
          ? 'Google\'s consent page opens in this channel\'s signed-in Chrome window. Just click <b>Continue/Allow</b>.'
          : 'Sign in through <b>Open Studio</b> first, so later renewals are a single Allow click.'}</span>
        <button class="btn ${needLogin ? 'primary' : 'secondary'}" data-auth="${c.key}" ${run ? 'aria-disabled="true"' : ''}>${icon('key')}Renew API sign-in</button></div>${msg}`; })()}
  </div>`;
}
function manager() {
  if (!S.health) return `<div class="eyebrow"><span class="tag c">Manager</span></div><h1>Channels &amp; Sign-in</h1><div class="grid g2">${skelCard(260).repeat(2)}</div>`;
  const cs = S.sel === 'all' ? S.meta.channels : S.meta.channels.filter(c => c.key === S.sel);
  const hs = cs.map(c => S.health[c.key] || {});
  const plain = cs.filter(c => S.health[c.key]?.store === 'plain' || S.health[c.key]?.plain_file);
  const testing = hs.filter(h => h.oauth_mode !== 'production').length;
  const bad = hs.filter(h => ['expired', 'missing', 'error'].includes(h.state)).length;
  const noProf = cs.filter(c => !c.chrome_profile).length;
  const ins = [];
  if (bad) ins.push(['bad', 'gpp_bad', `${bad} channel${bad === 1 ? ' needs' : 's need'} a new sign-in`, 'Uploads and stats stop working for those channels until the sign-in is renewed.']);
  const unmigrated = plain.filter(c => S.health[c.key]?.store === 'plain');
  if (plain.length) ins.push(['warn', 'lock_open', `${plain.length} plain token file(s) still present`, unmigrated.length
    ? `Not encrypted yet: ${unmigrated.map(c => esc(chTitle(c.key))).join(', ')}. Run <code>yt.cmd --ch &lt;channel&gt; vault-migrate</code>.`
    : `Every token is read from the encrypted vault, but the old plain JSON copies are still in <code>Secrets</code> (${plain.map(c => esc(chTitle(c.key))).join(', ')}). Move them to the Recycle Bin with <code>yt.cmd --ch &lt;channel&gt; vault-remove-plain</code>.`]);
  if (testing) ins.push(['info', 'science', `${testing} OAuth app(s) still in Testing mode`, 'Refresh tokens expire 7 days after sign-in. Switch the app to <b>In production</b> in the Google Cloud Console to stop weekly sign-ins, then set <code>"oauth_mode": "production"</code> in channels.json.']);
  if (noProf) ins.push(['info', 'account_circle', `${noProf} channel(s) use their own Chrome session`, 'Each channel gets a separate Chrome session. Sign in once through Open Studio; you can also pick a regular Chrome profile on the channel card.']);
  if (!ins.length) ins.push(['good', 'task_alt', 'All channels healthy', 'Tokens are in the vault, sign-ins are active and Chrome profiles are set.']);
  const checked = hs.map(h => h.checked_at).filter(Boolean).sort()[0];
  return `<div class="eyebrow"><span class="tag c">Manager</span>${cs.length} channel${cs.length === 1 ? '' : 's'}${checked ? ' · checked ' + ago(checked) : ''}</div>
  <h1>Channels &amp; Sign-in</h1>
  <p class="lead">OAuth sign-in status of every channel (checked with a token refresh, no quota used) and YouTube Studio shortcuts in each channel's Chrome session. Token values are never sent to this page.</p>
  <div style="display:flex;gap:8px;margin-bottom:16px"><button class="btn secondary" data-health="1">${icon('refresh')}Re-check sign-ins</button></div>
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
    ${masked ? `<button class="icon-btn" data-acc="reveal" data-field="${field}" aria-label="${shown ? 'Hide' : 'Show'} ${esc(label)}" title="${shown ? 'Hide' : 'Show'}">${icon(shown ? 'visibility_off' : 'visibility')}</button>
    <button class="icon-btn" data-acc="copy" data-field="${field}" aria-label="Copy ${esc(label)}" title="Copy">${icon('content_copy')}</button>` : ''}${extra}</div></div>`;
}
// ---------- Google Cloud setup guide (any user: opens each Console page in the channel's own Chrome) ----------
S.gcpProj = {}; S.downloads = null; S.apiCheck = {}; S.wizOpen = {};
const PROJ_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
function gsteps(email, title) {
  return [
    ['gcp_project', 'add_box', 'Create a Google Cloud project', `Sign in with the Google account that owns <b>${title}</b> if asked. Name the project (for example after the channel), then click <b>Create</b>. First time on Google Cloud? Accept its Terms of Service first. It is free; no credit card needed.`],
    ['gcp_enable', 'toggle_on', 'Enable YouTube Data API v3 and YouTube Analytics API', 'Make sure the new project is selected at the top of the page, then click <b>Next</b> and <b>Enable</b>. Both APIs are enabled at once.'],
    ['gcp_branding', 'badge', 'Set up the OAuth consent screen', 'Click <b>Get started</b>. Enter an app name (anything, e.g. YouTube Studio Manager) and your email, choose <b>External</b>, accept the terms, then <b>Create</b>.'],
    ['gcp_audience', 'group_add', 'Add the channel\'s email as a Test user', `Under <b>Test users</b> click <b>Add users</b>, enter ${email ? `<code>${esc(email)}</code><button class="icon-btn" data-acc="copytext" data-text="${esc(email)}" aria-label="Copy email" title="Copy">${icon('content_copy')}</button>` : 'the Google email that owns the channel'}, then <b>Save</b>. Without this Google refuses the sign-in ("Access blocked").`],
    ['gcp_client', 'key', 'Create a "Desktop app" OAuth client, then download the JSON', 'Application type: <b>Desktop app</b>, any name, click <b>Create</b>, then <b>Download JSON</b>. If Chrome asks where to save it, choose the Downloads folder.'],
  ];
}
function wizard(k, a) {
  const proj = S.gcpProj[k] ?? (a.client?.project_id || '');
  const email = a.session?.emails?.[0];
  return `<div class="wiz"><p class="muted" style="margin:0 0 12px;font-size:13px">Each <b>Open</b> button opens the right Google Cloud Console page in this channel's own Chrome window. Work through them in order; it takes about 5 minutes.</p>
    <ol class="wsteps">${gsteps(email, esc(a.title)).map(([kind, ic, t, d], i) => `<li><span class="wn" aria-hidden="true">${i + 1}</span><div class="wbody"><b>${t}</b><p>${d}</p>${i === 0 ? `<label for="gcpProj">Project ID (optional; shown in Google Cloud, makes the next buttons open the right project)</label><input id="gcpProj" data-proj-ch="${k}" value="${esc(proj)}" placeholder="e.g. cozy-kitchen-123456" autocomplete="off" spellcheck="false">` : ''}</div>
      <button class="btn secondary" data-yt="${kind}" data-ch="${k}" data-id="${PROJ_RE.test(proj) ? esc(proj) : ''}" data-gcp="1">${icon(ic)}Open</button></li>`).join('')}
      <li><span class="wn" aria-hidden="true">6</span><div class="wbody"><b>The .json file is picked up automatically</b><p>The dashboard watches your Downloads folder. Click <b>Use this file</b> on the file that appears: it is moved into the Secrets folder and removed from Downloads.</p><div id="dlList" aria-live="polite">${dlList()}</div></div></li></ol></div>`;
}
function dlList() {
  const wait = t => `<p class="note c">${icon('progress_activity', 'class="ms spin"')} ${t}</p>`;
  if (!S.downloads) return wait('Looking for the file in Downloads…');
  const fs = S.downloads.files.filter(f => f.valid);
  if (!fs.length) return wait(`Waiting for <code>client_secret_….json</code> in <code>${esc(S.downloads.dir)}</code>…`);
  return fs.slice(0, 4).map(f => `<div class="dl"><span class="dl-i">${icon('description')}<span><b>${esc(f.project_id || f.name)}</b><br><span class="muted">${esc(f.client_id)} · ${ago(f.modified)}${f.used_by?.length ? ' · already used by ' + f.used_by.map(esc).join(', ') : ''}</span></span></span>
    <button class="btn primary" data-acc="import" data-name="${esc(f.name)}">${icon('check')}Use this file</button></div>`).join('');
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
  ['space_dashboard', 'overview', 'Overview', 'Subscribers, views, watch hours and 28-day trends across all channels; top videos and unanswered comments.'],
  ['compare_arrows', 'compare', 'Channel Comparison', 'Channels side by side: growth, retention and traffic sources.'],
  ['video_library', 'content', 'Content Performance', 'Every video in one table with filters and sorting; click a video for details, retention and Edit in Studio.'],
  ['calendar_month', 'schedule', 'Calendar & Queue', 'Weekly release schedule, each channel\'s upload slot, release clash warnings and local project status.'],
  ['forum', 'comments', 'Comments', 'Latest comments from every channel. Reply right from the dashboard (always confirmed before posting).'],
  ['bolt', 'quota', 'API Quota', 'Today\'s YouTube Data API quota use per channel (10,000 units/day per Google Cloud project).'],
  ['manage_accounts', 'manager', 'Channels & Sign-in', 'Sign-in health of every channel, time left, each channel\'s Chrome session and a Renew sign-in button.'],
];
function startSteps() {
  return `<ol class="wsteps">
    <li><span class="wn" aria-hidden="true">1</span><div class="wbody"><b>Add a channel</b><p>Click <b>Add Channel</b> in the left sidebar. Enter the channel name, language and upload time.</p></div><button class="btn primary" data-acc="add">${icon('add')}Add Channel</button></li>
    <li><span class="wn" aria-hidden="true">2</span><div class="wbody"><b>Follow the Google Cloud guide</b><p>The dashboard opens every Google Cloud page you need in the channel's own Chrome window: create a project, enable the YouTube Data API and Analytics API, add a Test user and create a "Desktop app" client. The <code>.json</code> file is picked up from Downloads automatically.</p></div></li>
    <li><span class="wn" aria-hidden="true">3</span><div class="wbody"><b>Sign in with Google &amp; connect the API</b><p>Sign in with the account that owns the channel in that Chrome window, then click <b>Allow</b>. The same sign-in opens YouTube Studio too, so you only do it once.</p></div></li>
    <li><span class="wn" aria-hidden="true">4</span><div class="wbody"><b>Done</b><p>Channel data shows up on every page. Click a channel name in the sidebar for quick actions: Account info, Open Studio, View on YouTube, Project folder, Renew sign-in.</p></div></li></ol>`;
}
function welcome() {
  return `<img class="wlogo" src="logo.svg" alt="" aria-hidden="true"><div class="eyebrow"><span class="tag c">Get started</span>No channels yet</div><h1>Welcome to YouTube Studio Manager</h1>
  <p class="lead">A local dashboard for running several YouTube channels at once: stats, content, schedule, comments, API quota and sign-ins, all in one place. It runs on your own computer.</p>
  <div class="card"><h2>Get started in 4 steps</h2>${startSteps()}</div>
  <p class="muted mt">Want to know what each feature does, or stuck? Open the <a href="#help" data-page="help" style="color:var(--cyan)">Guide</a>.</p>`;
}
function help() {
  const faq = [
    ['"Access blocked" when signing in', 'The channel\'s Google email is not listed as a <b>Test user</b>. Open Account info → Google Cloud guide → step 4.'],
    ['"Google hasn\'t verified this app"', 'Normal for your own app while it is in Testing mode. Click <b>Continue</b>.'],
    ['Why do I have to sign in again every 7 days?', 'Google drops the permission of apps in <b>Testing</b> mode after 7 days. Switch the app to <b>In production</b> in Google Cloud (Audience → Publish app) to keep the sign-in, then set <code>"oauth_mode": "production"</code> for that channel in <code>channels.json</code>.'],
    ['Sign-in stuck on "Waiting for Allow"', 'The Google tab was closed before you clicked Allow. Click <b>Cancel sign-in</b> in the channel menu and try again.'],
    ['YouTube Studio refuses ("You don\'t have permission to view this page")', 'That channel\'s Chrome is signed in to another Google account. In Channels &amp; Sign-in click <b>Forget sign-in</b>, then Open Studio and sign in with the channel owner\'s account.'],
    ['API quota used up', 'Each Google Cloud project gets 10,000 units/day, reset at midnight Pacific time. Use one project per channel so quotas are not shared.'],
    ['Retention or traffic stats are empty', 'YouTube Analytics needs 2–3 days before data appears.'],
  ];
  return `<div class="eyebrow"><span class="tag c">Help</span>Guide</div><h1>YouTube Studio Manager Guide</h1>
  <p class="lead">Everything you need to start using the dashboard, with no manual setup outside it.</p>
  <div class="card"><h2>Get started</h2>${startSteps()}</div>
  <h2 class="mt" style="margin-top:28px">Features</h2>
  <div class="grid g2 mt">${FEATURES.map(([ic, p, t, d]) => `<a class="card feat" href="#${p}" data-page="${p}"><div class="h">${icon(ic)}<b>${t}</b></div><p class="muted">${d}</p></a>`).join('')}
    <div class="card feat"><div class="h">${icon('menu_open')}<b>Channel menu in the sidebar</b></div><p class="muted">Click a channel name: sign-in status, today's quota, <b>Account info</b> (Channel ID, .json file, API key, API check, audit log, revoke access, remove from dashboard), Open Studio, View on YouTube, Project folder, Renew sign-in.</p></div></div>
  <div class="grid g2 mt">
    <div class="card"><h2>Privacy &amp; security</h2><ul class="plain">
      <li>${icon('computer')} Runs only on this computer (<code>127.0.0.1</code>); no server other than Google's is contacted.</li>
      <li>${icon('lock')} Sign-in tokens and API keys are encrypted with Windows DPAPI for this Windows account.</li>
      <li>${icon('password')} The dashboard never stores or types Google passwords; Chrome keeps the sign-in session.</li>
      <li>${icon('visibility_off')} Credentials are masked and only shown on click; every show, copy and download is logged.</li>
      <li>${icon('verified')} Public actions (replying to comments) always ask for confirmation.</li></ul>
      <p class="muted" style="font-size:12px;margin:12px 0 0">YouTube Studio Manager is an independent open-source project. It is not affiliated with, endorsed or sponsored by Google LLC or YouTube.</p></div>
    <div class="card"><h2>Troubleshooting</h2>${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p class="muted">${a}</p></details>`).join('')}</div>
  </div>`;
}

function account() {
  const chips = S.meta.channels.map(c => `<button class="chipbtn" data-acc="pick" data-ch="${c.key}" aria-pressed="${c.key === accKey()}">${avatar(c.key)}${esc(chTitle(c.key))}${c.pending ? ' <span class="tag a">new</span>' : ''}</button>`).join('');
  const head = `<div class="eyebrow"><span class="tag c">Manager</span>Account &amp; credentials</div>
  <div class="acc-top"><div><h1>Account Info</h1><p class="lead">Each channel's Google account, OAuth client file (.json) and API key. All credentials stay on this PC; here they are masked and only shown when you click the eye icon. Every show, copy, download and replacement is written to the audit log.</p></div></div>
  ${S.sel === 'all' ? `<div class="chips" role="group" aria-label="Choose a channel">${chips}</div>` : ''}`;
  const k = accKey();
  if (!k) return head + emptyState('person_add', '<b>No channels yet.</b><br>Click <b>Add Channel</b> in the sidebar to connect your first YouTube account.');
  const a = S.acc[k];
  if (!a) return head + `<div class="grid main-side mt">${skelCard(300)}${skelCard(300)}</div>`;
  const h = S.health?.[k] || a.health || {}, [hl, hc, hi] = a.pending ? ['Waiting for sign-in', 'a', 'hourglass_top'] : (HST[h.state] || ['Not checked', 'n', 'help']);
  const job = S.auth?.[k] || { state: 'idle' }, run = job.state === 'running';
  const emails = a.session?.emails || [];
  const t = a.token || {}, cl = a.client || {};
  const jobMsg = run ? `<p class="note c">${icon('progress_activity', 'class="ms spin"')} ${esc(job.message)}<button class="btn ghost" data-auth-cancel="${k}" style="margin-left:6px;padding:2px 8px;min-height:0">${icon('close', 'style="font-size:14px"')}Cancel</button></p>`
    : job.state === 'ok' ? `<p class="note g">${icon('task_alt')} ${esc(job.message)}</p>`
    : job.state === 'failed' ? `<p class="note r">${icon('error')} Failed: ${esc(job.message)}</p>` : '';
  const pending = a.pending ? `<div class="card steps mt" style="border-color:rgba(245,158,11,.4)"><h2>${icon('pending_actions')} Finish connecting ${esc(a.title)}</h2>
    ${!cl.exists ? `<p class="muted" style="margin:8px 0 14px">Step 1 of 2: set up a free Google Cloud project so the dashboard may read this channel's data.</p>${wizard(k, a)}<p class="muted" style="font-size:12px;margin:12px 0 0">Already have a .json file? Upload it on the <b>OAuth client file</b> card below.</p></div>` : `
    <p class="muted" style="margin:8px 0 10px">Step 2 of 2. The OAuth client file is ready (project <code>${esc(cl.project_id || '?')}</code>).</p>
    <ol><li>Make sure the Google email that owns the channel is a <b>Test user</b> in that project (step 4 of the <button class="linkbtn" data-acc="wizard">Google Cloud guide</button>). Otherwise Google refuses with "Access blocked".</li>
    <li>Click <b>Sign in with Google &amp; connect API</b>. This channel's own Chrome window opens: sign in with the channel owner's account (only once), pick the channel, then click <b>Allow</b>. Seeing "Google hasn't verified this app"? Click <b>Continue</b>; the app is your own.</li>
    <li>The same sign-in is kept for <b>Open Studio</b>, so you will not need to sign in again.</li></ol>
    <button class="btn primary" data-auth="${k}" ${run ? 'aria-disabled="true"' : ''}>${icon('login')}Sign in with Google &amp; connect API</button>${jobMsg}</div>`}` : '';
  const ids = `<div class="card mt acc-head" style="border-top:3px solid ${color(k)}">
    <div class="card-head"><h2 style="display:flex;gap:12px;align-items:center">${avatar(k, 'lg')}<span>${esc(chTitle(k))}<br><span class="muted" style="font-size:13px;font-weight:400">key <code>${esc(k)}</code> · ${a.language === 'id' ? 'Indonesian' : 'English'} · slot ${slotLocal(a.slot_utc_hour)}</span></span></h2>
    <span class="tag ${hc}">${icon(hi, 'style="font-size:14px;vertical-align:-3px"')} ${esc(hl)}</span></div>
    <div class="grid g4 facts">
      <div><div class="k">Channel ID</div><div class="v">${a.channel_id ? `<code>${esc(a.channel_id)}</code><button class="icon-btn" data-acc="copytext" data-text="${esc(a.channel_id)}" aria-label="Copy Channel ID">${icon('content_copy')}</button>` : '<span class="muted">after sign-in</span>'}</div></div>
      <div><div class="k">Google account (Chrome)</div><div class="v">${emails.length ? emails.map(esc).join('<br>') : `<span class="muted">${a.session?.exists ? 'sign-in saved' : 'not signed in'}</span>`}</div></div>
      <div><div class="k">Last API sign-in</div><div class="v">${t.login_at ? `${fmtDate(t.login_at)} <span class="muted">· ${ago(t.login_at)}</span>` : '<span class="muted">not recorded</span>'}</div></div>
      <div><div class="k">Token</div><div class="v">${t.stored ? `${icon('lock', 'style="font-size:16px;color:var(--green)"')} Vault DPAPI` : t.error ? `<span class="down">${esc(t.error)}</span>` : '<span class="muted">none yet</span>'}</div></div>
    </div>
    ${t.scopes?.length ? `<div class="sub-h">OAuth permissions (scopes)</div><div class="scopes">${t.scopes.map(s => `<span class="tag n">${esc(scopeName(s))}</span>`).join('')}</div>` : ''}
    ${!a.pending ? `<div class="mgr-row mt"><button class="btn secondary" data-auth="${k}" ${run ? 'aria-disabled="true"' : ''}>${icon('key')}Renew API sign-in</button><button class="btn secondary" data-launch="${k}">${icon('open_in_new')}Open Studio</button></div>${jobMsg}` : ''}
  </div>`;
  const shared = a.client_shared_with?.length ? `<p class="note a">${icon('share')} This client file is also used by ${a.client_shared_with.map(esc).join(', ')}. The 10,000 units/day quota of project <code>${esc(cl.project_id)}</code> is shared.</p>` : '';
  const chk = S.apiCheck[k];
  const apiBox = a.channel_id && !a.pending && t.stored ? `<div class="sub-h" style="margin-top:18px">APIs in this project</div>
    ${chk ? [['data', 'YouTube Data API v3', 'gcp_data'], ['analytics', 'YouTube Analytics API', 'gcp_analytics']].map(([n_, nm, kind]) => { const r = chk[n_] || {};
      return `<div class="cred"><div class="cred-l">${nm}</div><div class="cred-v">${r.ok ? `<span class="up">${icon('check_circle', 'style="font-size:16px"')} Enabled</span>`
        : `<span class="down">${esc(r.message || 'failed')}</span>${r.disabled ? `<button class="btn secondary" data-yt="${kind}" data-ch="${k}" data-id="${esc(cl.project_id || '')}" style="margin-left:auto">${icon('toggle_on')}Enable</button>` : ''}`}</div></div>`; }).join('') : ''}
    <div class="mgr-row" style="margin-top:8px"><button class="btn secondary" data-acc="checkapi">${icon('fact_check')}Check APIs</button><span class="muted" style="font-size:12px">${chk ? 'checked ' + ago(chk.checked_at) + ' · ' : ''}uses 1 quota unit</span></div>` : '';
  const creds = `<div class="card"><div class="card-head"><div><h2>API Keys &amp; Client Secrets</h2><p>OAuth client from the Google Cloud Console, used for this channel's API sign-in.</p></div></div>
    ${!cl.exists ? `<p class="note r">${icon('error')} Client file <code>${esc(cl.file || '–')}</code> was not found in Secrets. Upload it again on the JSON card.</p>` : cl.error ? `<p class="note r">${icon('error')} ${esc(cl.error)}</p>` : `
    ${secretRow(k, 'OAuth Client ID', 'client_id', cl.client_id)}
    ${secretRow(k, 'Client Secret', 'client_secret', cl.client_secret)}
    <div class="cred"><div class="cred-l">Google Cloud project</div><div class="cred-v"><code>${esc(cl.project_id || '–')}</code></div></div>
    <div class="cred"><div class="cred-l">Client type</div><div class="cred-v">${cl.kind === 'installed' ? 'Desktop app (installed)' : esc(cl.kind)}</div></div>`}
    ${shared}${apiBox}
    <div class="sub-h" style="margin-top:18px">YouTube Data API key (optional)</div>
    <p class="muted" style="font-size:12px;margin:0 0 8px">For public calls without sign-in (channel lookups, public stats). Stored encrypted with DPAPI in <code>Secrets\\vault</code>. Channel data still uses the OAuth sign-in.</p>
    ${a.api_key ? secretRow(k, 'API key', 'api_key', a.api_key) + `<div class="mgr-row" style="margin-top:8px"><button class="btn secondary" data-acc="testkey">${icon('network_check')}Test API key</button><button class="btn ghost" data-acc="delkey">${icon('delete')}Remove API key</button></div>` : ''}
    <div class="mgr-row" style="margin-top:8px"><label class="sr-only" for="akey">New API key</label><input id="akey" type="password" autocomplete="off" spellcheck="false" placeholder="${a.api_key ? 'Replace with a new API key (AIza…)' : 'Paste an API key (AIza…)'}" style="flex:1 1 220px;min-width:0"><button class="btn primary" data-acc="setkey">${icon('save')}Save</button></div>
    <p class="note" id="keyMsg" role="status"></p>
  </div>`;
  const json = `<div class="card"><div class="card-head"><div><h2>OAuth client file (.json)</h2><p><code>${esc(cl.file || '–')}</code>${cl.bytes ? ` · ${fmt(cl.bytes)} bytes · modified ${fmtDate(cl.modified)}` : ''}</p></div></div>
    ${cl.json_masked ? `<pre class="json" aria-label="JSON content (masked)">${esc(cl.json_masked)}</pre>` : '<p class="muted">No file yet.</p>'}
    <div class="mgr-row mt">${cl.exists ? `<button class="btn secondary" data-acc="copyjson">${icon('content_copy')}Copy JSON</button><button class="btn secondary" data-acc="download">${icon('download')}Download .json</button>` : ''}
    <label class="btn secondary" for="cjFile" tabindex="0" role="button">${icon('upload_file')}Upload / replace .json file</label><input id="cjFile" type="file" accept=".json,application/json" class="sr-only" data-acc-file="replace">
    <button class="btn secondary" data-acc="wizard" aria-expanded="${!!S.wizOpen[k]}">${icon('assistant_navigation')}Guide: get the .json &amp; enable APIs</button></div>
    ${S.wizOpen[k] && cl.exists ? `<div class="mt">${wizard(k, a)}</div>` : ''}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Replacing the client file invalidates the old token; afterwards click <b>Renew API sign-in</b>.</p>
  </div>`;
  const used = a.units_today || 0;
  const quota = `<div class="card"><h2>Quota today</h2><div class="metric"><div class="val">${fmt(used)}<small class="muted">/ ${fmt(10000)} units</small></div></div><div class="bar"><i style="width:${Math.min(100, used / 100)}%;background:${used > 8000 ? 'var(--red)' : 'var(--green)'}"></i></div>
    <p class="muted" style="font-size:12px">OAuth mode: ${a.oauth_mode === 'production' ? 'Production' : 'Testing (refresh token expires 7 days after sign-in)'}</p></div>`;
  const LBL = { reveal_client_id: 'Client ID shown', reveal_client_secret: 'Client secret shown', reveal_api_key: 'API key shown', copy_json: 'JSON copied', download_json: 'JSON downloaded', oauth_cancelled: 'Sign-in cancelled',
    apikey_set: 'API key saved', apikey_removed: 'API key removed', apikey_test: 'API key tested', client_json_replaced: 'Client file replaced', channel_added: 'Channel added',
    oauth_connected: 'Channel connected', oauth_login: 'API sign-in', oauth_revoked: 'OAuth access revoked', channel_removed: 'Channel removed', client_json_imported: 'Client file imported' };
  const audit = `<div class="card"><h2>Credential audit log</h2>${a.audit?.length ? `<ul class="audit">${a.audit.map(r => `<li><span>${esc(LBL[r.action] || r.action)}${r.detail && !r.action.startsWith('reveal') ? `<br><span class="muted">${esc(r.detail)}</span>` : ''}</span><time class="muted">${fmtDate(r.t)} ${fmtTime(r.t)}</time></li>`).join('')}</ul>` : '<p class="muted">No activity yet.</p>'}</div>`;
  const danger = `<div class="card danger mt"><h2>${icon('warning')} Danger zone</h2>
    <div class="dz"><div><h3>Revoke OAuth access</h3><p class="muted">Tells Google to cancel this dashboard's permission, then archives the token. The channel stays in the dashboard; to use it again click Renew API sign-in.</p></div>
      <button class="btn secondary" data-acc="revoke" ${!t.stored ? 'aria-disabled="true"' : ''}>${icon('link_off')}Revoke access</button></div>
    <div class="dz"><div><h3>Remove account from the dashboard</h3><p class="muted">The channel disappears from YouTube Studio Manager and <code>channels.json</code>. Its token, API key and client file (if no other channel uses it) are moved to <code>Secrets\\_removed</code>, so they can be restored. Video folders in <code>Channels\\</code> are not touched. The YouTube channel itself is not deleted.</p>
      <label for="rmName" style="font-size:12px">Type <b>${esc(a.title)}</b> to confirm</label>
      <div class="mgr-row" style="margin-top:6px"><input id="rmName" autocomplete="off" spellcheck="false" style="flex:1 1 200px;min-width:0"><button class="btn primary danger-btn" data-acc="remove">${icon('delete_forever')}Remove from dashboard</button></div>
      <label class="check"><input type="checkbox" id="rmChrome"> Also delete the Google sign-in saved in this channel's Chrome (close its window first)</label></div></div>
  </div>`;
  return head + pending + ids + `<div class="grid main-side mt"><div class="grid">${creds}${json}</div><div class="grid" style="align-content:start">${quota}${audit}</div></div>` + danger;
}

// upload slot picker: values are UTC hours (channels.json slot_utc_hour), labels in the viewer's time zone
function slotOptions(sel) {
  const local = h => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d.getHours() * 60 + d.getMinutes(); };
  return [...Array(24).keys()].sort((a, b) => local(a) - local(b))
    .map(h => `<option value="${h}" ${h === sel ? 'selected' : ''}>${slotLocal(h)}</option>`).join('');
}
// modal: add a channel
async function openAdd() {
  const dlg = $('#addDlg');
  try { S.clientFiles = await api('client-files'); } catch (e) { S.clientFiles = []; }
  const opts = S.clientFiles.map(f => `<option value="${esc(f.file)}">${esc(f.project_id || f.file)}${f.used_by.length ? ' · used by ' + f.used_by.map(chTitle).map(esc).join(', ') : ' · unused'}</option>`).join('');
  dlg.innerHTML = `<form method="dialog" id="addForm" novalidate>
    <div class="dlg-head"><h2 id="addDlgTitle">Add a YouTube Channel</h2><button type="button" class="icon-btn" data-acc="close" aria-label="Close">${icon('close')}</button></div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">The dashboard saves the channel's settings, then opens a Chrome window just for this channel to sign in to Google. The dashboard never stores passwords; Chrome keeps the sign-in session.</p>
    <label for="nTitle">Channel name</label><input id="nTitle" required maxlength="60" placeholder="e.g. Cozy Kitchen" autocomplete="off">
    <div class="grid g2" style="gap:10px;margin-top:10px">
      <div><label for="nLang">Content language</label><select id="nLang"><option value="en">English</option><option value="id">Indonesian</option></select></div>
      <div><label for="nSlot">Upload time</label><select id="nSlot">${slotOptions(12)}</select></div>
    </div>
    <fieldset><legend>OAuth client file (.json)</legend>
      <label class="check"><input type="radio" name="src" value="guide" checked> <span><b>No .json file yet:</b> guide me through creating one in Google Cloud (free, about 5 minutes, the file is picked up automatically)</span></label>
      <label class="check"><input type="radio" name="src" value="upload"> Upload an existing .json file (one Google Cloud project per channel keeps quotas separate)</label>
      <input id="nFile" type="file" accept=".json,application/json" aria-label="File OAuth client JSON">
      ${opts ? `<label class="check"><input type="radio" name="src" value="existing"> Use a file that is already here</label><select id="nExisting" aria-label="Existing client file">${opts}</select>` : ''}
    </fieldset>
    <div class="insight info" style="margin-top:12px"><div class="h">${icon('info')}What happens next</div><p>The dashboard opens a Chrome window just for this channel. You sign in with the Google account that owns the channel, create a Google Cloud project with the guide, then click <b>Allow</b>. Chrome keeps that sign-in, so YouTube Studio opens without signing in again.</p></div>
    <p class="note r" id="addErr" role="alert"></p>
    <div class="dlg-foot"><button type="button" class="btn ghost" data-acc="close">Cancel</button><button type="submit" class="btn primary" id="addGo">${icon('login')}Add channel</button></div>
  </form>`;
  lastFocus = document.activeElement;
  dlg.showModal(); $('#nTitle').focus();
  $('#addForm').onsubmit = submitAdd;
}
const readFile = f => new Promise((ok, no) => { if (f.size > 64 * 1024) return no(new Error('file is too large for an OAuth client JSON')); const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsText(f); });
async function submitAdd(e) {
  e.preventDefault();
  const err = $('#addErr'), go = $('#addGo'); err.textContent = '';
  const body = { title: $('#nTitle').value.trim(), language: $('#nLang').value, slot_utc_hour: Number($('#nSlot').value) };
  if (body.title.length < 2) { err.textContent = 'Enter the channel name.'; return $('#nTitle').focus(); }
  const src = document.querySelector('input[name=src]:checked').value;
  try {
    if (src === 'upload') { const f = $('#nFile').files[0]; if (!f) { err.textContent = 'Choose the OAuth client .json file.'; return; } body.client_json = await readFile(f); }
    else if (src === 'existing') body.client_file = $('#nExisting').value;
    go.setAttribute('aria-disabled', 'true'); go.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Saving…`;
    const r = await postJson('account/add', body);
    S.meta = await api('meta'); S.accSel = r.key; S.sel = r.key; S.health = null;
    $('#addDlg').close();
    if (body.client_json || body.client_file) { const st = await postJson('auth', { ch: r.key }); S.auth = { ...(S.auth || {}), [r.key]: st }; pollAuth(); }
    if (S.page !== 'account') go_('account'); else render();
  } catch (ex) { err.textContent = ex.message; go.removeAttribute('aria-disabled'); go.innerHTML = `${icon('login')}Add channel`; }
}
const go_ = p => go(p);
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { return alert('This browser cannot access the clipboard.'); }
  if (btn) { const o = btn.innerHTML; btn.innerHTML = icon('check'); setTimeout(() => { btn.innerHTML = o; }, 1200); }
}
async function accAction(t) {
  const ds = t.dataset, k = ds.ch && ds.acc === 'pick' ? ds.ch : accKey(), a = S.acc[k];
  if (t.getAttribute('aria-disabled') === 'true') return;
  if (ds.acc === 'pick') { S.sel = ds.ch; S.reveal = {}; return render(); }
  if (ds.acc === 'folder') { try { await postJson('open-folder', { ch: ds.ch }); } catch (ex) { alert('Could not open the folder: ' + ex.message); } return; }
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
    } catch (ex) { alert('Failed: ' + ex.message); }
    return;
  }
  if (ds.acc === 'copyjson' || ds.acc === 'download') {
    try {
      const r = await postJson('account/download', { ch: k, mode: ds.acc === 'copyjson' ? 'copy' : 'download' });
      if (ds.acc === 'copyjson') await copyText(r.json, t);
      else { const u = URL.createObjectURL(new Blob([r.json], { type: 'application/json' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
      await loadAccount(k); render();
    } catch (ex) { alert('Failed: ' + ex.message); }
    return;
  }
  if (ds.acc === 'wizard') { S.wizOpen[k] = !S.wizOpen[k]; await render(); document.querySelector('.wiz')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
  if (ds.acc === 'import') {
    if (!confirm(`Use ${ds.name} for ${a.title}?\n\nThe file is copied into the Secrets folder and removed from Downloads.`)) return;
    try {
      const r = await postJson('account/import-json', { ch: k, name: ds.name });
      S.downloads = null; S.wizOpen[k] = false; S.meta = await api('meta'); await loadAccount(k); render();
      if (!a.pending && r.changed) alert('Client file replaced. Click "Renew sign-in" so the sign-in uses the new client.');
    } catch (ex) { alert('Failed: ' + ex.message); }
    return;
  }
  if (ds.acc === 'checkapi') {
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Checking…`;
    try { S.apiCheck[k] = await postJson('account/check-apis', { ch: k }); } catch (ex) { alert('API check failed: ' + ex.message); }
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
    if (!confirm(`Remove the API key of ${a.title}?`)) return;
    try { await postJson('account/apikey-remove', { ch: k }); delete S.reveal[k + ':api_key']; await loadAccount(k); render(); } catch (ex) { alert('Failed: ' + ex.message); }
    return;
  }
  if (ds.acc === 'revoke') {
    if (!confirm(`Revoke OAuth access for ${a.title}?\n\nGoogle will cancel this dashboard's permission. Uploads, stats and comments for this channel stop until you sign in to the API again.`)) return;
    try { const r = await postJson('account/revoke', { ch: k }); delete S.data[k]; S.health = null; S.meta = await api('meta'); await loadAccount(k); render(); alert('Done: ' + r.detail); }
    catch (ex) { alert('Failed: ' + ex.message); }
    return;
  }
  if (ds.acc === 'remove') {
    const name = $('#rmName').value.trim();
    if (name !== a.title) { alert(`Type "${a.title}" exactly to confirm.`); return $('#rmName').focus(); }
    if (!confirm(`Remove ${a.title} from the dashboard?\n\nIts credential files are moved to Secrets\\_removed (restorable). The YouTube channel itself is not deleted.`)) return;
    try {
      const r = await postJson('account/remove', { ch: k, confirm: name, forget_chrome: $('#rmChrome').checked });
      delete S.acc[k]; delete S.data[k]; delete S.errors[k]; S.health = null; S.accSel = null; if (S.sel === k) S.sel = 'all';
      S.meta = await api('meta'); render();
      alert(`${a.title} was removed from the dashboard. Archive: ${r.archive}` + (r.chrome && !r.chrome.forgotten && r.chrome.reason ? `\n\nChrome sign-in not deleted: ${r.chrome.reason}` : ''));
    } catch (ex) { alert('Failed: ' + ex.message); }
  }
}
document.addEventListener('change', async e => {
  if (e.target.dataset?.accFile !== 'replace') return;
  const f = e.target.files[0]; if (!f) return;
  const k = accKey();
  if (!confirm(`Replace the OAuth client file of ${chTitle(k)} with ${f.name}?\n\nAfterwards the API sign-in has to be renewed.`)) { e.target.value = ''; return; }
  try { const r = await postJson('account/client-json', { ch: k, json: await readFile(f) }); await loadAccount(k); render(); if (r.changed) alert('Client file replaced. Click "Renew API sign-in" so a new token is created with this client.'); }
  catch (ex) { alert('Failed: ' + ex.message); e.target.value = ''; }
});

// ---------- shell ----------
function chMenu(c) {
  const k = c.key, h = S.health?.[k], j = S.auth?.[k] || {}, run = j.state === 'running';
  const [lbl, cls] = c.pending ? ['Waiting for sign-in', 'a'] : h ? (HST[h.state] || HST.error) : ['Checking sign-in…', 'n'];
  const dot = { g: 'ok', a: 'warn', '': 'err' }[cls] || '';
  const left = h?.days_left != null ? ` · ${Math.max(0, h.days_left).toFixed(1)} days left` : '';
  const units = S.quota?.channels[k]?.units;
  const it = (attrs, ic, text, extra = '') => `<button class="sub-it" ${attrs}>${icon(ic, extra)}<span>${text}</span></button>`;
  return `<div class="ch-menu${railSel !== S.sel ? ' menu-enter' : ''}" role="group" aria-label="Menu ${esc(chTitle(k))}" style="--c:${color(k)}">
    <div class="ch-stat"><span class="dot ${dot}"></span><span>${esc(lbl)}${left}${units != null ? ` · ${fmt(units)} units` : ''}</span></div>
    ${it(`data-page="account"${S.page === 'account' ? ' aria-current="page"' : ''}`, 'badge', 'Account info')}
    ${run ? `<div class="ch-stat" style="color:var(--cyan)">${icon('progress_activity', 'class="ms spin" style="font-size:14px"')}<span>Waiting for Allow in Chrome…</span></div>` + it(`data-auth-cancel="${k}"`, 'close', 'Cancel sign-in')
      : c.pending ? (c.has_client ? it(`data-auth="${k}"`, 'login', 'Sign in with Google') : it('data-page="account"', 'assistant_navigation', 'Set up Google Cloud')) : ''}
    ${it(`data-launch="${k}"`, 'open_in_new', 'Open Studio')}
    ${c.connected ? it(`data-yt="public" data-ch="${k}"`, 'smart_display', 'View on YouTube') : ''}
    ${it(`data-acc="folder" data-ch="${k}"`, 'folder_open', 'Project folder')}
    ${!c.pending && !run ? it(`data-auth="${k}"`, 'key', 'Renew sign-in') : ''}
  </div>`;
}
let railSel = null;  // channel whose sidebar menu was drawn last: its menu animates in only when this changes
function renderRail() {
  const tot = connected().reduce((a, k) => a + n(S.data[k]?.channel?.stats.subscriberCount), 0);
  const opt = (k, title, sub, av, off) => `<button data-sel="${k}" aria-pressed="${S.sel === k}">${av}<span style="min-width:0"><div class="t ellipsis">${esc(title)}</div><div class="s${off ? ' off' : ''}">${sub}</div></span></button>`;
  const subLine = k => S.loading ? 'Loading…' : S.errors[k] ? 'Failed to load' : fmt(S.data[k]?.channel?.stats.subscriberCount) + ' subscribers';
  $('#switcher').innerHTML = opt('all', `All Channels (${connected().length})`, S.loading ? 'Loading…' : fmt(tot) + ' subscribers', `<span class="av" style="background:#3F3F46" aria-hidden="true">${icon('hub', 'style="color:#4cd7f6;font-size:18px"')}</span>`) +
    S.meta.channels.map(c => opt(c.key, chTitle(c.key), c.connected ? subLine(c.key) : 'Not connected', avatar(c.key), !c.connected || S.errors[c.key]) + (S.sel === c.key ? chMenu(c) : '')).join('') +
    `<button class="add-ch" data-acc="add">${icon('add_circle')}<span>Add Channel</span></button>`;
  railSel = S.sel;
  document.querySelectorAll('nav a').forEach(a => a.dataset.page === S.page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  const used = S.quota ? Math.max(0, ...connected().map(k => S.quota.channels[k]?.units || 0)) : 0;
  $('#quotaMini').innerHTML = `<div style="display:flex;gap:8px;align-items:center">${icon('bolt', 'style="color:#10B981"')}<b>API quota</b><span class="grow"></span><span class="muted">${Math.round(100 - used / 100)}% left</span></div><div class="bar"><i style="width:${100 - used / 100}%;background:#10B981"></i></div>`;
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
      try { await loadAccount(k); } catch (e) { $('#errors').innerHTML += `<div class="err" role="alert">Account info failed to load: ${esc(e.message)}</div>`; }
      if (S.page === page) setView(PAGES[page]());
    }
    if ($('#dlList')) pollDownloads();
    return;
  }
  if (page === 'manager' && !S.health) {
    try { await loadManager(false); } catch (e) { S.health = {}; $('#errors').innerHTML += `<div class="err" role="alert">Sign-in status failed to load: ${esc(e.message)}</div>`; }
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
    catch (err) { alert(`Could not open in ${chTitle(ds.ch)}'s Chrome: ${err.message}`); }
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
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Checking…`;
    try { await loadManager(true); } catch (err) { alert('Check failed: ' + err.message); }
    return render();
  }
  if (ds.launch) {
    if (t.getAttribute('aria-disabled') === 'true') return alert('The selected Chrome profile no longer exists; pick another one.');
    try { await postJson('launch', { ch: ds.launch }); } catch (err) { return alert('Could not open Studio: ' + err.message); }
    setTimeout(() => api('chrome-profiles').then(p => { S.sessions = p.sessions || {}; if (S.page === 'manager') render(); }).catch(() => {}), 4000);
    return;
  }
  if (ds.authCancel) {
    try { const st = await postJson('auth-cancel', { ch: ds.authCancel }); S.auth = { ...(S.auth || {}), [ds.authCancel]: st }; render(); }
    catch (err) { alert('Could not cancel: ' + err.message); }
    return;
  }
  if (ds.auth) {
    if (t.getAttribute('aria-disabled') === 'true') return;
    try { const st = await postJson('auth', { ch: ds.auth }); S.auth = { ...(S.auth || {}), [ds.auth]: st }; pollAuth(); render(); }
    catch (err) { alert('Could not start sign-in: ' + err.message); }
    return;
  }
  if (ds.forget) {
    if (!confirm(`Delete the saved Google sign-in for ${chTitle(ds.forget)}?\n\nClose this channel's Chrome window first. Afterwards, Open Studio asks you to sign in again.`)) return;
    try { await postJson('forget-session', { ch: ds.forget }); const p = await api('chrome-profiles'); S.sessions = p.sessions || {}; render(); }
    catch (err) { alert('Failed: ' + err.message); }
    return;
  }
  if (ds.reply) {
    const box = $('#rb-' + CSS.escape(ds.reply)), opening = !box.innerHTML;
    t.setAttribute('aria-expanded', String(opening));
    box.innerHTML = opening ? `<label class="sr-only" for="rt-${esc(ds.reply)}">Reply</label><textarea id="rt-${esc(ds.reply)}" placeholder="Write a reply as ${esc(chTitle(ds.ch))}…"></textarea><div style="margin-top:6px;display:flex;gap:8px"><button class="btn primary" data-send="${esc(ds.reply)}" data-ch="${ds.ch}">${icon('send')}Send reply</button></div>` : '';
    if (opening) box.querySelector('textarea').focus();
    return;
  }
  if (ds.send) {
    const text = $('#rt-' + CSS.escape(ds.send)).value.trim(); if (!text) return;
    if (!confirm(`This reply will appear PUBLICLY on YouTube as ${chTitle(ds.ch)}:\n\n"${text}"\n\nSend it now?`)) return;
    t.setAttribute('aria-disabled', 'true'); t.innerHTML = `${icon('progress_activity', 'class="ms spin"')}Sending…`;
    try {
      await api('reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': window.API_TOKEN }, body: JSON.stringify({ ch: ds.ch, comment_id: ds.send, text }) });
      delete S.data[ds.ch].comments; S.quota = await api('quota'); render();
    } catch (err) { alert('Could not send: ' + err.message); t.removeAttribute('aria-disabled'); t.innerHTML = `${icon('send')}Send reply`; }
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
  } catch (err) { alert('Could not save the profile: ' + err.message); render(); }
});
$('#drawerBg').onclick = closeDrawer;
$('#menuBtn').onclick = () => { const o = $('#rail').classList.toggle('open'); $('#menuBtn').setAttribute('aria-expanded', String(o)); };
$('#syncBtn').onclick = async () => { const b = $('#syncBtn'); b.setAttribute('aria-disabled', 'true'); S.meta = await api('meta'); if (S.page === 'manager') await loadManager(true).catch(() => {}); await loadCore(true); await render(); b.removeAttribute('aria-disabled'); };
window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (PAGES[p] && p !== S.page) go(p); });

(async () => {
  S.page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  try { S.meta = await api('meta'); } catch (e) { $('#view').innerHTML = `<div class="err">The server is not responding: ${esc(e.message)}</div>`; return; }
  render();
  await loadCore(false); await render();
  setInterval(async () => { S.quota = await api('quota').catch(() => S.quota); renderRail(); }, 60000);
})();
