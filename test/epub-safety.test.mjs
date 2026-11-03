import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { parseEpub,extractImages } from '../lib/epub.mjs';

test('EPUB image names cannot become Windows paths during import',()=>{
  const zip=new AdmZip();
  zip.addFile('META-INF/container.xml',Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile('book.opf',Buffer.from('<package><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'));
  zip.addFile('chapter.xhtml',Buffer.from('<p>Safe text paragraph.</p><img src="..\\outside.png"/>'));
  zip.addFile('..\\outside.png',Buffer.from('not a real image'));
  const parsed=parseEpub(zip.toBuffer());
  assert.ok(parsed.paragraphs.includes('Safe text paragraph.'));
  assert.ok([...parsed.epubImageMap.values()].every(name=>!/[\\/:]/.test(name)));
  assert.equal(extractImages(parsed.zip,parsed.epubImageMap,parsed.paragraphs).size,0);
});
