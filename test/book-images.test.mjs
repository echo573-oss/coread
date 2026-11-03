import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { initDb, getDb, getImageDir } from '../lib/db.mjs';
import { handleRequest } from '../lib/routes.mjs';

const HAS_PIL = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;

// 纯 Node 写一张够大的 PNG（带噪点，压不小），不依赖 Pillow
function bigPng(width = 900, height = 1350) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width * 3; x++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[row + 1 + x] = ((x + y) & 0xff) ^ (seed >> 24); }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 发一个请求，等 res.end；超过 timeoutMs 没回就算卡住
function request(method, url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} ${url} 卡住没回`)), timeoutMs);
    const res = {
      status: null, headers: {}, body: Buffer.alloc(0),
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v; },
      end(body = '') { clearTimeout(timer); this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); resolve(this); },
    };
    Promise.resolve(handleRequest({ method, url, headers: {}, actor:{role:'human',scopes:['owner']} }, res)).catch(reject);
  });
}

const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8;

test('book-images：书架缩略图有就用、没有就算，越界和乱码路径照旧 404', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coread-images-'));
  const savedPython = process.env.COREAD_PYTHON;
  t.after(() => {
    if (savedPython === undefined) delete process.env.COREAD_PYTHON; else process.env.COREAD_PYTHON = savedPython;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  initDb(path.join(dir, 'coread.db'));
  const db = getDb();
  const addBook = (title) => Number(db.prepare('INSERT INTO books (title, total_paragraphs, cover_image) VALUES (?, 1, ?)').run(title, 'cover.png').lastInsertRowid);
  const withPil = addBook('有 Pillow');
  const noPython = addBook('没有 python');
  const pythonFails = addBook('python 报错');
  const fromBackup = addBook('图在数据库里');
  const png = bigPng();
  for (const id of [withPil, noPython, pythonFails]) fs.writeFileSync(path.join(getImageDir(id), 'cover.png'), png);
  db.prepare('INSERT INTO backup_assets (book_id, name, data) VALUES (?, ?, ?)').run(fromBackup, 'cover.png', png);
  db.close();
  const thumbsDir = (id) => path.join(dir, 'book-thumbs', String(id));

  await t.test('不带 thumb 还是原图，别的查询参数不混进文件名', async () => {
    for (const url of [`/v1/book-images/${withPil}/cover.png`, `/v1/book-images/${withPil}/cover.png?v=2`]) {
      const r = await request('GET', url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers['content-type'], 'image/png');
      assert.ok(r.body.equals(png));
      assert.match(r.headers['content-security-policy'], /sandbox/);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  });

  await t.test('带 thumb=1 回小一号的 jpeg，缩略图不进 book-images', { skip: HAS_PIL ? false : '本机 python3 没装 Pillow' }, async () => {
    delete process.env.COREAD_PYTHON;
    const r = await request('GET', `/v1/book-images/${withPil}/cover.png?thumb=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.ok(isJpeg(r.body));
    assert.ok(r.body.length < png.length, `缩略图 ${r.body.length} 应小于原图 ${png.length}`);
    assert.deepEqual(fs.readdirSync(thumbsDir(withPil)), ['cover.png.jpg']); // 文件名里没混进 ?thumb=1
    assert.deepEqual(fs.readdirSync(getImageDir(withPil)), ['cover.png']);  // 导出/备份打包的目录里没有缩略图
    const again = await request('GET', `/v1/book-images/${withPil}/cover.png?thumb=1`);
    assert.equal(again.headers['content-type'], 'image/jpeg');
    assert.ok(again.body.equals(r.body));
  });

  await t.test('找不到 python 时退回原图 200', async () => {
    process.env.COREAD_PYTHON = path.join(dir, 'no-such-python');
    const r = await request('GET', `/v1/book-images/${noPython}/cover.png?thumb=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(r.body.equals(png));
  });

  await t.test('python 跑失败（等同没装 Pillow）时退回原图 200，不留半截缩略图', async () => {
    const fake = path.join(dir, 'python-without-pillow');
    fs.writeFileSync(fake, '#!/bin/sh\necho "ModuleNotFoundError: No module named PIL" >&2\nexit 1\n', { mode: 0o755 });
    process.env.COREAD_PYTHON = fake;
    const r = await request('GET', `/v1/book-images/${pythonFails}/cover.png?thumb=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(r.body.equals(png));
    assert.deepEqual(fs.existsSync(thumbsDir(pythonFails)) ? fs.readdirSync(thumbsDir(pythonFails)) : [], []);
    delete process.env.COREAD_PYTHON;
  });

  await t.test('图在数据库（备份恢复）里时不缩，直接回原图', async () => {
    const r = await request('GET', `/v1/book-images/${fromBackup}/cover.png?thumb=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(r.body.equals(png));
  });

  await t.test('没有的图、越界和乱码路径都是 404，而且不卡', async () => {
    for (const url of [
      `/v1/book-images/${withPil}/nope.jpg?thumb=1`,
      `/v1/book-images/${withPil}/nope.jpg`,
      `/v1/book-images/${withPil}/..%2F..%2F..%2Fetc%2Fhostname`,
      `/v1/book-images/${withPil}/..%2F..%2F..%2Fetc%2Fhostname?thumb=1`,
      `/v1/book-images/${withPil}/..%2F${noPython}%2Fcover.png?thumb=1`,
      `/v1/book-images/${withPil}/../${noPython}/cover.png`,
      `/v1/book-images/${withPil}/%E0%A4%A`,
      `/v1/book-images/${withPil}/%E0%A4%A?thumb=1`,
      `/v1/book-images/${withPil}/cover.png%3Fthumb%3D1`,
    ]) {
      const r = await request('GET', url, 5000);
      assert.equal(r.status, 404, url);
    }
  });

  await t.test('删书时缩略图目录一起删', async () => {
    fs.mkdirSync(thumbsDir(withPil), { recursive: true });
    fs.writeFileSync(path.join(thumbsDir(withPil), 'cover.png.jpg'), 'x');
    const r = await request('DELETE', `/v1/books/${withPil}`);
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(thumbsDir(withPil)), false);
  });
});
