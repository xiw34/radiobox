/* Radiobox tape deck — LibriVox audiobooks (public domain, read by volunteers).
 * LibriVox's own catalogue API doesn't allow web pages to read it, so books are found and
 * played through the Internet Archive, which hosts every LibriVox recording
 * (collection "librivoxaudio") and does allow it.
 * Loaded after radio.js and shares its globals ($, mode, power, volume, setPower, …). */
'use strict';

// ---------- tunables ----------
const IA = 'https://archive.org';
const TAPE_KEY = 'radioboxTape';
const TAPE_SKIP_S = 10;               // ±seconds for the skip buttons (car shows "10")
const TAPE_SAVE_MS = 5000;            // how often the listening position is saved while playing
const TAPE_RESTART_S = 5;             // "previous" restarts the chapter when past this point
const TAPE_SPEEDS = [1, 1.25, 1.5, 0.75];
const LIB_ROWS = { zh: 100, en: 60 };
const LIB_QUERY = {
  zh: 'collection:librivoxaudio AND language:(zho OR chi OR Chinese)',
  en: 'collection:librivoxaudio AND language:(eng OR English)',
};

// ---------- state ----------
const tape = $('tapeAudio');
let book = null;          // {id, title, creator, desc, chapters: [{title, url, dur}]}
let chapter = 0;
let pendingSeek = 0;      // position to jump to once the chapter's audio is loaded
let tapeMsg = '';
let libTab = null;
let libSearchTerm = '';
let lastSave = 0;
let lastPos = 0;
let tapeMetaKey = null;
let speedIdx = 0;
const libCache = {};
let store = { mode: 'radio', last: null, books: {} };   // books[id] = {title, creator, chapter, time, chapters, updated, done}

// ---------- persistence ----------
function loadTapeStore() {
  try {
    const s = JSON.parse(localStorage.getItem(TAPE_KEY) || '{}');
    if (s && typeof s === 'object') {
      store.mode = s.mode === 'tape' ? 'tape' : 'radio';
      store.last = typeof s.last === 'string' ? s.last : null;
      store.books = s.books && typeof s.books === 'object' ? s.books : {};
      speedIdx = TAPE_SPEEDS.indexOf(s.speed) >= 0 ? TAPE_SPEEDS.indexOf(s.speed) : 0;
    }
  } catch (e) { /* defaults */ }
}
function saveTapeStore() {
  try { localStorage.setItem(TAPE_KEY, JSON.stringify({ ...store, speed: TAPE_SPEEDS[speedIdx] })); } catch (e) {}
}
function savePosition(force) {
  if (!book) return;
  const now = Date.now();
  if (!force && now - lastSave < TAPE_SAVE_MS) return;
  lastSave = now;
  const prev = store.books[book.id] || {};
  store.books[book.id] = {
    title: book.title,
    creator: book.creator,
    chapter,
    time: Math.floor(pendingSeek || tape.currentTime || 0),
    chapters: book.chapters.length,
    updated: now,
    done: prev.done && chapter === 0 && !tape.currentTime ? true : false,
  };
  store.last = book.id;
  saveTapeStore();
}

// ---------- helpers ----------
const first = (v) => (Array.isArray(v) ? v[0] : v);
const asText = (v) => String(first(v) || '').replace(/\s+/g, ' ').trim();

function htmlToText(html) {
  // DOMParser builds an inert document (no scripts run, nothing loads); we only read its text.
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseDur(v) {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((t, p) => t * 60 + (parseFloat(p) || 0), 0);
  return parseFloat(s) || 0;
}

function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

async function iaJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const coverUrl = (id) => `${IA}/services/img/${encodeURIComponent(id)}`;
const fileUrl = (id, name) => `${IA}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;

// ---------- catalogue ----------
async function searchBooks(tab, term) {
  let q = LIB_QUERY[tab];
  const clean = (term || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
  if (clean) q += ` AND (title:(${clean}) OR creator:(${clean}))`;
  const params = new URLSearchParams({ q, rows: String(LIB_ROWS[tab]), output: 'json' });
  for (const f of ['identifier', 'title', 'creator']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const d = await iaJSON(`${IA}/advancedsearch.php?${params}`);
  return (d.response && d.response.docs || [])
    .filter((x) => typeof x.identifier === 'string')
    .map((x) => ({ id: x.identifier, title: asText(x.title) || x.identifier, creator: asText(x.creator) }));
}

async function fetchBook(id) {
  const d = await iaJSON(`${IA}/metadata/${encodeURIComponent(id)}`);
  const files = Array.isArray(d.files) ? d.files : [];
  const mp3 = files.filter((f) => typeof f.name === 'string' && /\.mp3$/i.test(f.name));
  const byName = new Map(mp3.map((f) => [f.name, f]));
  let use = mp3.filter((f) => /_64kb\.mp3$/i.test(f.name));          // small files: kind to mobile data
  if (!use.length) use = mp3;
  const chapters = use
    .map((f) => {
      const orig = byName.get(f.name.replace(/_64kb\.mp3$/i, '.mp3')) || f;
      return {
        name: f.name,
        title: asText(orig.title) || asText(f.title) || f.name.replace(/(_64kb)?\.mp3$/i, ''),
        dur: parseDur(f.length) || parseDur(orig.length),
        url: fileUrl(id, f.name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!chapters.length) throw new Error('no audio');
  const m = d.metadata || {};
  return {
    id,
    title: asText(m.title) || id,
    creator: asText(m.creator),
    desc: htmlToText(first(m.description)).slice(0, 600),
    chapters,
  };
}

// ---------- mode switch ----------
function setMode(m) {
  if (m === mode) return;
  if (m === 'tape') {
    stopStream();                       // silence the radio
    mode = 'tape';
    $('bandName').textContent = '磁带 · TAPE';
    $('dialUnit').textContent = 'LibriVox';
    tapeInfoKey = null;
    if (!book && store.last) cueBook(store.last);
  } else {
    tape.pause();
    savePosition(true);
    mode = 'radio';
    showBand();
    $('dialUnit').textContent = 'FM · MHz';
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.setPositionState(); } catch (e) {}
    }
    tapeMetaKey = null;
    infoKey = null;
  }
  document.body.classList.toggle('tape-mode', mode === 'tape');
  modeBtn.textContent = mode === 'tape' ? '📻 RADIO' : '📼 TAPE';
  modeBtn.setAttribute('aria-label', mode === 'tape' ? 'Switch to radio' : 'Switch to tape deck');
  store.mode = mode;
  saveTapeStore();
  if (mode === 'tape') { if (!libTab) showTab(Object.keys(store.books).length ? 'resume' : 'zh'); }
  setPower(power && mode === 'radio');   // radio resumes if it was on; tape waits for ▶
  applyTuning();
}

// ---------- playback ----------
function lightsOn() {
  power = true;
  radio.classList.add('on');
  powerBtn.setAttribute('aria-pressed', 'true');
}

/** Load a chapter into the deck. autoplay must only be true inside a click / car-button handler. */
function playChapter(i, startAt, autoplay) {
  if (!book) return;
  chapter = Math.max(0, Math.min(book.chapters.length - 1, i));
  pendingSeek = startAt || 0;
  tapeMsg = '';
  tape.playbackRate = TAPE_SPEEDS[speedIdx];
  tape.src = book.chapters[chapter].url;
  if (autoplay) {
    lightsOn();
    tape.play().catch(onPlayError);
  }
  savePosition(true);
  renderTape();
  renderChapters();
}

function onPlayError(err) {
  if (err && err.name === 'AbortError') return;
  if (err && err.name === 'NotAllowedError') tapeMsg = 'Press ▶ to start · 请按 ▶ 播放';
  else tapeMsg = 'Could not play this chapter · 无法播放本章';
  renderTape();
}

function tapePlay() {
  if (!book) {
    tapeMsg = 'Choose a book in the Tape library below · 请在下方书库选书';
    lightsOn();
    renderTape();
    return;
  }
  if (!tape.getAttribute('src')) { playChapter(chapter, pendingSeek, true); return; }
  lightsOn();
  tape.playbackRate = TAPE_SPEEDS[speedIdx];
  tape.play().catch(onPlayError);
  renderTape();
}

function tapePause() {
  tape.pause();
  savePosition(true);
  renderTape();
}

function tapeToggle() {
  if (tape.paused) tapePlay(); else tapePause();
}

function tapeSeekTo(t) {
  if (!book) return;
  const dur = tape.duration && isFinite(tape.duration) ? tape.duration : book.chapters[chapter].dur;
  const target = Math.max(0, Math.min((dur || Infinity) - 1, t));
  if (tape.readyState >= 1) tape.currentTime = target; else pendingSeek = target;
  savePosition(true);
  renderTape();
}

function tapeSkip(sec) {
  tapeSeekTo((pendingSeek || tape.currentTime || 0) + sec);
}

function tapeScrub(deg) {
  tapeSeekTo((pendingSeek || tape.currentTime || 0) + deg * 0.5);
}

function tapeChapter(dir) {
  if (!book) return;
  const wasPlaying = !tape.paused;
  if (dir < 0 && (tape.currentTime || 0) > TAPE_RESTART_S) { tapeSeekTo(0); return; }
  const next = chapter + dir;
  if (next < 0 || next >= book.chapters.length) return;
  playChapter(next, 0, wasPlaying || mode === 'tape' && power);
}

function cycleSpeed() {
  speedIdx = (speedIdx + 1) % TAPE_SPEEDS.length;
  tape.playbackRate = TAPE_SPEEDS[speedIdx];
  saveTapeStore();
  renderTape();
}

tape.addEventListener('loadedmetadata', () => {
  if (pendingSeek) {
    try { tape.currentTime = pendingSeek; } catch (e) {}
    pendingSeek = 0;
  }
  tape.playbackRate = TAPE_SPEEDS[speedIdx];
  renderTape();
});
tape.addEventListener('timeupdate', () => {
  if (Math.abs(tape.currentTime - lastPos) < 0.5) return;
  lastPos = tape.currentTime;
  savePosition(false);
  renderTape();
});
['play', 'pause', 'playing', 'waiting', 'ratechange'].forEach((ev) => tape.addEventListener(ev, () => renderTape()));
tape.addEventListener('ended', () => {
  if (book && chapter < book.chapters.length - 1) {
    playChapter(chapter + 1, 0, true);
  } else if (book) {
    savePosition(true);
    store.books[book.id].done = true;
    store.books[book.id].chapter = 0;
    store.books[book.id].time = 0;
    saveTapeStore();
    tapeMsg = 'Finished · 已听完';
    renderTape();
  }
});
tape.addEventListener('error', () => {
  if (!tape.getAttribute('src')) return;
  tapeMsg = 'Could not load this chapter · 本章加载失败';
  renderTape();
});
window.addEventListener('pagehide', () => savePosition(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(true); });

// ---------- opening books ----------
let openToken = 0;
/** Load a book's chapter list and cue it at the saved position (does not start playback). */
async function cueBook(id) {
  const token = ++openToken;
  tapeMsg = 'Loading book… · 正在载入';
  renderTape();
  try {
    const b = await fetchBook(id);
    if (token !== openToken) return;
    if (book && book.id !== b.id) { tape.pause(); savePosition(true); }
    book = b;
    const saved = store.books[id];
    const ch = saved && !saved.done ? Math.min(saved.chapter || 0, b.chapters.length - 1) : 0;
    chapter = ch;
    pendingSeek = saved && !saved.done ? saved.time || 0 : 0;
    tape.removeAttribute('src');
    tape.load();
    tapeMsg = 'Ready — press ▶ · 已就绪，按 ▶ 播放';
    tapeMetaKey = null;
    savePosition(true);
    renderTape();
    renderChapters();
    renderBooks();
  } catch (e) {
    if (token !== openToken) return;
    tapeMsg = 'Could not open this book · 无法打开此书';
    renderTape();
  }
}

// ---------- rendering: cassette display ----------
const modeBtn = $('modeBtn');
const tapePlayBtn = $('tapePlayBtn');

function renderTape() {
  if (mode !== 'tape') return;
  const playingNow = !tape.paused && !tape.ended;
  const ch = book ? book.chapters[chapter] : null;
  const pos = pendingSeek || tape.currentTime || 0;
  const dur = tape.duration && isFinite(tape.duration) ? tape.duration : (ch ? ch.dur : 0);
  const prog = dur ? Math.min(1, pos / dur) : 0;

  $('casLabel').textContent = book ? book.title : 'LibriVox';
  $('reelL').style.setProperty('--wind', String(1 - prog));
  $('reelR').style.setProperty('--wind', String(prog));
  $('tapeBar').style.width = (prog * 100).toFixed(1) + '%';
  radio.classList.toggle('rolling', playingNow);
  eye.style.setProperty('--gap', (playingNow ? 10 : 150) + 'deg');

  freqEl.textContent = fmt(pos);
  if (!power) {
    setStatus(book ? book.title : '—', 'OFF · 关机');
  } else if (!book) {
    setStatus('—', tapeMsg || 'NO TAPE · 请选书');
  } else {
    const where = `${chapter + 1}/${book.chapters.length}`;
    const left = dur ? ' · −' + fmt(dur - pos) : '';
    const state = tapeMsg || (playingNow ? 'PLAYING · 播放中' : 'PAUSED · 暂停');
    setStatus(ch.title, `${state} · ${where}${left}`);
  }
  tuneKnob.style.setProperty('--rot', (prog * 720) + 'deg');
  tapePlayBtn.textContent = playingNow ? '❚❚' : '▶';
  tapePlayBtn.setAttribute('aria-label', playingNow ? 'Pause' : 'Play');
  $('speedBtn').textContent = TAPE_SPEEDS[speedIdx] + '×';
  tape.volume = volume;

  chapterList.querySelectorAll('li').forEach((li, i) => li.classList.toggle('current', i === chapter));
  updateTapeSession(playingNow, pos, dur);
  renderTapeInfo();
}

function updateTapeSession(playingNow, pos, dur) {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try { ms.playbackState = playingNow ? 'playing' : 'paused'; } catch (e) {}
  const key = book ? [book.id, chapter].join('|') : '';
  if (key !== tapeMetaKey && window.MediaMetadata) {
    tapeMetaKey = key;
    ms.metadata = book ? new MediaMetadata({
      title: book.chapters[chapter].title,
      artist: book.creator || 'LibriVox',
      album: book.title,
      artwork: [{ src: coverUrl(book.id) }],
    }) : null;
  }
  if (dur && isFinite(dur) && ms.setPositionState) {
    try { ms.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: tape.playbackRate || 1 }); } catch (e) {}
  }
}

// ---------- rendering: programme card ----------
let tapeInfoKey = null;
function renderTapeInfo() {
  const key = book ? [book.id, chapter].join('|') : '';
  if (key === tapeInfoKey) return;
  tapeInfoKey = key;
  const title = $('infoTitle');
  const meta = $('infoMeta');
  const logo = $('infoLogo');
  meta.textContent = '';
  favBtn.disabled = true;
  if (!book) {
    logo.hidden = true;
    title.className = 'info-title muted';
    title.textContent = 'Pick a book from the Tape library below · 从下方书库选一本书';
    return;
  }
  title.className = 'info-title';
  title.textContent = '📖 ' + book.title;
  const row = (label, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    meta.append(dt, dd);
  };
  const total = book.chapters.reduce((t, c) => t + c.dur, 0);
  row('Author 作者', book.creator);
  row('Chapter 章节', `${chapter + 1}/${book.chapters.length} · ${book.chapters[chapter].title}`);
  row('Length 时长', total ? fmt(total) : '');
  row('About 简介', book.desc);
  const a = document.createElement('a');
  a.href = `${IA}/details/${encodeURIComponent(book.id)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'LibriVox · Internet Archive';
  row('Source 来源', a);
  logo.src = coverUrl(book.id);
  logo.hidden = false;
}

// ---------- rendering: library ----------
const bookList = $('bookList');
const chapterList = $('chapterList');

function showTab(tab) {
  libTab = tab;
  document.querySelectorAll('.lib-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('libSearchRow').hidden = tab !== 'en';
  renderBooks();
}

async function renderBooks() {
  const tab = libTab;
  const msg = $('libMsg');
  bookList.textContent = '';
  if (!tab) return;
  let items;
  if (tab === 'resume') {
    items = Object.entries(store.books)
      .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0))
      .map(([id, s]) => ({ id, title: s.title || id, creator: s.creator || '' }));
    msg.textContent = items.length ? '' : 'Books you start will appear here · 听过的书会出现在这里';
  } else {
    const cacheKey = tab + '|' + (tab === 'en' ? libSearchTerm : '');
    if (!libCache[cacheKey]) {
      msg.textContent = 'Loading… · 载入中';
      try {
        libCache[cacheKey] = await searchBooks(tab, tab === 'en' ? libSearchTerm : '');
      } catch (e) {
        if (libTab === tab) msg.textContent = 'Could not reach the library · 无法连接书库';
        return;
      }
      if (libTab !== tab) return;
    }
    items = libCache[cacheKey];
    msg.textContent = items.length ? '' : 'No books found · 没有找到';
  }
  bookList.textContent = '';
  for (const it of items) bookList.append(bookRow(it, tab === 'resume'));
}

function bookRow(it, removable) {
  const li = document.createElement('li');
  li.classList.toggle('current', !!(book && book.id === it.id));
  const btn = document.createElement('button');
  btn.className = 'book-btn';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = coverUrl(it.id);
  img.addEventListener('error', () => { img.hidden = true; });
  const text = document.createElement('span');
  text.className = 'book-text';
  const t = document.createElement('b');
  t.textContent = it.title;
  const c = document.createElement('small');
  const saved = store.books[it.id];
  c.textContent = [it.creator,
    saved ? (saved.done ? 'Finished · 已听完' : `Ch ${saved.chapter + 1}/${saved.chapters} · ${fmt(saved.time)}`) : '']
    .filter(Boolean).join(' · ');
  text.append(t, c);
  btn.append(img, text);
  btn.addEventListener('click', () => { if (!book || book.id !== it.id) cueBook(it.id); });
  li.append(btn);
  if (removable) {
    const x = document.createElement('button');
    x.className = 'fav-tool';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Forget listening position: ' + it.title);
    x.addEventListener('click', () => {
      delete store.books[it.id];
      if (store.last === it.id) store.last = null;
      saveTapeStore();
      renderBooks();
    });
    li.append(x);
  }
  return li;
}

function renderChapters() {
  const box = $('chapterBox');
  chapterList.textContent = '';
  box.hidden = !book;
  if (!book) return;
  $('chapterHead').textContent = `CHAPTERS · 章节 — ${book.title}`;
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.classList.toggle('current', i === chapter);
    const btn = document.createElement('button');
    btn.className = 'fav-play';
    const n = document.createElement('b');
    n.textContent = String(i + 1);
    const name = document.createElement('span');
    name.textContent = c.title;
    const d = document.createElement('small');
    d.textContent = c.dur ? fmt(c.dur) : '';
    btn.append(n, name, d);
    btn.addEventListener('click', () => playChapter(i, 0, true));
    li.append(btn);
    chapterList.append(li);
  });
}

// ---------- keyboard (tape mode) ----------
function tapeKey(e, onButton) {
  switch (e.key) {
    case 'ArrowRight': tapeSkip(TAPE_SKIP_S); return true;
    case 'ArrowLeft': tapeSkip(-TAPE_SKIP_S); return true;
    case ']': tapeChapter(1); return true;
    case '[': tapeChapter(-1); return true;
    case ' ': if (onButton) return false; tapeToggle(); return true;
    default: return false;
  }
}

// ---------- wiring ----------
modeBtn.addEventListener('click', () => setMode(mode === 'tape' ? 'radio' : 'tape'));
tapePlayBtn.addEventListener('click', tapeToggle);
$('tapePrev').addEventListener('click', () => tapeChapter(-1));
$('tapeNext').addEventListener('click', () => tapeChapter(1));
$('tapeBack').addEventListener('click', () => tapeSkip(-TAPE_SKIP_S));
$('tapeFwd').addEventListener('click', () => tapeSkip(TAPE_SKIP_S));
$('speedBtn').addEventListener('click', cycleSpeed);
document.querySelectorAll('.lib-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
const runSearch = () => {
  libSearchTerm = $('libSearch').value.trim().slice(0, 80);
  renderBooks();
};
$('libGo').addEventListener('click', runSearch);
$('libSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

// ---------- boot ----------
loadTapeStore();
if (store.mode === 'tape') setMode('tape');
