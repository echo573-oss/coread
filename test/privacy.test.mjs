import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb,getDb } from '../lib/db.mjs';
import { runAs,HUMAN } from '../lib/identity.mjs';
import { createComment,shareThread,activity } from '../lib/comments.mjs';
import { recentActivity } from '../lib/recent-activity.mjs';
import { exportBackup,migrateBackup,previewBackup,restoreBackup } from '../lib/backup.mjs';

test('late sharing, cursor pages, thread ancestry and legacy backup migration',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coread-privacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  initDb(path.join(dir,'library.db'));
  const db=getDb();
  for(const id of [1,2]){db.prepare('INSERT INTO books(id,title,total_paragraphs) VALUES(?,?,1)').run(id,'Book '+id);db.prepare('INSERT INTO book_paragraphs(book_id,idx,content) VALUES(?,0,?)').run(id,'A stable anchor.');}
  db.close();
  const privateNote=runAs(HUMAN,()=>createComment(1,{paragraph_idx:0,content:'LATE_SHARE'}));
  const initial=recentActivity();assert.deepEqual(initial.events,[]);assert.deepEqual(initial.recent_annotations,[]);
  assert.throws(()=>shareThread(privateNote.id,'shared'),/Owner session/);
  assert.throws(()=>createComment(1,{paragraph_idx:0,content:'cannot reply',reply_to:privateNote.id}),/not found/);
  runAs(HUMAN,()=>{
    assert.throws(()=>createComment(2,{paragraph_idx:0,content:'wrong book',reply_to:privateNote.id}),/not found/);
    shareThread(privateNote.id,'shared');
  });
  assert.match(JSON.stringify(recentActivity({after_cursor:initial.next_cursor})),/LATE_SHARE/);
  let cursor=recentActivity().next_cursor;
  for(let i=0;i<5;i++)createComment(1,{paragraph_idx:0,content:'AI '+i});
  const ids=[];
  for(let i=0;i<3;i++) {const page=recentActivity({after_cursor:cursor,limit:2});ids.push(...page.events.map(e=>e.id));cursor=page.next_cursor;assert.equal(page.has_more,i<2);}
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);
  const raw=getDb();
  raw.prepare("INSERT INTO book_comments(id,book_id,paragraph_idx,content,visibility,reply_to) VALUES(100,1,0,'ORPHAN','shared',999)").run();
  raw.prepare("INSERT INTO book_comments(id,book_id,paragraph_idx,content,visibility,reply_to) VALUES(101,1,0,'CYCLE','shared',102),(102,1,0,'CYCLE','shared',101)").run();
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM visible_comments WHERE id>=100').get().n,0);raw.close();
  runAs(HUMAN,()=>{
    const backup=exportBackup();assert.equal(backup.schemaVersion,2);
    const old=structuredClone(backup);old.schemaVersion=1;delete old.data.reading_log;delete old.data.reading_activity;
    for(const table of ['book_comments','reading_record_notes'])for(const row of old.data[table])for(const key of ['author_role','visibility','shared_at','updated_at'])delete row[key];
    for(const row of old.data.reading_checkpoints)delete row.start_min;
    const upgraded=migrateBackup(old);assert.equal(upgraded.data.book_comments.find(c=>c.id===privateNote.id).visibility,'private');
    const knownAi=upgraded.data.book_comments.find(c=>c.from_who==='ai');assert.equal(knownAi.author_role,'ai');assert.equal(knownAi.visibility,'shared');
    const preview=previewBackup(old);restoreBackup(preview.token,true);
  });
  assert.doesNotMatch(JSON.stringify(recentActivity()),/LATE_SHARE/);
});
