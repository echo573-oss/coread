import { getDb } from './db.mjs';
import { actor, isHuman, requireHuman } from './identity.mjs';
import { matchQuote } from './quote-match.mjs';

export function names(db) {
  const get = key => db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value;
  return { human: get('human_display_name') || '知', ai: get('ai_display_name') || '岚' };
}
export function activity(db, kind, bookId, commentId = null) {
  db.prepare('INSERT INTO reading_activity(kind,book_id,comment_id,author_role) VALUES (?,?,?,?)')
    .run(kind, bookId, commentId, actor().role);
}
export function createComment(bookId, input) {
  const db = getDb();
  try {
    return db.transaction(() => {
      let { paragraph_idx, selected_text } = input;
      if (!Number.isSafeInteger(paragraph_idx) || paragraph_idx < 0 || typeof input.content !== 'string' ||
          !input.content.trim() || input.content.length > 20000) throw Object.assign(new Error('Invalid comment'), { status: 400 });
      if (!db.prepare('SELECT 1 FROM book_paragraphs WHERE book_id=? AND idx=?').get(bookId, paragraph_idx))
        throw Object.assign(new Error('Paragraph not found'), { status: 404 });
      let visibility = isHuman() && input.visibility !== 'shared' ? 'private' : 'shared';
      const parentId = input.reply_to ?? null;
      if (parentId !== null) {
        const parent = db.prepare('SELECT * FROM visible_comments WHERE id=? AND book_id=?').get(parentId, bookId);
        if (!parent) throw Object.assign(new Error('Parent comment not found'), { status: 404 });
        // Replies inherit the thread boundary; sharing is an explicit owner action.
        visibility = parent.visibility;
      }
      let start = input.sel_start_idx ?? null, end = input.sel_end_idx ?? null, note;
      if (selected_text) {
        if (typeof selected_text !== 'string' || selected_text.length > 20000) throw Object.assign(new Error('Invalid quote'), {status:400});
        const lastPara = input.sel_end_para_idx ?? paragraph_idx;
        if (lastPara !== paragraph_idx && start !== null) {
          if (!Number.isSafeInteger(lastPara) || lastPara < paragraph_idx || lastPara - paragraph_idx > 200)
            throw Object.assign(new Error('Invalid selection'), {status:400});
          const rows=db.prepare('SELECT idx,content FROM book_paragraphs WHERE book_id=? AND idx BETWEEN ? AND ? ORDER BY idx').all(bookId,paragraph_idx,lastPara);
          if (!rows.length || rows.at(-1).idx !== lastPara || !Number.isSafeInteger(start) || start<0 || start>rows[0].content.length ||
              !Number.isSafeInteger(end) || end<0 || end>rows.at(-1).content.length) throw Object.assign(new Error('Invalid selection'),{status:400});
        } else if(start!==null && end!==null && isHuman()) {
          const paragraph=db.prepare('SELECT content FROM book_paragraphs WHERE book_id=? AND idx=?').get(bookId,paragraph_idx).content;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>paragraph.length)
            throw Object.assign(new Error('Invalid selection'),{status:400});
          selected_text=paragraph.slice(start,end);
        } else {
          const m = matchQuote(db,bookId,paragraph_idx,selected_text);
          if (!m.ok) return { ok:false,error:m.reason,...(m.paragraph ? {paragraph:m.paragraph.slice(0,800)} : {}) };
          ({paragraph_idx,text:selected_text,start,end,note}=m);
        }
      }
      const result=db.prepare(`INSERT INTO book_comments(book_id,paragraph_idx,sel_start_idx,sel_end_idx,sel_end_para_idx,
        selected_text,from_who,content,reply_to,author_role,visibility,shared_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='shared' THEN datetime('now') END,datetime('now'))`)
        .run(bookId,paragraph_idx,start,end,input.sel_end_para_idx??null,selected_text||null,actor().role,input.content.trim(),parentId,actor().role,visibility,visibility);
      const id=Number(result.lastInsertRowid);
      if(visibility==='shared') activity(db,parentId===null ? 'annotation':'reply',bookId,id);
      return {ok:true,id,visibility,author_role:actor().role,...(note?{note}:{})};
    }).immediate();
  } finally {db.close();}
}

export function deleteComment(id) {
  const db=getDb();
  try {return db.transaction(()=>{
    const row=db.prepare('SELECT * FROM visible_comments WHERE id=?').get(id);
    if(!row) throw Object.assign(new Error('Comment not found'),{status:404});
    if(!isHuman() && row.author_role!=='ai') throw Object.assign(new Error('Cannot delete another author’s comment'),{status:403});
    const descendants=db.prepare(`WITH RECURSIVE thread(id) AS (SELECT id FROM book_comments WHERE id=?
      UNION SELECT c.id FROM book_comments c JOIN thread t ON c.reply_to=t.id) SELECT id FROM thread`).all(id);
    // AI cannot delete human replies through deleting their parent.
    if(!isHuman() && descendants.some(x=>db.prepare('SELECT author_role FROM book_comments WHERE id=?').get(x.id).author_role!=='ai'))
      throw Object.assign(new Error('Thread contains human replies'),{status:403});
    for(const x of descendants) {
      db.prepare('DELETE FROM reading_activity WHERE comment_id=?').run(x.id);
      db.prepare('DELETE FROM book_comments WHERE id=?').run(x.id);
    }
    if(row.visibility==='shared') activity(db,'deleted',row.book_id,id);
    return {ok:true};
  }).immediate();}finally{db.close();}
}

export function shareThread(id, visibility) {
  requireHuman();
  if(!['shared','private'].includes(visibility)) throw Object.assign(new Error('Invalid visibility'),{status:400});
  const db=getDb();
  try{return db.transaction(()=>{
    const root=db.prepare('SELECT * FROM book_comments WHERE id=?').get(id);
    if(!root || root.reply_to!==null) throw Object.assign(new Error('Choose the root of the annotation thread'),{status:400});
    if(root.visibility===visibility) return {ok:true,visibility};
    const rows=db.prepare(`WITH RECURSIVE thread(id) AS (SELECT id FROM book_comments WHERE id=?
      UNION SELECT c.id FROM book_comments c JOIN thread t ON c.reply_to=t.id WHERE c.book_id=?) SELECT id FROM thread`).all(id,root.book_id);
    for(const row of rows){
      db.prepare('DELETE FROM reading_activity WHERE comment_id=?').run(row.id);
      db.prepare("UPDATE book_comments SET visibility=?,shared_at=CASE WHEN ?='shared' THEN datetime('now') ELSE NULL END,updated_at=datetime('now') WHERE id=?")
        .run(visibility,visibility,row.id);
      if(visibility==='shared') activity(db,'shared',root.book_id,row.id);
    }
    if(visibility==='private') activity(db,'withdrawn',root.book_id,id);
    return {ok:true,visibility,count:rows.length};
  }).immediate();}finally{db.close();}
}
