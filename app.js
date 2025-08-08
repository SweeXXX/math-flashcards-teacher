import { listTopics, listCardsByTopic, updateCard, seedIfEmpty, clearAll, importJson, getSrs, upsertSrs } from './db.js';

// Авто-источник: публичная страница Notion с билетами пользователя
const DEFAULT_NOTION_URL = 'https://pollen-jewel-bec.notion.site/1-c-8ec04abc8dba4cebbad42125cde3dba9';

const topicsList = document.getElementById('topicsList');
const empty = document.getElementById('empty');
const cardView = document.getElementById('cardView');
const qEl = document.getElementById('question');
const correctChk = document.getElementById('correctChk');
const nextBtn = document.getElementById('nextCard');
const qInput = document.getElementById('qInput');
const aInput = document.getElementById('aInput');
const saveBtn = document.getElementById('saveCard');
const importBtn = document.getElementById('importBtn');
const fileInput = document.getElementById('fileInput');
const resetBtn = document.getElementById('resetBtn');
const urlInput = document.getElementById('urlInput');
const importUrlBtn = document.getElementById('importUrlBtn');

let currentTopicId = null;
let cards = [];
let index = 0;
let showEditor = true;
const srsCache = new Map(); // cardId -> { cardId, level, nextDue }

function renderTopics(items) {
  topicsList.innerHTML = '';
  items.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="topic-name">${escapeHtml(t.name)}</div>` + (t.description ? `<div class="topic-desc">${escapeHtml(t.description)}</div>` : '');
    li.onclick = async () => {
      await loadTopic(t.id);
    };
    topicsList.appendChild(li);
  });
}

function updateCardView() {
  if (!cards.length) {
    cardView.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  cardView.classList.remove('hidden');
  const c = cards[index];
  qEl.textContent = c?.question || '—';
  qInput.value = c?.question || '';
  aInput.value = c?.answer || '';
  const editorBlock = document.querySelector('.editor');
  editorBlock.style.display = showEditor ? '' : 'none';
}

nextBtn.onclick = async () => {
  if (!cards.length) return;
  const current = cards[index];
  const wasCorrect = !!correctChk.checked;
  await scheduleSrs(current.id, wasCorrect);
  correctChk.checked = false;
  index = pickNextIndex(cards, index);
  updateCardView();
};
saveBtn.onclick = async () => {
  if (!cards.length) return;
  const c = { ...cards[index], question: qInput.value, answer: aInput.value };
  await updateCard(c);
  cards[index] = c;
  updateCardView();
};

importBtn.onclick = () => fileInput.click();
fileInput.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const json = JSON.parse(text);
    await importJson(json);
    await load();
  } catch {}
  fileInput.value = '';
};

resetBtn.onclick = async () => {
  await clearAll();
  // Попробуем подтянуть билеты с публичной страницы Notion
  const data = await fetchNotionPublicPage(DEFAULT_NOTION_URL);
  if (data) await importJson(data);
  await load();
};

importUrlBtn.onclick = async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  try {
    await clearAll();
    const json = await fetchNotionPublicPage(url);
    if (!json) return;
    await importJson(json);
    await load();
  } catch {}
};

async function load() {
  const items = await listTopics();
  renderTopics(items);
  // если есть хотя бы одна тема — сразу открываем первую и показываем карточку
  if (items.length) {
    await loadTopic(items[0].id);
  } else {
    currentTopicId = null; cards = []; index = 0; updateCardView();
  }
}

async function loadTopic(topicId) {
  currentTopicId = topicId;
  cards = await listCardsByTopic(currentTopicId);
  // load SRS for cards into cache
  srsCache.clear();
  const records = await Promise.all(cards.map(c => getSrs(c.id)));
  records.forEach((rec, i) => { if (rec) srsCache.set(cards[i].id, rec); });
  // pick first card: prefer due
  index = pickNextIndex(cards, -1);
  updateCardView();
}

function shuffle(arr) { arr.sort(() => Math.random() - 0.5); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

(async function init(){
  // Импортируем только билеты со страницы по умолчанию, очищая БД
  try {
    await clearAll();
    const data = await fetchNotionPublicPage(DEFAULT_NOTION_URL);
    if (data) await importJson(data);
  } catch {}
  await load();
})();

// Импорт публичной страницы Notion: если есть подстраницы — каждая становится отдельной темой (билетом)
async function fetchNotionPublicPage(publicUrl){
  const root = await fetchWithCorsFallback(publicUrl);
  if (!root) return null;
  if (root.includes('<html')) {
    const doc = new DOMParser().parseFromString(root, 'text/html');
    const childLinks = extractChildPageLinks(doc, publicUrl);
    if (childLinks.length) {
      const topics = [];
      const cards = [];
      for (const href of childLinks) {
        const html = await fetchWithCorsFallback(href);
        if (!html) continue;
        const { topic, pageCards } = parsePageToTopicAndCards(html);
        if (!topic) continue;
        topics.push(topic);
        pageCards.forEach(c => cards.push({ ...c, topic_id: topic.id }));
      }
      if (topics.length) return { topics, cards };
    }
    // Фоллбек: парсим корневую страницу как одну тему
    const { topic, pageCards } = parsePageToTopicAndCards(root);
    if (topic) return { topics: [topic], cards: pageCards.map(c => ({ ...c, topic_id: topic.id })) };
    return null;
  }
  // Текстовый ответ — парсим как одну тему
  const { topic, pageCards } = parsePageToTopicAndCards(root);
  if (topic) return { topics: [topic], cards: pageCards.map(c => ({ ...c, topic_id: topic.id })) };
  return null;
}

// Простая логика интервального повторения (SRS):
// Для каждой карточки храним уровень (n) и nextDue (ts).
// Если верно — n++, интервал = 2^n дней; если неверно — n=0, интервал = 1 день.
async function scheduleSrs(cardId, wasCorrect) {
  const now = Date.now();
  const record = (await getSrs(cardId)) || { cardId, level: 0, nextDue: now };
  if (wasCorrect) {
    record.level = Math.min(record.level + 1, 10);
  } else {
    record.level = 0;
  }
  const days = Math.max(1, Math.pow(2, record.level));
  record.nextDue = now + days * 24 * 60 * 60 * 1000;
  await upsertSrs(record);
  srsCache.set(cardId, { ...record });
}

// Выбор следующей карточки: приоритет карточкам с истёкшим nextDue
function pickNextIndex(all, currentIdx) {
  if (!all.length) return 0;
  const now = Date.now();
  const n = all.length;
  let minFutureDue = Number.POSITIVE_INFINITY;
  let minFutureIdx = (currentIdx + 1) % n;
  for (let step = 1; step <= n; step++) {
    const idx = (currentIdx + step) % n;
    const c = all[idx];
    const rec = srsCache.get(c.id);
    const due = rec?.nextDue ?? 0; // нет записи — считаем «должна» сейчас
    if (due <= now) return idx;
    if (due < minFutureDue) { minFutureDue = due; minFutureIdx = idx; }
  }
  return minFutureIdx;
}

function extractChildPageLinks(doc, baseUrl) {
  const base = new URL(baseUrl);
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const urls = new Set();
  for (const a of anchors) {
    try {
      const u = new URL(a.getAttribute('href'), base);
      const isNotion = /notion\.(site|so)$/i.test(u.hostname);
      const hasId = /[a-f0-9]{32}/i.test(u.pathname);
      if (isNotion && hasId) urls.add(u.toString());
    } catch {}
  }
  return Array.from(urls);
}

function parsePageToTopicAndCards(content) {
  let title = 'Notion';
  const texts = [];
  if (content.includes('<html')) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    title = doc.querySelector('title')?.textContent?.trim() || title;
    const main = doc.querySelector('main') || doc.body;
    const elements = Array.from(main.querySelectorAll('h1, h2, h3, p, li, blockquote, pre, code'));
    for (const el of elements) {
      const txt = (el.textContent || '').trim();
      if (txt) texts.push(txt);
    }
  } else {
    const lines = content.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
    title = lines.find(s => s.length > 5) || title;
    texts.push(...lines);
  }
  // Убираем дубликаты подряд и слишком короткие элементы
  const cleaned = [];
  for (const t of texts) {
    if (!t) continue;
    if (cleaned.length && cleaned[cleaned.length - 1] === t) continue;
    cleaned.push(t);
  }
  const topicId = crypto.randomUUID();
  const pageCards = cleaned.map(t => ({ id: crypto.randomUUID(), question: t, answer: '' }));
  return { topic: { id: topicId, name: title, description: 'Импортировано из Notion' }, pageCards };
}

// CORS fallback: пробуем прямой доступ, затем r.jina.ai и allorigins.win
async function fetchWithCorsFallback(url){
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (r.ok) return await r.text();
  } catch {}
  try {
    const r2 = await fetch(`https://r.jina.ai/http://${url.replace(/^https?:\/\//,'')}`);
    if (r2.ok) return await r2.text();
  } catch {}
  try {
    const enc = encodeURIComponent(url);
    const r3 = await fetch(`https://api.allorigins.win/raw?url=${enc}`);
    if (r3.ok) return await r3.text();
  } catch {}
  return null;
}


