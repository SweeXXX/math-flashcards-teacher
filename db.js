const DB_NAME = 'math_flashcards_db';
const DB_VERSION = 1;
const STORE_TOPICS = 'topics';
const STORE_CARDS = 'cards';
const STORE_SRS = 'srs';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_TOPICS)) db.createObjectStore(STORE_TOPICS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_CARDS)) db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SRS)) db.createObjectStore(STORE_SRS, { keyPath: 'cardId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export async function listTopics() {
  return tx(STORE_TOPICS, 'readonly', (s) => new Promise((resolve) => {
    const items = [];
    s.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { items.push(cursor.value); cursor.continue(); }
      else resolve(items.sort((a,b)=>a.name.localeCompare(b.name)));
    };
  }));
}

export async function listCardsByTopic(topicId) {
  return tx(STORE_CARDS, 'readonly', (s) => new Promise((resolve) => {
    const items = [];
    s.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.topic_id === topicId) items.push(cursor.value);
        cursor.continue();
      } else resolve(items);
    };
  }));
}

export async function updateCard(card) {
  return tx(STORE_CARDS, 'readwrite', (s) => s.put(card));
}

export async function getSrs(cardId) {
  return tx(STORE_SRS, 'readonly', (s) => new Promise((resolve) => {
    const req = s.get(cardId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  }));
}

export async function upsertSrs(record) {
  return tx(STORE_SRS, 'readwrite', (s) => s.put(record));
}

export async function clearAll() {
  const db = await openDb();
  return Promise.all([
    new Promise((res, rej) => { const t = db.transaction(STORE_TOPICS, 'readwrite'); t.objectStore(STORE_TOPICS).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }),
    new Promise((res, rej) => { const t = db.transaction(STORE_CARDS, 'readwrite'); t.objectStore(STORE_CARDS).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); }),
  ]);
}

export async function seedIfEmpty() {
  const hasTopics = (await listTopics()).length > 0;
  if (hasTopics) return;
  const data = await fetch('data/sample.json').then(r => r.json());
  const db = await openDb();
  await new Promise((res, rej) => {
    const t1 = db.transaction(STORE_TOPICS, 'readwrite');
    const s1 = t1.objectStore(STORE_TOPICS);
    data.topics.forEach(t => s1.put(t));
    t1.oncomplete = res; t1.onerror = () => rej(t1.error);
  });
  await new Promise((res, rej) => {
    const t2 = db.transaction(STORE_CARDS, 'readwrite');
    const s2 = t2.objectStore(STORE_CARDS);
    data.cards.forEach(c => s2.put(c));
    t2.oncomplete = res; t2.onerror = () => rej(t2.error);
  });
}

export async function importJson(json) {
  const db = await openDb();
  const { topics = [], cards = [] } = json || {};
  await new Promise((res, rej) => {
    const t = db.transaction([STORE_TOPICS, STORE_CARDS], 'readwrite');
    const st = t.objectStore(STORE_TOPICS);
    const sc = t.objectStore(STORE_CARDS);
    topics.forEach(ti => st.put(ti));
    cards.forEach(ci => sc.put(ci));
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}


