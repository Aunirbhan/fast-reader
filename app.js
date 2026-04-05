'use strict';

// ── PDF.js worker ──
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── IndexedDB ──
let db;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('flashread', 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books'))
        d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('words'))
        d.createObjectStore('words', { keyPath: 'bookId' });
      if (!d.objectStoreNames.contains('progress'))
        d.createObjectStore('progress', { keyPath: 'bookId' });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbPut(store, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => res();
    req.onerror = e => rej(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror = e => rej(e.target.error);
  });
}

// ── Hashing ──
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(16);
}

// ── Parse ──
async function parsePDF(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const words = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    setLoading(true, `Parsing page ${p} / ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(' ');
    words.push(...text.split(/\s+/).filter(Boolean));
  }
  return words;
}

async function parseEPUB(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const rootfilePath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!rootfilePath) throw new Error('No rootfile in EPUB container');

  const opfText = await zip.file(rootfilePath).async('string');
  const opfBase = rootfilePath.includes('/')
    ? rootfilePath.split('/').slice(0, -1).join('/') + '/'
    : '';

  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opfText, 'application/xml');

  const manifestItems = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    manifestItems[item.getAttribute('id')] = item.getAttribute('href');
  });

  const spineOrder = [];
  opfDoc.querySelectorAll('spine itemref').forEach(ref => {
    const href = manifestItems[ref.getAttribute('idref')];
    if (href) spineOrder.push(href);
  });

  const words = [];
  for (let si = 0; si < spineOrder.length; si++) {
    const href = spineOrder[si];
    setLoading(true, `Parsing chapter ${si + 1} / ${spineOrder.length}…`);

    const stripped = href.replace(/^\//, '');
    const candidates = [opfBase + stripped, stripped, opfBase + href, href];
    let fileObj = null;
    for (const candidate of candidates) {
      fileObj = zip.file(candidate);
      if (fileObj) break;
    }
    if (!fileObj) continue;

    const html = await fileObj.async('string');
    const doc = parser.parseFromString(html, 'application/xhtml+xml');
    const text = doc.body ? doc.body.textContent : doc.textContent;
    words.push(...text.split(/\s+/).filter(Boolean));
  }
  return words;
}

// ── ORP pivot index ──
function pivotIndex(word) {
  const len = word.length;
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  if (len <= 9) return 2;
  return 3;
}

function splitWord(word) {
  const idx = pivotIndex(word);
  return { pre: word.slice(0, idx), pivot: word[idx] || '', post: word.slice(idx + 1) };
}

// ── RSVP state ──
let words = [];
let currentIndex = 0;
let playing = false;
let wpm = 250;
let tickTimeout = null;
let expected = 0;
let currentBookId = null;
let saveCounter = 0;
const PAGE_SIZE = 200;
let pageMode = false;
let renderedPage = -1;

// ── Page helpers ──
function currentPage(idx)  { return Math.floor(idx / PAGE_SIZE); }
function totalPages()      { return Math.ceil(words.length / PAGE_SIZE); }
function pageStart(page)   { return page * PAGE_SIZE; }
function pageEnd(page)     { return Math.min((page + 1) * PAGE_SIZE, words.length); }

let lastIndicatedPage = -1;

function updatePageIndicator(idx) {
  const pg = currentPage(idx);
  const btn = document.getElementById('page-indicator');
  btn.textContent = `p.${pg + 1} / ${totalPages()}`;

  if (pg !== lastIndicatedPage && lastIndicatedPage !== -1 && !pageMode) {
    btn.classList.remove('page-flash');
    void btn.offsetWidth; // reflow to restart animation
    btn.classList.add('page-flash');
    setTimeout(() => btn.classList.remove('page-flash'), 500);
  }
  lastIndicatedPage = pg;
}

// ── RSVP display ──
function showWord(idx) {
  if (idx < 0 || idx >= words.length) return;

  updatePageIndicator(idx);
  document.getElementById('progress-text').textContent =
    `word ${idx + 1} / ${words.length} (${Math.round((idx + 1) / words.length * 100)}%)`;

  if (pageMode) {
    updatePageHighlight(idx);
    return;
  }

  const { pre, pivot, post } = splitWord(words[idx]);
  document.getElementById('word-pre').textContent = pre;
  document.getElementById('word-pivot').textContent = pivot;
  document.getElementById('word-post').textContent = post;
}

// ── Page mode ──
function renderPageView(page) {
  const area = document.getElementById('page-area');
  const start = pageStart(page);
  const end = pageEnd(page);
  const frag = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const span = document.createElement('span');
    span.className = 'pw';
    span.dataset.i = i;
    span.textContent = words[i];
    span.addEventListener('click', () => {
      currentIndex = i;
      showWord(currentIndex);
      if (playing) {
        clearTimeout(tickTimeout);
        expected = performance.now();
        tickTimeout = setTimeout(tick, 60000 / wpm);
      }
    });
    frag.appendChild(span);
    if (i < end - 1) frag.appendChild(document.createTextNode(' '));
  }

  area.innerHTML = '';
  area.appendChild(frag);
  renderedPage = page;

  document.getElementById('page-prev-btn').disabled = page === 0;
  document.getElementById('page-next-btn').disabled = page >= totalPages() - 1;
}

function updatePageHighlight(idx) {
  const pg = currentPage(idx);
  if (pg !== renderedPage) renderPageView(pg);

  const prev = document.querySelector('#page-area .pw.current');
  if (prev) prev.classList.remove('current');

  const span = document.querySelector(`#page-area .pw[data-i="${idx}"]`);
  if (span) {
    span.classList.add('current');
    span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function jumpPage(delta) {
  const pg = currentPage(currentIndex) + delta;
  if (pg < 0 || pg >= totalPages()) return;
  currentIndex = pageStart(pg);
  renderPageView(pg);
  updatePageHighlight(currentIndex);
  updatePageIndicator(currentIndex);
  if (playing) {
    clearTimeout(tickTimeout);
    expected = performance.now();
    tickTimeout = setTimeout(tick, 60000 / wpm);
  }
}

function togglePageMode() {
  pageMode = !pageMode;
  const rsvp    = document.getElementById('rsvp-area');
  const pageArea = document.getElementById('page-area');
  const pageNav  = document.getElementById('page-nav');
  const btn      = document.getElementById('page-indicator');

  if (pageMode) {
    rsvp.style.display = 'none';
    pageArea.style.display = 'block';
    pageNav.style.display = 'flex';
    btn.classList.add('active');
    renderedPage = -1;
    updatePageHighlight(currentIndex);
  } else {
    rsvp.style.display = 'flex';
    pageArea.style.display = 'none';
    pageNav.style.display = 'none';
    btn.classList.remove('active');
    const { pre, pivot, post } = splitWord(words[currentIndex] || '');
    document.getElementById('word-pre').textContent = pre;
    document.getElementById('word-pivot').textContent = pivot;
    document.getElementById('word-post').textContent = post;
  }
}

// ── Progress ──
function saveProgress() {
  saveCounter++;
  if (saveCounter % 10 === 0 && currentBookId) {
    dbPut('progress', { bookId: currentBookId, currentIndex });
  }
}

function flushProgress() {
  if (currentBookId) {
    dbPut('progress', { bookId: currentBookId, currentIndex });
  }
}

// ── Tick ──
function tick() {
  if (!playing) return;
  showWord(currentIndex);
  saveProgress();
  currentIndex++;
  if (currentIndex >= words.length) {
    playing = false;
    document.getElementById('play-pause-btn').textContent = '▶';
    flushProgress();
    if (confirm('End of book. Start over?')) {
      currentIndex = 0;
      showWord(currentIndex);
      flushProgress();
    }
    return;
  }
  const intervalMs = 60000 / wpm;
  expected += intervalMs;
  const drift = performance.now() - expected;
  tickTimeout = setTimeout(tick, Math.max(0, intervalMs - drift));
}

function startTick() {
  clearTimeout(tickTimeout);
  const intervalMs = 60000 / wpm;
  expected = performance.now();
  tickTimeout = setTimeout(tick, intervalMs);
}

function togglePlay() {
  playing = !playing;
  document.getElementById('play-pause-btn').textContent = playing ? '⏸' : '▶';
  if (playing) startTick();
  else { clearTimeout(tickTimeout); flushProgress(); }
}

// ── WPM slider ──
const slider = document.getElementById('wpm-slider');
slider.addEventListener('input', () => {
  wpm = parseInt(slider.value);
  document.getElementById('wpm-label').textContent = wpm + ' WPM';
  if (playing) {
    clearTimeout(tickTimeout);
    expected = performance.now();
    tickTimeout = setTimeout(tick, 60000 / wpm);
  }
});

// ── Keyboard ──
document.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    if (document.getElementById('reader').style.display !== 'none') {
      e.preventDefault();
      togglePlay();
    }
  }
});

// ── Tap zones ──
document.getElementById('tap-left').addEventListener('click', () => {
  if (currentIndex > 0) {
    currentIndex--;
    showWord(currentIndex);
    if (playing) {
      clearTimeout(tickTimeout);
      expected = performance.now();
      tickTimeout = setTimeout(tick, 60000 / wpm);
    }
  }
});
document.getElementById('tap-right').addEventListener('click', () => {
  if (!playing && currentIndex < words.length - 1) {
    currentIndex++;
    showWord(currentIndex);
  }
});
document.getElementById('tap-center').addEventListener('click', togglePlay);

// ── Views ──
function showLibrary() {
  clearTimeout(tickTimeout);
  playing = false;
  pageMode = false;
  flushProgress();
  words = [];
  currentBookId = null;
  document.getElementById('reader').style.display = 'none';
  document.getElementById('library').style.display = 'flex';
  renderLibrary();
}

function showReader(bookId, bookName, bookWords, startIdx) {
  words = bookWords;
  currentIndex = startIdx || 0;
  currentBookId = bookId;
  playing = false;
  pageMode = false;
  renderedPage = -1;
  lastIndicatedPage = -1;
  document.getElementById('play-pause-btn').textContent = '▶';
  document.getElementById('reader-title').textContent = bookName;
  document.getElementById('rsvp-area').style.display = 'flex';
  document.getElementById('page-area').style.display = 'none';
  document.getElementById('page-nav').style.display = 'none';
  document.getElementById('page-indicator').classList.remove('active');
  document.getElementById('library').style.display = 'none';
  document.getElementById('reader').style.display = 'flex';
  showWord(currentIndex);
}

// ── Library ──
async function renderLibrary() {
  const books = await dbGetAll('books');
  const list = document.getElementById('book-list');

  if (books.length === 0) {
    list.innerHTML = '<p id="empty-msg">No dossiers loaded. Upload an EPUB or PDF to begin.</p>';
    return;
  }

  list.innerHTML = '';
  books.sort((a, b) => b.addedAt - a.addedAt).forEach(book => {
    const item = document.createElement('div');
    item.className = 'book-item';

    const info = document.createElement('div');
    info.className = 'book-info';

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = book.name;

    const meta = document.createElement('div');
    meta.className = 'book-meta';

    dbGet('progress', book.id).then(prog => {
      const idx = prog ? prog.currentIndex : 0;
      const pct = Math.round(idx / book.wordCount * 100);
      meta.textContent = `${book.wordCount.toLocaleString()} words · ${pct}% read`;
    });

    info.appendChild(title);
    info.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'book-delete';
    del.textContent = '✕';
    del.title = 'Delete';
    del.onclick = async e => {
      e.stopPropagation();
      await dbDelete('books', book.id);
      await dbDelete('words', book.id);
      await dbDelete('progress', book.id);
      renderLibrary();
    };

    item.appendChild(info);
    item.appendChild(del);
    item.onclick = async () => {
      setLoading(true, 'Loading…');
      const wordData = await dbGet('words', book.id);
      const prog = await dbGet('progress', book.id);
      setLoading(false);
      showReader(book.id, book.name, wordData.words, prog ? prog.currentIndex : 0);
    };

    list.appendChild(item);
  });
}

// ── Upload ──
document.getElementById('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  setLoading(true, 'Parsing…');
  try {
    let parsed;
    if (file.name.toLowerCase().endsWith('.pdf')) {
      parsed = await parsePDF(file);
    } else if (file.name.toLowerCase().endsWith('.epub')) {
      parsed = await parseEPUB(file);
    } else {
      alert('Only EPUB and PDF files are supported.');
      setLoading(false);
      return;
    }

    if (parsed.length === 0) throw new Error('No text found in file.');

    const id = hashStr(file.name + file.size);
    const book = {
      id,
      name: file.name.replace(/\.(epub|pdf)$/i, ''),
      wordCount: parsed.length,
      addedAt: Date.now()
    };
    await dbPut('books', book);
    await dbPut('words', { bookId: id, words: parsed });

    setLoading(false);
    showReader(id, book.name, parsed, 0);
  } catch (err) {
    setLoading(false);
    alert('Failed to parse file: ' + err.message);
    console.error(err);
  }
});

// ── Loading ──
function setLoading(visible, msg) {
  const el = document.getElementById('loading');
  el.classList.toggle('visible', visible);
  if (msg) document.getElementById('loading-msg').textContent = msg;
}

// ── Init ──
async function init() {
  db = await openDB();
  await renderLibrary();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }
}

init();
