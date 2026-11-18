/* Radiobox — a vintage-style internet radio.
 * Stations come from the community Radio Browser directory
 * (https://www.radio-browser.info, server source: github.com/segler-alex/radiobrowser-api-rust).
 * No build step: open Radio.html in a browser. */
'use strict';

// ---------- tunables ----------
const API_HOSTS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'fi1.api.radio-browser.info',
  'all.api.radio-browser.info',
];
const BANDS = {
  CN: { label: '中国 · CHINA', short: '中国' },
  TW: { label: '台灣 · TAIWAN', short: '台灣' },
  HK: { label: '香港 · HONG KONG', short: '香港' },
  US: { label: '美国 · USA', short: 'USA' },
  SG: { label: '新加坡 · SINGAPORE', short: '新加坡' },
};
const SKINS = ['walnut', 'mint', 'hifi', 'night'];
const ICY_REFRESH_MS = 30000; // how often to re-read the live programme title
const ICY_TIMEOUT_MS = 10000;
const REPORT_CLICKS = false; // true: tell the directory which station was played (it uses this for popularity)
const APP_ICON = 'icons/radio-512.png';
const F_MIN = 87.0;          // left edge of the dial (MHz, decorative)
const F_MAX = 109.0;         // right edge of the dial
const SLOT_START = 88.0;     // first station slot
const SLOT_STEP = 0.5;       // spacing between station slots
const MAX_STATIONS = 41;     // 88.0 … 108.0
const FETCH_LIMIT = 150;     // candidates fetched per band before filtering
const LOCK = 0.14;           // how close (MHz) the needle must be to receive a station
const TUNE_DELAY = 450;      // ms the needle must rest before a stream is opened
const STALL_MS = 12000;      // give up on a stream that hasn't started by then
const DEG_PER_MHZ = 36;      // tuning-knob rotation per MHz
const STATIC_LEVEL = 0.22;   // loudness of between-station hiss
const STORE_KEY = 'radioboxState';
const FAV_KEY = 'radioboxFavs';  // favourites: [{id, band, name, url, …}] in play order
const FAV_FIELDS = ['id', 'name', 'url', 'hls', 'tags', 'language', 'place', 'codec', 'bitrate', 'homepage', 'logo'];

// ---------- state ----------
let power = false;
let band = 'CN';
let freq = 88.0;
let volume = 0.7;
let skin = 'walnut';
let nowTitle = '';           // live programme / song title, when the station publishes one
let icyTimer = 0;
let icyAbort = null;
let infoKey = null;
let stations = [];           // stations on the current band, each with .freq
let current = null;          // station the needle is locked on (may still be loading)
let playing = false;         // audio is actually coming out
let bandLoading = false;
let tuneTimer = 0;
let stallTimer = 0;
let hls = null;
let apiHost = null;
let lastFavId = null;        // favourite most recently tuned, so skipping continues from it even if it failed
let tuneNow = false;         // true while handling a car / lock-screen button: start audio immediately
let favs = [];
const bandCache = {};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const radio = $('radio');
const audio = $('audio');
const dial = $('dial');
const needle = $('needle');
const marksEl = $('marks');
const eye = $('eye');
const freqEl = $('freq');
const stationEl = $('station');
const statusEl = $('status');
const tuneKnob = $('tuneKnob');
const volKnob = $('volKnob');
const powerBtn = $('power');
const logList = $('logList');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (f) => ((f - F_MIN) / (F_MAX - F_MIN)) * 100;

// ---------- persistence ----------
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (BANDS[s.band]) band = s.band;
    if (typeof s.freq === 'number') freq = clamp(s.freq, F_MIN, F_MAX);
    if (typeof s.volume === 'number') volume = clamp(s.volume, 0, 1);
    if (SKINS.includes(s.skin)) skin = s.skin;
  } catch (e) { /* storage unavailable — defaults are fine */ }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ band, freq, volume, skin })); } catch (e) {}
}
function loadFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(a)) {
      favs = a.filter((f) => f && typeof f.id === 'string' && BANDS[f.band] &&
        typeof f.name === 'string' && typeof f.url === 'string' && /^https?:\/\//i.test(f.url));
    }
  } catch (e) { favs = []; }
}
function saveFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) {}
}

// ---------- station directory ----------
async function apiGet(path) {
  const hosts = apiHost ? [apiHost, ...API_HOSTS.filter((h) => h !== apiHost)] : API_HOSTS;
  let lastErr;
  for (const host of hosts) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(`https://${host}${path}`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      apiHost = host;
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchBand(cc) {
  if (bandCache[cc]) return bandCache[cc];
  const raw = await apiGet(
    `/json/stations/search?countrycode=${cc}&hidebroken=true&order=clickcount&reverse=true&limit=${FETCH_LIMIT}`
  );
  const secureOnly = location.protocol === 'https:';   // http streams are blocked on https pages
  const seenUrl = new Set();
  const seenName = new Set();
  const picked = [];
  for (const s of raw) {
    const url = (s.url_resolved || s.url || '').trim();
    const name = (s.name || '').trim();
    if (!/^https?:\/\//i.test(url) || !name) continue;
    if (secureOnly && !/^https:/i.test(url)) continue;
    const key = name.toLowerCase().replace(/\s+/g, '');
    if (seenUrl.has(url) || seenName.has(key)) continue;
    seenUrl.add(url);
    seenName.add(key);
    picked.push({
      id: s.stationuuid,
      name,
      url,
      hls: s.hls === 1 || /\.m3u8(\?|$)/i.test(url),
      dead: false,
      tags: (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6),
      language: (s.language || '').trim(),
      place: [s.state, s.country].map((x) => (x || '').trim()).filter(Boolean).join(', '),
      codec: s.codec && s.codec !== 'UNKNOWN' ? s.codec : '',
      bitrate: s.bitrate || 0,
      homepage: /^https?:\/\//i.test(s.homepage || '') ? s.homepage.trim() : '',
      logo: /^https:\/\//i.test(s.favicon || '') ? s.favicon.trim() : '',
    });
    if (picked.length >= MAX_STATIONS) break;
  }
  // Favourites of this band always get a dial slot, replacing the least popular stations if needed.
  const missing = favs.filter((f) => f.band === cc && !picked.some((p) => p.id === f.id));
  const favIds = new Set(favs.map((f) => f.id));
  while (missing.length && picked.length + missing.length > MAX_STATIONS) {
    let k = picked.length - 1;
    while (k >= 0 && favIds.has(picked[k].id)) k--;
    if (k < 0) break;
    picked.splice(k, 1);
  }
  for (const f of missing) picked.push(stationFromFav(f));
  // Stable, popularity-independent order so a station tends to keep its dial position.
  picked.sort((a, b) => (a.id < b.id ? -1 : 1));
  picked.forEach((s, i) => { s.freq = SLOT_START + i * SLOT_STEP; });
  bandCache[cc] = picked;
  return picked;
}

function showBand() {
  document.querySelectorAll('.key[data-band]').forEach((b) => b.classList.toggle('active', b.dataset.band === band));
  $('bandName').textContent = BANDS[band].label;
}

/** Switch band synchronously when its station list is already loaded (needed for car buttons,
 *  where audio must start inside the button handler). Returns false if the list isn't loaded. */
function switchBandNow(cc) {
  if (cc === band && stations.length) return true;
  const list = bandCache[cc];
  if (!list) return false;
  stopStream();
  band = cc;
  stations = list;
  bandLoading = false;
  showBand();
  renderMarks();
  applyTuning();
  saveState();
  return true;
}

async function setBand(cc) {
  band = cc;
  stopStream();
  stations = [];
  bandLoading = true;
  showBand();
  renderMarks();
  applyTuning();
  saveState();
  try {
    const list = await fetchBand(cc);
    if (band !== cc) return;               // user switched again while loading
    stations = list;
    bandLoading = false;
  } catch (e) {
    if (band !== cc) return;
    bandLoading = false;
    stations = [];
    setStatus('—', 'DIRECTORY UNREACHABLE · 无法连接电台目录');
  }
  renderMarks();
  applyTuning();
}

// ---------- dial rendering ----------
function renderScale() {
  // Built with DOM calls (no HTML strings) so the page's content policy can forbid inline styles.
  const scale = $('scale');
  scale.textContent = '';
  const add = (cls, f, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.left = pct(f) + '%';
    if (text) el.textContent = text;
    scale.append(el);
  };
  for (let f = 88; f <= 108 + 1e-9; f += 0.5) {
    const major = Math.abs(f % 2) < 1e-9;
    add(major ? 'tick major' : 'tick', f);
    if (major) add((f - 88) % 4 ? 'num alt' : 'num', f, String(f));   // .alt labels are hidden on phones
  }
}

function renderMarks() {
  marksEl.textContent = '';
  for (const s of stations) {
    const m = document.createElement('span');
    m.className = 'mark';
    m.dataset.id = s.id;
    m.style.left = pct(s.freq) + '%';
    marksEl.append(m);
  }
  logList.innerHTML = '';
  for (const s of stations) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    const btn = document.createElement('button');
    const b = document.createElement('b');
    b.textContent = s.freq.toFixed(1);
    const span = document.createElement('span');
    span.textContent = s.name;
    btn.append(b, span);
    btn.addEventListener('click', () => { if (!power) setPower(true); setFreq(s.freq); });
    const star = document.createElement('button');
    star.className = 'star-btn';
    star.addEventListener('click', () => toggleFav(s));
    li.append(btn, star);
    logList.append(li);
  }
  $('logCount').textContent = stations.length ? `(${stations.length})` : '';
  refreshMarks();
}

function refreshMarks() {
  const mark = (el) => {
    const s = stations.find((x) => x.id === el.dataset.id);
    if (!s) return;
    const fav = favIndex(s.id) >= 0;
    el.classList.toggle('dead', s.dead);
    el.classList.toggle('current', power && current === s);
    el.classList.toggle('fav', fav);
    const star = el.querySelector('.star-btn');
    if (star) {
      star.textContent = fav ? '★' : '☆';
      star.setAttribute('aria-pressed', String(fav));
      star.setAttribute('aria-label', (fav ? 'Remove from favourites: ' : 'Add to favourites: ') + s.name);
    }
  };
  marksEl.querySelectorAll('.mark').forEach(mark);
  logList.querySelectorAll('li').forEach(mark);
  favList.querySelectorAll('li').forEach((li) => {
    const f = favs[favIndex(li.dataset.id)];
    const st = f && stationFor(f);
    li.classList.toggle('current', !!(power && current && current.id === li.dataset.id));
    li.classList.toggle('dead', !!(st && st.dead));
  });
}

function setStatus(name, status) {
  stationEl.textContent = name;
  statusEl.textContent = status;
}

// ---------- static hiss (Web Audio) ----------
let actx = null;
let staticGain = null;
function ensureStatic() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  actx = new AC();
  const len = actx.sampleRate * 2;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filter = actx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2400;
  filter.Q.value = 0.4;
  staticGain = actx.createGain();
  staticGain.gain.value = 0;
  src.connect(filter).connect(staticGain).connect(actx.destination);
  src.start();
}

// ---------- tuning ----------
function nearest(f, skipDead) {
  let best = null;
  let bd = Infinity;
  for (const s of stations) {
    if (skipDead && s.dead) continue;
    const d = Math.abs(s.freq - f);
    if (d < bd) { bd = d; best = s; }
  }
  return { s: best, d: bd };
}

function setFreq(f) {
  freq = clamp(Math.round(f * 100) / 100, F_MIN, F_MAX);
  applyTuning();
  saveState();
}

/** Recompute everything that depends on needle position / power / station list. */
function applyTuning() {
  needle.style.left = pct(freq) + '%';
  freqEl.textContent = freq.toFixed(2);
  tuneKnob.style.setProperty('--rot', ((freq - F_MIN) * DEG_PER_MHZ) + 'deg');
  tuneKnob.setAttribute('aria-valuenow', freq.toFixed(2));
  volKnob.style.setProperty('--rot', (-135 + 270 * volume) + 'deg');
  volKnob.setAttribute('aria-valuenow', Math.round(volume * 100));

  let signal = 0;
  if (!power) {
    setStatus('—', 'OFF · 关机');
  } else if (bandLoading) {
    setStatus('…', 'SCANNING BAND · 搜台中');
  } else if (stations.length) {
    const { s, d } = nearest(freq, false);
    const inRange = s && d <= LOCK;
    if (inRange && !s.dead) {
      signal = 1 - (d / LOCK) * 0.6;
      if (current !== s) {
        stopStream();
        current = s;
        if (tuneNow) startStream(s);                // car button: play() must run inside the handler
        else tuneTimer = setTimeout(() => startStream(s), TUNE_DELAY);
      }
      setStatus(s.name, playing ? 'ON AIR · 播放中' : 'TUNING · 调谐中…');
    } else {
      if (current) stopStream();
      if (inRange) setStatus(s.name, 'NO SIGNAL · 无信号');
      else setStatus('—', 'STATIC · 无电台');
    }
  }

  // Levels: programme audio fades in as the needle centres; hiss fills the rest.
  const heard = playing ? signal : 0;
  audio.volume = clamp(volume * (0.4 + 0.6 * heard), 0, 1);
  if (staticGain) {
    const target = power ? volume * STATIC_LEVEL * (1 - heard) : 0;
    staticGain.gain.setTargetAtTime(target, actx.currentTime, 0.05);
  }
  eye.style.setProperty('--gap', (150 - 140 * heard) + 'deg');
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = power ? 'playing' : 'paused'; } catch (e) {}
  }
  refreshMarks();
  renderInfo();
}

/** The station the needle is close enough to receive, if any. */
function tunedStation() {
  if (!stations.length) return null;
  const { s, d } = nearest(freq, false);
  return d <= LOCK ? s : null;
}

// ---------- programme info ----------
/** Fill the programme card for the station under the needle (cheap no-op when nothing changed). */
function renderInfo() {
  const s = power ? tunedStation() : null;
  const fi = s ? favIndex(s.id) : -1;
  favBtn.disabled = !s;
  favBtn.textContent = fi >= 0 ? '★' : '☆';
  favBtn.setAttribute('aria-pressed', String(fi >= 0));
  favBtn.setAttribute('aria-label', fi >= 0 ? 'Remove from favourites' : 'Add to favourites');
  const key = [s ? s.id : '', nowTitle, playing, s && s.dead, power, fi, favs.length].join('|');
  if (key === infoKey) return;
  infoKey = key;
  updateMediaSession();

  const title = $('infoTitle');
  const meta = $('infoMeta');
  const logo = $('infoLogo');
  meta.textContent = '';
  if (!s) {
    logo.hidden = true;
    title.className = 'info-title muted';
    title.textContent = 'Tune to a station to see what is on · 调到电台后显示节目信息';
    return;
  }
  if (nowTitle) {
    title.className = 'info-title';
    title.textContent = '♪ ' + nowTitle;
  } else {
    title.className = 'info-title muted';
    title.textContent = s.dead ? 'Station is not answering · 电台无响应'
      : playing ? 'Live broadcast — this station does not publish programme titles · 直播中（该台未提供节目名称）'
      : 'Tuning… · 调谐中';
  }
  const row = (label, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    meta.append(dt, dd);
  };
  row('Station 电台', s.name);
  row('Genre 类型', s.tags.join(' · '));
  row('Language 语言', s.language);
  row('Location 地区', s.place);
  row('Quality 音质', [s.codec, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · '));
  if (s.homepage) {
    const a = document.createElement('a');
    a.href = s.homepage;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.homepage.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    row('Website 网站', a);
  }
  if (s.logo) {
    if (logo.getAttribute('src') !== s.logo) logo.src = s.logo;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }
}
$('infoLogo').addEventListener('error', (e) => { e.target.hidden = true; });

function setNowTitle(s, text) {
  if (current !== s) return;
  const clean = (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (clean === nowTitle) return;
  nowTitle = clean;
  renderInfo();
}

/** Read one in-stream (ICY) metadata block and return its StreamTitle.
 *  Only works for stations whose server allows it cross-origin; throws otherwise. */
async function readIcyTitle(url, signal) {
  const res = await fetch(url, { headers: { 'Icy-MetaData': '1' }, cache: 'no-store', signal });
  const metaint = parseInt(res.headers.get('icy-metaint'), 10);
  if (!res.ok || !res.body || !(metaint > 0)) throw new Error('no icy metadata');
  const reader = res.body.getReader();
  let toSkip = metaint;      // audio bytes left before the next metadata block
  let metaLen = -1;          // -1: expecting the length byte
  let meta = [];
  let blocks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended');
    let i = 0;
    while (i < value.length) {
      if (toSkip > 0) {
        const n = Math.min(toSkip, value.length - i);
        toSkip -= n; i += n;
      } else if (metaLen < 0) {
        metaLen = value[i++] * 16;
        meta = [];
        if (metaLen === 0) {                       // empty block — title unchanged since connect
          if (++blocks >= 3) return '';
          metaLen = -1; toSkip = metaint;
        }
      } else {
        const n = Math.min(metaLen - meta.length, value.length - i);
        for (let k = 0; k < n; k++) meta.push(value[i + k]);
        i += n;
        if (meta.length >= metaLen) {
          const text = new TextDecoder('utf-8').decode(new Uint8Array(meta));
          const m = /StreamTitle='([\s\S]*?)';/.exec(text);
          return m ? m[1] : '';
        }
      }
    }
  }
}

function pollIcy(s) {
  clearTimeout(icyTimer);
  if (current !== s || !playing || s.icy === false) return;
  const ctl = new AbortController();
  icyAbort = ctl;
  const timeout = setTimeout(() => ctl.abort(), ICY_TIMEOUT_MS);
  readIcyTitle(s.url, ctl.signal)
    .then((title) => {
      s.icy = true;
      setNowTitle(s, title);
      if (current === s) icyTimer = setTimeout(() => pollIcy(s), ICY_REFRESH_MS);
    })
    .catch(() => { if (!ctl.signal.aborted || current === s) s.icy = s.icy === true; })
    .finally(() => { clearTimeout(timeout); ctl.abort(); });
}

/** Pull a title (TIT2 frame) out of the timed ID3 tags that HLS streams carry. */
function id3Title(bytes) {
  for (let i = 0; i + 11 < bytes.length; i++) {
    if (bytes[i] !== 0x54 || bytes[i + 1] !== 0x49 || bytes[i + 2] !== 0x54 || bytes[i + 3] !== 0x32) continue;
    const size = (bytes[i + 4] << 21) | (bytes[i + 5] << 14) | (bytes[i + 6] << 7) | bytes[i + 7];
    const enc = bytes[i + 10];
    const body = bytes.subarray(i + 11, Math.min(bytes.length, i + 10 + size));
    const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'iso-8859-1';
    try { return new TextDecoder(label).decode(body).replace(/\0/g, ''); } catch (e) { return ''; }
  }
  return '';
}

function stopStream() {
  clearTimeout(tuneTimer);
  clearTimeout(stallTimer);
  clearTimeout(icyTimer);
  if (icyAbort) { icyAbort.abort(); icyAbort = null; }
  if (hls) { hls.destroy(); hls = null; }
  current = null;
  playing = false;
  nowTitle = '';
  audio.pause();
  if (audio.hasAttribute('src')) { audio.removeAttribute('src'); audio.load(); }
}

function startStream(s) {
  if (!power || current !== s) return;
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => failStream(s), STALL_MS);
  const nativeHls = audio.canPlayType('application/vnd.apple.mpegurl');
  if (s.hls && !nativeHls && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true });
    hls.on(window.Hls.Events.ERROR, (evt, data) => { if (data.fatal) failStream(s); });
    hls.on(window.Hls.Events.FRAG_PARSING_METADATA, (evt, data) => {
      for (const sample of data.samples || []) {
        const title = id3Title(sample.data);
        if (title) setNowTitle(s, title);
      }
    });
    hls.loadSource(s.url);
    hls.attachMedia(audio);
  } else {
    audio.src = s.url;
  }
  const p = audio.play();
  if (p && p.catch) {
    p.catch((err) => {
      if (err && err.name === 'AbortError') return;   // superseded by a newer tune
      failStream(s);
    });
  }
}

function failStream(s) {
  if (current !== s) return;
  s.dead = true;
  stopStream();
  applyTuning();
}

audio.addEventListener('playing', () => {
  if (!current) return;
  clearTimeout(stallTimer);
  if (!playing) {
    playing = true;
    // Courtesy click-count for the directory (it asks players to report plays).
    if (REPORT_CLICKS && apiHost) fetch(`https://${apiHost}/json/url/${encodeURIComponent(current.id)}`).catch(() => {});
    if (!current.hls) pollIcy(current);
  }
  applyTuning();
});
audio.addEventListener('error', () => {
  if (current && audio.hasAttribute('src')) failStream(current);
});
audio.addEventListener('ended', () => { if (current) failStream(current); });

/** Jump to the next live station above (dir = 1) or below (dir = -1) the needle. */
function seek(dir) {
  if (!power) setPower(true);
  const live = stations.filter((s) => !s.dead);
  if (!live.length) return;
  const eps = 0.01;
  let target = dir > 0
    ? live.find((s) => s.freq > freq + eps)
    : [...live].reverse().find((s) => s.freq < freq - eps);
  if (!target) target = dir > 0 ? live[0] : live[live.length - 1];   // wrap around the band
  setFreq(target.freq);
}

/** After a manual turn, settle onto a station if the needle is already inside its lock range. */
function snap() {
  const { s, d } = nearest(freq, true);
  if (s && d <= LOCK && d > 0) setFreq(s.freq);
}

// ---------- power ----------
function setPower(on) {
  power = on;
  radio.classList.toggle('on', on);
  powerBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    ensureStatic();
    if (!stations.length && !bandLoading) setBand(band);
  } else {
    stopStream();
  }
  applyTuning();
}

// ---------- lock screen / headphone controls ----------
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  const s = current;
  if (!s) { navigator.mediaSession.metadata = null; return; }
  const fi = favIndex(s.id);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: nowTitle || s.name,
    artist: (nowTitle ? s.name : BANDS[band].label) + (fi >= 0 ? ` · ★ ${fi + 1}/${favs.length}` : ''),
    album: 'Radiobox',
    artwork: [{ src: s.logo || APP_ICON }],
  });
}
if ('mediaSession' in navigator) {
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {} };
  on('play', () => { tuneNow = true; try { setPower(true); } finally { tuneNow = false; } });
  on('pause', () => setPower(false));
  on('stop', () => setPower(false));
  // CarPlay and the lock screen show either skip-track or ±10 s buttons depending on the
  // device; for a live radio both mean "change station".
  on('nexttrack', () => remoteSkip(1));
  on('previoustrack', () => remoteSkip(-1));
  on('seekforward', () => remoteSkip(1));
  on('seekbackward', () => remoteSkip(-1));
  on('seekto', null);
}

// ---------- favourites ----------
const favList = $('favList');
const favBtn = $('favBtn');
const favIndex = (id) => favs.findIndex((f) => f.id === id);
const stationFor = (f) => (bandCache[f.band] || []).find((s) => s.id === f.id) || null;

function stationFromFav(f) {
  const s = { dead: false };
  for (const k of FAV_FIELDS) s[k] = f[k];
  s.tags = Array.isArray(f.tags) ? f.tags : [];
  return s;
}

function toggleFav(s) {
  if (!s) return;
  const i = favIndex(s.id);
  if (i >= 0) {
    favs.splice(i, 1);
  } else {
    const f = { band };
    for (const k of FAV_FIELDS) f[k] = s[k];
    favs.push(f);
  }
  saveFavs();
  renderFavs();
}

function moveFav(i, d) {
  const j = i + d;
  if (j < 0 || j >= favs.length) return;
  [favs[i], favs[j]] = [favs[j], favs[i]];
  saveFavs();
  renderFavs();
}

function renderFavs() {
  favList.textContent = '';
  $('favCount').textContent = favs.length ? `(${favs.length})` : '';
  $('favEmpty').hidden = favs.length > 0;
  favs.forEach((f, i) => {
    const li = document.createElement('li');
    li.dataset.id = f.id;
    const play = document.createElement('button');
    play.className = 'fav-play';
    const n = document.createElement('b');
    n.textContent = String(i + 1);
    const name = document.createElement('span');
    name.textContent = f.name;
    const tag = document.createElement('small');
    tag.textContent = BANDS[f.band].short;
    play.append(n, name, tag);
    play.addEventListener('click', () => playFav(f, false));
    const tool = (label, text, fn, disabled) => {
      const b = document.createElement('button');
      b.className = 'fav-tool';
      b.textContent = text;
      b.setAttribute('aria-label', label + ': ' + f.name);
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      return b;
    };
    li.append(
      play,
      tool('Move up', '▲', () => moveFav(i, -1), i === 0),
      tool('Move down', '▼', () => moveFav(i, 1), i === favs.length - 1),
      tool('Remove', '✕', () => toggleFav(f)),
    );
    favList.append(li);
  });
  infoKey = null;
  refreshMarks();
  renderInfo();
}

/** Tune to a favourite, switching band if needed. instant = called from a car / lock-screen button. */
async function playFav(f, instant) {
  if (!switchBandNow(f.band)) {
    await setBand(f.band);
    if (band !== f.band) return;
  }
  const st = stations.find((s) => s.id === f.id);
  if (!st) return;
  lastFavId = f.id;
  tuneNow = instant;
  try {
    if (!power) {
      setFreq(st.freq);
      setPower(true);
    } else {
      if (instant && current === st && !playing) stopStream();   // restart a stalled tune right now
      setFreq(st.freq);
    }
  } finally {
    tuneNow = false;
  }
}

/** Car / lock-screen skip: cycle favourites when there are any, otherwise the current band. */
function remoteSkip(dir) {
  if (!favs.length) {
    tuneNow = true;
    try { seek(dir); } finally { tuneNow = false; }
    return;
  }
  let i = favIndex(current ? current.id : lastFavId);
  for (let k = 0; k < favs.length; k++) {
    i = i < 0 ? (dir > 0 ? 0 : favs.length - 1) : (i + dir + favs.length) % favs.length;
    const st = stationFor(favs[i]);
    if (st && st.dead) continue;
    playFav(favs[i], true);
    return;
  }
}

favBtn.addEventListener('click', () => toggleFav(power ? tunedStation() : null));

// ---------- cabinet look ----------
function setSkin(name) {
  skin = SKINS.includes(name) ? name : SKINS[0];
  radio.dataset.skin = skin;
  document.querySelectorAll('.skin').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.skin === skin)));
  saveState();
}
document.querySelectorAll('.skin').forEach((b) => b.addEventListener('click', () => setSkin(b.dataset.skin)));

// ---------- controls ----------
function makeKnob(el, onTurn, onEnd) {
  let last = null;
  const angle = (e) => {
    const r = el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    last = angle(e);
    el.focus();
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (last === null) return;
    const a = angle(e);
    let d = a - last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    last = a;
    onTurn(d);
  });
  const end = () => { if (last !== null) { last = null; if (onEnd) onEnd(); } };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  let wheelTimer = 0;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    onTurn(-Math.sign(e.deltaY) * 5);
    clearTimeout(wheelTimer);
    if (onEnd) wheelTimer = setTimeout(onEnd, 300);
  }, { passive: false });
}

function setVolume(v) {
  volume = clamp(v, 0, 1);
  applyTuning();
  saveState();
}

makeKnob(tuneKnob, (deg) => setFreq(freq + deg / DEG_PER_MHZ), snap);
makeKnob(volKnob, (deg) => setVolume(volume + deg / 270));

// Drag or click directly on the dial glass.
let dialDrag = false;
const dialFreq = (e) => {
  const r = dial.getBoundingClientRect();
  return F_MIN + clamp((e.clientX - r.left) / r.width, 0, 1) * (F_MAX - F_MIN);
};
dial.addEventListener('pointerdown', (e) => {
  dial.setPointerCapture(e.pointerId);
  dialDrag = true;
  setFreq(dialFreq(e));
});
dial.addEventListener('pointermove', (e) => { if (dialDrag) setFreq(dialFreq(e)); });
const dialEnd = () => { if (dialDrag) { dialDrag = false; snap(); } };
dial.addEventListener('pointerup', dialEnd);
dial.addEventListener('pointercancel', dialEnd);

powerBtn.addEventListener('click', () => setPower(!power));
$('seekUp').addEventListener('click', () => seek(1));
$('seekDown').addEventListener('click', () => seek(-1));
document.querySelectorAll('.key[data-band]').forEach((b) => {
  b.addEventListener('click', () => { if (b.dataset.band !== band || !stations.length) setBand(b.dataset.band); });
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const onButton = e.target instanceof HTMLButtonElement || e.target.tagName === 'SUMMARY';
  switch (e.key) {
    case 'ArrowRight': setFreq(freq + (e.shiftKey ? SLOT_STEP : 0.05)); break;
    case 'ArrowLeft':  setFreq(freq - (e.shiftKey ? SLOT_STEP : 0.05)); break;
    case 'ArrowUp':    setVolume(volume + 0.05); break;
    case 'ArrowDown':  setVolume(volume - 0.05); break;
    case ']': seek(1); break;
    case '[': seek(-1); break;
    case '1': setBand('CN'); break;
    case '2': setBand('TW'); break;
    case '3': setBand('HK'); break;
    case '4': setBand('US'); break;
    case '5': setBand('SG'); break;
    case 'f': case 'F': toggleFav(power ? tunedStation() : null); break;
    case ' ':
      if (onButton) return;            // let Space activate the focused button
      setPower(!power);
      break;
    default: return;
  }
  e.preventDefault();
});

// ---------- boot ----------
loadState();
loadFavs();
setSkin(skin);
renderScale();
renderFavs();
setBand(band);       // pre-load the station list so the dial is populated before power-on
// Pre-load every band that holds a favourite, so car buttons can jump between regions instantly.
for (const cc of new Set(favs.map((f) => f.band))) if (cc !== band) fetchBand(cc).catch(() => {});
