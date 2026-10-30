'use strict';
// 디스크 이미징 엔진.
// - 청크 단위로 읽고, 실패하면 하위 블록 → 섹터 단위로 쪼개 재시도한다.
// - 끝내 읽히지 않는 섹터는 0으로 채우고 위치를 기록한다(ddrescue 방식).
// - 장치가 응답하지 않으면 재연결을 시도하고, 그래도 안 되면 이어하기 상태를 저장하고 중단한다.

const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { openReader } = require('./rawReader');
const sys = require('./sysPaths');

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CancelledError extends Error {
  constructor() { super('사용자가 취소했습니다'); this.code = 'ECANCELLED'; }
}

function statePathFor(outPath) { return outPath + '.resume.json'; }

async function readResumeState(outPath) {
  try {
    const st = JSON.parse(await fsp.readFile(statePathFor(outPath), 'utf8'));
    await fsp.access(outPath);
    return st;
  } catch {
    return null;
  }
}

function setSparse(file) {
  return new Promise((resolve) => {
    execFile(sys.fsutil, ['sparse', 'setflag', file], { windowsHide: true }, (err) => resolve(!err));
  });
}

class Imager extends EventEmitter {
  constructor(opts) {
    super();
    this.o = {
      chunkSize: 4 * MiB,
      subBlockSize: 64 * 1024,
      retries: 2,
      skipAfterBadSectors: 64,
      sparse: true,
      hash: true,
      format: 'raw', // 'raw' | 'gz'
      resume: false,
      readerFactory: openReader,
      ...opts,
    };
    // 필수: devicePath, size, sectorSize, outPath
    const { size, sectorSize, chunkSize, subBlockSize } = this.o;
    if (!size || !sectorSize) throw new Error('디스크 크기/섹터 크기가 필요합니다');
    if (chunkSize % subBlockSize || subBlockSize % sectorSize) throw new Error('청크/블록 크기는 섹터 크기의 배수여야 합니다');
    this.cancelled = false;
    this.bad = []; // [start, length] (bytes), 인접 구간은 병합
    this.badSectors = 0;
    this.pos = 0;
    this.committed = 0;
    this.lastGoodPos = -1;
    this.samples = [];
    this.lastEmit = 0;
  }

  cancel() { this.cancelled = true; }

  _log(msg, level = 'info') { this.emit('log', { time: Date.now(), level, msg }); }

  _markBad(start, len) {
    const last = this.bad[this.bad.length - 1];
    if (last && last[0] + last[1] === start) last[1] += len;
    else {
      this.bad.push([start, len]);
      this._log(`불량 섹터: LBA ${start / this.o.sectorSize} 부근 (오프셋 ${start})`, 'warn');
    }
    this.badSectors += len / this.o.sectorSize;
  }

  async _readExact(buf, off, len, pos) {
    let done = 0;
    while (done < len) {
      const n = await this.reader.read(buf, off + done, len - done, pos + done);
      if (n <= 0) {
        const e = new Error(`예상보다 짧은 읽기 (오프셋 ${pos + done})`);
        e.code = 'ESHORTREAD';
        throw e;
      }
      done += n;
    }
  }

  async _tryRead(buf, off, len, pos) {
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      if (this.cancelled) throw new CancelledError();
      try {
        await this._readExact(buf, off, len, pos);
        this.lastGoodPos = pos;
        return true;
      } catch (e) {
        this.lastError = e;
        if (attempt < this.o.retries) await sleep(50);
      }
    }
    return false;
  }

  async _readRange(buf, len, pos) {
    try {
      await this._readExact(buf, 0, len, pos);
      this.lastGoodPos = pos;
      return;
    } catch (e) {
      this.lastError = e;
      this._log(`읽기 오류 @${pos}: ${e.code || ''} ${e.message} → 세분화하여 재시도`, 'warn');
    }

    const { subBlockSize, sectorSize, skipAfterBadSectors } = this.o;
    for (let off = 0; off < len; off += subBlockSize) {
      const l = Math.min(subBlockSize, len - off);
      if (await this._tryRead(buf, off, l, pos + off)) continue;

      let consecutive = 0;
      let anyGood = false;
      for (let s = 0; s < l; s += sectorSize) {
        if (skipAfterBadSectors > 0 && consecutive >= skipAfterBadSectors) {
          // 연속 불량이 많으면 해당 블록 나머지는 건너뛴다(장시간 정지 방지)
          buf.fill(0, off + s, off + l);
          this._markBad(pos + off + s, l - s);
          break;
        }
        if (await this._tryRead(buf, off + s, sectorSize, pos + off + s)) {
          consecutive = 0;
          anyGood = true;
        } else {
          buf.fill(0, off + s, off + s + sectorSize);
          this._markBad(pos + off + s, sectorSize);
          consecutive++;
        }
      }
      if (!anyGood) await this._ensureAlive();
    }
  }

  // 블록 전체가 실패했을 때: 장치가 분리/정지된 것인지, 그냥 불량 구간인지 구분한다.
  async _ensureAlive() {
    if (this.lastGoodPos < 0) return;
    const probe = Buffer.alloc(this.o.sectorSize);
    for (let i = 0; i < 30; i++) {
      if (this.cancelled) throw new CancelledError();
      try {
        await this._readExact(probe, 0, probe.length, this.lastGoodPos);
        if (i > 0) this._log('장치가 다시 응답합니다 – 계속 진행', 'info');
        return;
      } catch (e) {
        if (i === 0) this._log(`장치 응답 없음(${e.code || e.message}) – 재연결 시도 중...`, 'warn');
        await sleep(2000);
        try { await this.reader.reopen(); } catch { /* 다음 시도 */ }
      }
    }
    const err = new Error('장치가 응답하지 않습니다(분리되었거나 고장). 이어하기 상태를 저장했습니다.');
    err.code = 'EDEVICEGONE';
    throw err;
  }

  async _openOutput(resume) {
    const { format, outPath, sparse } = this.o;
    if (format === 'gz') {
      this.gz = zlib.createGzip({ level: 1 });
      this.ws = fs.createWriteStream(outPath);
      this.gz.pipe(this.ws);
      this.outError = null;
      this.outDone = new Promise((resolve, reject) => {
        const fail = (e) => { this.outError = e; reject(e); };
        this.ws.on('close', resolve);
        this.ws.on('error', fail);
        this.gz.on('error', fail);
      });
      this.outDone.catch(() => {});
      return;
    }
    this.fh = await fsp.open(outPath, resume ? 'r+' : 'w');
    if (!resume && sparse) {
      this.sparseOk = await setSparse(outPath);
      if (!this.sparseOk) this._log('스파스 파일 설정 실패 – 빈 영역도 디스크 공간을 차지할 수 있습니다', 'warn');
    }
  }

  async _write(buf, len, pos) {
    const data = buf.subarray(0, len);
    if (this.gz) {
      if (this.outError) throw this.outError;
      if (!this.gz.write(Buffer.from(data))) {
        await new Promise((resolve, reject) => {
          this.gz.once('drain', resolve);
          this.outDone.catch(reject);
        });
      }
      return;
    }
    if (this.o.sparse && data.equals(this.zero.subarray(0, len))) return; // 0 블록은 쓰지 않음(스파스)
    let done = 0;
    while (done < len) {
      const { bytesWritten } = await this.fh.write(data, done, len - done, pos + done);
      done += bytesWritten;
    }
  }

  async _closeOutput(finalize) {
    if (this.gz) {
      this.gz.end();
      await this.outDone;
      this.gz = null;
      return;
    }
    if (this.fh) {
      if (finalize) await this.fh.truncate(this.o.size);
      await this.fh.close();
      this.fh = null;
    }
  }

  async _saveState() {
    if (this.o.format !== 'raw') return;
    const st = {
      version: 1,
      devicePath: this.o.devicePath,
      diskSerial: this.o.diskSerial || '',
      size: this.o.size,
      sectorSize: this.o.sectorSize,
      pos: this.committed,
      sparse: this.o.sparse,
      bad: this.bad.filter((b) => b[0] < this.committed),
      badSectors: this.bad.filter((b) => b[0] < this.committed).reduce((a, b) => a + b[1], 0) / this.o.sectorSize,
      savedAt: new Date().toISOString(),
    };
    await fsp.writeFile(statePathFor(this.o.outPath), JSON.stringify(st, null, 2));
  }

  _progress(phase = 'image', force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    const cur = phase === 'hash' ? this.hashPos : this.pos;
    const total = this.o.size;
    this.samples.push([now, cur]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
    const [t0, p0] = this.samples[0];
    const speed = now > t0 ? ((cur - p0) * 1000) / (now - t0) : 0;
    this.emit('progress', {
      phase,
      pos: cur,
      size: total,
      speed,
      eta: speed > 0 ? (total - cur) / speed : null,
      badSectors: this.badSectors,
      badRanges: this.bad.length,
      backend: this.reader ? this.reader.name : '',
      elapsed: (now - this.startedAt) / 1000,
    });
  }

  async _hashImageFile() {
    this._log('이어하기로 만든 이미지이므로 이미지 파일에서 SHA-256을 다시 계산합니다');
    this.samples = [];
    this.hashPos = 0;
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(this.o.outPath, { highWaterMark: 4 * MiB })) {
      if (this.cancelled) throw new CancelledError();
      h.update(chunk);
      this.hashPos += chunk.length;
      this._progress('hash');
    }
    return h.digest('hex');
  }

  async _writeReport(result) {
    const o = this.o;
    const lines = [
      'MakeHDDImage 이미징 보고서',
      `원본 장치      : ${o.devicePath} ${o.diskLabel || ''}`,
      `디스크 크기    : ${o.size} bytes (섹터 ${o.sectorSize} bytes)`,
      `이미지 파일    : ${o.outPath} (${o.format}${o.format === 'raw' && o.sparse ? ', sparse' : ''})`,
      `읽기 백엔드    : ${this.reader ? this.reader.name : ''}`,
      `시작           : ${new Date(this.startedAt).toLocaleString()}`,
      `종료           : ${new Date().toLocaleString()}`,
      `SHA-256        : ${result.sha256 || '(계산 안 함)'}`,
      `불량 섹터      : ${this.badSectors} 개 (${this.bad.length} 구간, 0으로 채움)`,
      '',
    ];
    if (this.bad.length) {
      lines.push('불량 구간 (시작 LBA, 섹터 수, 바이트 오프셋):');
      for (const [s, l] of this.bad) lines.push(`  ${s / o.sectorSize}\t${l / o.sectorSize}\t${s}`);
    }
    const reportPath = o.outPath + '.report.txt';
    await fsp.writeFile(reportPath, lines.join('\r\n'), 'utf8');
    return reportPath;
  }

  async run() {
    const o = this.o;
    this.startedAt = Date.now();
    let startPos = 0;
    if (o.resume) {
      if (o.format !== 'raw') throw new Error('이어하기는 raw(.img) 형식에서만 지원됩니다');
      const st = await readResumeState(o.outPath);
      if (!st) throw new Error('이어하기 상태 파일을 찾을 수 없습니다');
      if (st.size !== o.size || st.sectorSize !== o.sectorSize) throw new Error('이어하기 상태가 선택한 디스크와 일치하지 않습니다');
      startPos = st.pos;
      this.bad = st.bad || [];
      this.badSectors = st.badSectors || 0;
      o.sparse = st.sparse;
      this._log(`이어하기: ${startPos} 바이트 지점부터 계속 (기존 불량 섹터 ${this.badSectors}개)`);
    }

    this.reader = await o.readerFactory(o.devicePath, o.sectorSize, (m, l) => this._log(m, l));
    this._log(`장치 열기 성공 – 읽기 백엔드: ${this.reader.name}`);
    this.zero = Buffer.alloc(o.chunkSize);
    let pendingWrite = Promise.resolve();
    let outputOpen = false;
    try {
      await this._openOutput(o.resume);
      outputOpen = true;
      const hash = o.hash && startPos === 0 ? crypto.createHash('sha256') : null;
      const bufs = [Buffer.allocUnsafe(o.chunkSize), Buffer.allocUnsafe(o.chunkSize)];
      let which = 0;
      let pos = startPos;
      this.pos = this.committed = pos;
      let lastSave = Date.now();

      while (pos < o.size && !this.cancelled) {
        const len = Math.min(o.chunkSize, o.size - pos);
        const buf = bufs[which];
        which ^= 1;
        await this._readRange(buf, len, pos);
        if (hash) hash.update(buf.subarray(0, len));
        await pendingWrite;
        this.committed = pos;
        pendingWrite = this._write(buf, len, pos);
        pos += len;
        this.pos = pos;
        this._progress();
        if (Date.now() - lastSave > 10000) {
          await this._saveState();
          lastSave = Date.now();
        }
      }
      await pendingWrite;
      this.committed = pos;

      if (this.cancelled) throw new CancelledError();

      this._progress('image', true);
      await this._closeOutput(true);
      outputOpen = false;
      let sha256 = hash ? hash.digest('hex') : null;
      if (!hash && o.hash && o.format === 'raw') sha256 = await this._hashImageFile();
      await fsp.rm(statePathFor(o.outPath), { force: true });
      const result = { sha256, badSectors: this.badSectors, bad: this.bad, outPath: o.outPath };
      result.reportPath = await this._writeReport(result);
      this._log(`완료. 불량 섹터 ${this.badSectors}개${sha256 ? `, SHA-256 ${sha256}` : ''}`);
      return result;
    } catch (e) {
      await pendingWrite.catch(() => {});
      if (outputOpen) {
        await this._saveState().catch(() => {});
        await this._closeOutput(false).catch(() => {});
      }
      if (e.code === 'ENOSPC') e.message = '대상 드라이브의 공간이 부족합니다. ' + e.message;
      throw e;
    } finally {
      await this.reader.close().catch(() => {});
    }
  }
}

module.exports = { Imager, CancelledError, readResumeState, statePathFor };
