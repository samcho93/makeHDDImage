'use strict';
// 실제 디스크 없이 엔진을 검증한다: 가짜 장치(일부 섹터 불량, 첫 시도 EISDIR)로 이미지를 만들고 결과를 비교.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const { Imager } = require('../src/imager');

const SECTOR = 512;
const SIZE = 24 * 1024 * 1024 + 7 * SECTOR; // 청크 배수가 아닌 크기
const BAD = new Set([100, 101, 102, 5000, 20000]); // 불량 LBA
for (let i = 30000; i < 30200; i++) BAD.add(i); // 연속 불량 구간 (건너뛰기 동작 확인)

const src = Buffer.alloc(SIZE);
crypto.randomFillSync(src, 0, 8 * 1024 * 1024); // 앞 8MiB만 데이터, 나머지는 0(스파스 확인)

function fakeReaderFactory() {
  let first = true;
  return {
    name: 'fake',
    async read(buf, off, len, pos) {
      if (first) {
        first = false;
        const e = new Error("EISDIR: illegal operation on a directory, fstat");
        e.code = 'EISDIR';
        throw e;
      }
      if (pos % SECTOR || len % SECTOR) throw Object.assign(new Error('unaligned'), { code: 'EINVAL' });
      for (let s = pos / SECTOR; s < (pos + len) / SECTOR; s++) {
        if (BAD.has(s)) throw Object.assign(new Error('CRC'), { code: 'EIO' });
      }
      src.copy(buf, off, pos, pos + len);
      return len;
    },
    async reopen() {},
    async close() {},
  };
}

function expected(skipRanges) {
  const e = Buffer.from(src);
  for (const [s, l] of skipRanges) e.fill(0, s, s + l);
  return e;
}

async function runCase(format, sparse, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhi-'));
  const out = path.join(dir, format === 'gz' ? 'x.img.gz' : 'x.img');
  const im = new Imager({
    devicePath: 'fake', size: SIZE, sectorSize: SECTOR, outPath: out, format, sparse,
    chunkSize: 1024 * 1024, retries: 1, skipAfterBadSectors: 16,
    readerFactory: async () => fakeReaderFactory(), ...extra,
  });
  const res = await im.run();
  let img = fs.readFileSync(out);
  if (format === 'gz') img = zlib.gunzipSync(img);
  assert.strictEqual(img.length, SIZE, 'size');
  const exp = expected(res.bad);
  assert.ok(img.equals(exp), 'content mismatch');
  assert.strictEqual(res.sha256, crypto.createHash('sha256').update(exp).digest('hex'));
  for (const lba of [100, 101, 102, 5000, 20000, 30000]) {
    assert.ok(res.bad.some(([s, l]) => lba * SECTOR >= s && lba * SECTOR < s + l), `LBA ${lba} not flagged`);
  }
  // 정상 섹터는 하나도 잃지 않았는지 (연속 불량 구간 건너뛰기 제외)
  const lostGood = res.bad.reduce((a, [s, l]) => {
    for (let x = s / SECTOR; x < (s + l) / SECTOR; x++) if (!BAD.has(x)) a++;
    return a;
  }, 0);
  console.log(`${format}${sparse ? '+sparse' : ''}: OK  bad=${res.badSectors} ranges=${res.bad.length} skippedGood=${lostGood} report=${fs.existsSync(res.reportPath)}`);
  return { dir, out };
}

async function resumeCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhi-'));
  const out = path.join(dir, 'r.img');
  const base = {
    devicePath: 'fake', size: SIZE, sectorSize: SECTOR, outPath: out, format: 'raw', sparse: true,
    chunkSize: 1024 * 1024, retries: 0, skipAfterBadSectors: 16, readerFactory: async () => fakeReaderFactory(),
  };
  const im = new Imager({
    ...base,
    readerFactory: async () => {
      const r = fakeReaderFactory();
      const read = r.read;
      r.read = (buf, off, len, pos) => {
        if (pos >= 10 * 1024 * 1024) im.cancel();
        return read(buf, off, len, pos);
      };
      return r;
    },
  });
  await im.run().then(() => assert.fail('should cancel'), (e) => assert.strictEqual(e.code, 'ECANCELLED'));
  const st = JSON.parse(fs.readFileSync(out + '.resume.json', 'utf8'));
  assert.ok(st.pos > 0 && st.pos < SIZE);
  const res = await new Imager({ ...base, resume: true }).run();
  const exp = expected(res.bad);
  assert.ok(fs.readFileSync(out).equals(exp), 'resume content mismatch');
  assert.strictEqual(res.sha256, crypto.createHash('sha256').update(exp).digest('hex'));
  assert.ok(!fs.existsSync(out + '.resume.json'));
  console.log(`resume: OK  (cancelled at ${st.pos}, bad=${res.badSectors})`);
}

(async () => {
  const { out } = await runCase('raw', true);
  const sizeOnDisk = require('child_process').execFileSync('fsutil.exe', ['sparse', 'queryflag', out]).toString().trim();
  console.log('  fsutil:', sizeOnDisk);
  await runCase('raw', false);
  await runCase('gz', false);
  await resumeCase();
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
