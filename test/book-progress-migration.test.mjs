import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { initDb, getDb } from '../lib/db.mjs';

const Database = createRequire(import.meta.url)('better-sqlite3');

const UPSERT = "INSERT INTO book_progress (book_id, page, paragraph_offset, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET page = excluded.page, paragraph_offset = excluded.paragraph_offset, updated_at = datetime('now')";

function makeCompositeKeyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-progress-'));
  const dbPath = path.join(dir, 'coread.db');
  const db = new Database(dbPath);
  // book_progress 的样子照 273e642 建的库
  db.exec(`
    CREATE TABLE book_progress (
      book_id INTEGER NOT NULL,
      reader TEXT NOT NULL DEFAULT 'default',
      page INTEGER DEFAULT 1,
      paragraph_offset INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT (datetime('now')),
      last_opened_at DATETIME,
      finished_at TEXT,
      PRIMARY KEY (book_id, reader)
    );
  `);
  const insert = db.prepare('INSERT INTO book_progress (book_id, reader, page, updated_at, finished_at) VALUES (?, ?, ?, ?, ?)');
  insert.run(1, 'default', 12, '2026-09-24 10:00:00', null);
  insert.run(1, 'ai', 30, '2026-09-25 10:00:00', null);
  insert.run(2, 'ai', 7, '2026-09-24 09:00:00', '2026-09-24 09:30:00');
  insert.run(2, 'other', 3, '2026-09-26 09:00:00', null);
  db.close();
  return { dir, dbPath };
}

test('composite-key book_progress is rebuilt with a single-column key', () => {
  const { dir, dbPath } = makeCompositeKeyDb();
  try {
    initDb(dbPath);
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(book_progress)').all();
    assert.equal(cols.some(c => c.name === 'reader'), false);
    assert.deepEqual(cols.filter(c => c.pk).map(c => c.name), ['book_id']);

    const rows = db.prepare('SELECT book_id, page, finished_at FROM book_progress ORDER BY book_id').all();
    // 书 1：有 default 行，留 default；书 2：没有 default，留最近更新的那行
    assert.deepEqual(rows, [
      { book_id: 1, page: 12, finished_at: null },
      { book_id: 2, page: 3, finished_at: null },
    ]);

    db.prepare(UPSERT).run(1, 40, 0);
    db.prepare(UPSERT).run(3, 5, 0);
    assert.equal(db.prepare('SELECT page FROM book_progress WHERE book_id = 1').get().page, 40);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_progress').get().n, 3);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('running initDb again on a migrated or fresh database changes nothing', () => {
  const { dir, dbPath } = makeCompositeKeyDb();
  try {
    initDb(dbPath);
    const snapshotDb = getDb();
    const before = snapshotDb.prepare('SELECT * FROM book_progress ORDER BY book_id').all();
    snapshotDb.close();
    initDb(dbPath);
    const db = getDb();
    assert.deepEqual(db.prepare('SELECT * FROM book_progress ORDER BY book_id').all(), before);
    db.close();

    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-progress-fresh-'));
    try {
      const freshPath = path.join(freshDir, 'coread.db');
      initDb(freshPath);
      const fresh = getDb();
      assert.deepEqual(fresh.prepare('PRAGMA table_info(book_progress)').all().filter(c => c.pk).map(c => c.name), ['book_id']);
      fresh.prepare(UPSERT).run(1, 2, 0);
      fresh.close();
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
