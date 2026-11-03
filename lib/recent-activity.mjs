import { getDb } from './db.mjs';
import { resolvePagination, displayPageForParagraph } from './pagination.mjs';
import { names } from './comments.mjs';

export function recentActivity({book_id, after_cursor, limit=20}={}) {
  const db=getDb(true);
  try {
    const generation=db.prepare("SELECT value FROM config WHERE key='activity_generation'").get().value;
    let after=null;
    if(after_cursor){
      try{const c=JSON.parse(Buffer.from(after_cursor,'base64url').toString());
        if(c.g!==generation || !Number.isSafeInteger(c.id) || c.id<0 || c.b!==(book_id??null)) throw Error(); after=c.id;
      }catch{throw Object.assign(new Error('Activity cursor expired; read the recent snapshot again'),{status:409});}
    }
    const max=Math.min(100,Math.max(1,limit));
    const query=book_id==null ? '' : ' AND book_id=?';
    const params=book_id==null ? [] : [book_id];
    const seq=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='reading_activity'").get()?.seq||0;
    const rows=after===null
      ? db.prepare(`SELECT * FROM reading_activity WHERE 1=1${query} ORDER BY id DESC LIMIT ?`).all(...params,max+1).reverse()
      : db.prepare(`SELECT * FROM reading_activity WHERE id>?${query} ORDER BY id LIMIT ?`).all(after,...params,max+1);
    const hasMore=rows.length>max;
    if(hasMore) after===null ? rows.shift() : rows.pop();
    const labels=names(db);
    const events=rows.flatMap(row=>{
      const comment=row.comment_id==null ? null : db.prepare('SELECT * FROM visible_comments WHERE id=?').get(row.comment_id);
      if(row.comment_id!==null && !comment && !['withdrawn','deleted'].includes(row.kind)) return [];
      return [{id:row.id,kind:row.kind,book_id:row.book_id,comment_id:row.comment_id,author:labels[row.author_role],created_at:row.created_at,
        ...(comment ? {paragraph_idx:comment.paragraph_idx,reply_to:comment.reply_to,selected_text:comment.selected_text?.slice(0,200)||null,content:comment.content.slice(0,400)}:{})}];
    });
    const books=db.prepare(`SELECT b.id,b.title,p.page AS paragraph_idx,COALESCE(p.paragraph_offset,0) AS paragraph_offset,
      p.updated_at,p.last_opened_at FROM books b LEFT JOIN book_progress p ON p.book_id=b.id
      ${book_id==null ? '' : 'WHERE b.id=?'} ORDER BY MAX(COALESCE(p.updated_at,''),COALESCE(p.last_opened_at,''),b.created_at) DESC LIMIT 10`).all(...params)
      .map(b=>{const p=resolvePagination(db,b.id);return {...b,display_page:b.paragraph_idx==null?null:displayPageForParagraph(p,b.paragraph_idx,b.paragraph_offset),total_pages:p.totalPages,pagination_source:p.source};});
    const highlights=after===null ? db.prepare(`SELECT id,book_id,paragraph_idx,selected_text,content,reply_to,author_role,created_at FROM visible_comments WHERE 1=1${query} ORDER BY COALESCE(shared_at,created_at) DESC,id DESC LIMIT ?`).all(...params,max)
      .map(c=>({...c,author:labels[c.author_role],content:c.content.slice(0,400),selected_text:c.selected_text?.slice(0,200)||null})):undefined;
    const next=hasMore && after!==null ? rows.at(-1)?.id ?? after : seq;
    return {books,events,...(highlights?{recent_annotations:highlights}:{}),has_more:after!==null&&hasMore,
      next_cursor:Buffer.from(JSON.stringify({g:generation,id:next,b:book_id??null})).toString('base64url')};
  } finally{db.close();}
}
