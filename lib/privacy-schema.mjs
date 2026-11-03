import crypto from 'node:crypto';

export function migratePrivacy(db) {
  db.transaction(() => {
    for (const table of ['book_comments', 'reading_record_notes']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!columns.includes('author_role')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN author_role TEXT NOT NULL DEFAULT 'human' CHECK(author_role IN ('human','ai'));
          ALTER TABLE ${table} ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared'));
          ALTER TABLE ${table} ADD COLUMN shared_at TEXT;
          ALTER TABLE ${table} ADD COLUMN updated_at TEXT;`);
        // Unknown historic names remain private; display labels never grant ownership.
        db.exec(`UPDATE ${table} SET author_role='ai', visibility='shared', shared_at=created_at
          WHERE lower(from_who) IN ('ai','assistant','claude');
          UPDATE ${table} SET updated_at=created_at;`);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_visibility ON book_comments(book_id, visibility, id);
      CREATE TABLE IF NOT EXISTS reading_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        book_id INTEGER,
        comment_id INTEGER,
        author_role TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_activity_book ON reading_activity(book_id,id);`);
    db.prepare('INSERT OR IGNORE INTO config(key,value) VALUES (?,?)').run('human_display_name','知');
    db.prepare('INSERT OR IGNORE INTO config(key,value) VALUES (?,?)').run('ai_display_name','岚');
    db.prepare('INSERT OR IGNORE INTO config(key,value) VALUES (?,?)').run('activity_generation', crypto.randomUUID());
  })();
}

export function installVisibleViews(db, human) {
  const label=alias=>`CASE WHEN ${alias}.author_role='ai' THEN (SELECT value FROM main.config WHERE key='ai_display_name')
    WHEN lower(${alias}.from_who) IN ('human','user') THEN (SELECT value FROM main.config WHERE key='human_display_name') ELSE ${alias}.from_who END AS display_name`;
  db.exec(human ? `CREATE TEMP VIEW visible_comments AS SELECT c.*,${label('c')} FROM main.book_comments c;`
    : `CREATE TEMP VIEW visible_comments AS WITH RECURSIVE visible(id) AS (
      SELECT id FROM main.book_comments WHERE visibility='shared' AND reply_to IS NULL
      UNION SELECT c.id FROM main.book_comments c JOIN visible v ON c.reply_to=v.id
        JOIN main.book_comments p ON p.id=v.id WHERE c.visibility='shared' AND c.book_id=p.book_id
      ) SELECT c.*,${label('c')} FROM main.book_comments c JOIN visible v ON c.id=v.id;`);
  db.exec(`CREATE TEMP VIEW visible_reading_notes AS SELECT n.*,${label('n')} FROM main.reading_record_notes n${human ? '' : " WHERE visibility='shared'"};`);
}
