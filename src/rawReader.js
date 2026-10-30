'use strict';
// 물리 디스크(\\.\PhysicalDriveN) 읽기 백엔드.
//
// fs.createReadStream / fs.readFile / fs.copyFile 등은 내부적으로 fstat()을 호출하는데,
// Windows 원시 장치 핸들에서는 fstat이 실패하여 "EISDIR: illegal operation on a directory, fstat"
// 같은 오류가 발생한다. 여기서는 stat을 전혀 호출하지 않고 fs.open + fs.read(명시적 position)만 사용하며,
// 그래도 Node 경로가 실패하면 Win32 CreateFile/ReadFile을 직접 호출하는 .NET 헬퍼로 전환한다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sys = require('./sysPaths');

const WIN32_CODES = {
  2: 'ENOENT', 3: 'ENOENT', 5: 'EPERM', 6: 'EBADF', 21: 'ENOTREADY', 23: 'EIO',
  27: 'EIO', 30: 'EIO', 31: 'EIO', 32: 'EBUSY', 55: 'ENODEV', 87: 'EINVAL',
  483: 'EIO', 1117: 'EIO', 1167: 'ENODEV',
};

function win32Error(code, op) {
  const e = new Error(`${op} 실패 (Win32 오류 ${code})`);
  e.code = WIN32_CODES[code] || 'EWIN32';
  e.win32 = code;
  return e;
}

class NodeReader {
  constructor(devicePath) {
    this.name = 'node-fs';
    this.devicePath = devicePath;
    this.fd = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      fs.open(this.devicePath, fs.constants.O_RDONLY, (err, fd) => {
        if (err) return reject(err);
        this.fd = fd;
        resolve();
      });
    });
  }

  read(buf, offset, length, position) {
    return new Promise((resolve, reject) => {
      fs.read(this.fd, buf, offset, length, position, (err, n) => (err ? reject(err) : resolve(n)));
    });
  }

  async reopen() {
    await this.close();
    await this.open();
  }

  close() {
    return new Promise((resolve) => {
      if (this.fd == null) return resolve();
      const fd = this.fd;
      this.fd = null;
      fs.close(fd, () => resolve());
    });
  }
}

// PowerShell + C#(Add-Type) 헬퍼. stdin으로 "R <offset> <length>" / "O"(재오픈) / "Q"(종료)를 받고
// stdout으로 [int32 win32Error][int32 length][data] 를 돌려준다.
const HELPER_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class RawServe {',
  '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  '  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool SetFilePointerEx(SafeFileHandle h, long distance, out long newPos, uint method);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool ReadFile(SafeFileHandle h, byte[] buf, int toRead, out int read, IntPtr overlapped);',
  '  static SafeFileHandle Open(string path, out int err) {',
  '    SafeFileHandle h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
  '    if (h.IsInvalid) { err = Marshal.GetLastWin32Error(); return null; }',
  '    err = 0; return h;',
  '  }',
  '  static void Reply(Stream s, int err, byte[] b, int n) {',
  '    byte[] hdr = new byte[8];',
  '    BitConverter.GetBytes(err).CopyTo(hdr, 0);',
  '    BitConverter.GetBytes(n).CopyTo(hdr, 4);',
  '    s.Write(hdr, 0, 8);',
  '    if (n > 0) s.Write(b, 0, n);',
  '    s.Flush();',
  '  }',
  '  public static int Serve(string path) {',
  '    StreamReader input = new StreamReader(Console.OpenStandardInput());',
  '    Stream output = Console.OpenStandardOutput();',
  '    int openErr;',
  '    SafeFileHandle h = Open(path, out openErr);',
  '    Reply(output, h == null ? openErr : 0, null, 0);',
  '    byte[] buf = new byte[0];',
  '    string line;',
  '    while ((line = input.ReadLine()) != null) {',
  '      string[] p = line.Split(\' \');',
  '      if (p[0] == "Q") break;',
  '      if (p[0] == "O") {',
  '        if (h != null) h.Dispose();',
  '        h = Open(path, out openErr);',
  '        Reply(output, h == null ? openErr : 0, null, 0);',
  '        continue;',
  '      }',
  '      long off = long.Parse(p[1]);',
  '      int len = int.Parse(p[2]);',
  '      if (buf.Length < len) buf = new byte[len];',
  '      int err = 0; int got = 0; long np;',
  '      if (h == null) err = openErr;',
  '      else if (!SetFilePointerEx(h, off, out np, 0)) err = Marshal.GetLastWin32Error();',
  '      else if (!ReadFile(h, buf, len, out got, IntPtr.Zero)) { err = Marshal.GetLastWin32Error(); got = 0; }',
  '      Reply(output, err, buf, got);',
  '    }',
  '    if (h != null) h.Dispose();',
  '    return 0;',
  '  }',
  '}',
  "'@",
  '[void][RawServe]::Serve($args[0])',
  '',
].join('\r\n');

class DotNetReader {
  constructor(devicePath) {
    this.name = 'win32-helper';
    this.devicePath = devicePath;
    this.proc = null;
    this.pending = [];
    this.chunks = [];
    this.buffered = 0;
    this.stderr = '';
  }

  async open() {
    const script = path.join(os.tmpdir(), 'makehddimage-rawreader.ps1');
    fs.writeFileSync(script, HELPER_PS1, 'utf8');
    this.proc = spawn(sys.powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, this.devicePath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('exit', (code) => {
      const err = new Error(`읽기 헬퍼 종료 (code ${code}) ${this.stderr.trim()}`);
      err.code = 'EHELPER';
      for (const p of this.pending.splice(0)) p.reject(err);
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      for (const p of this.pending.splice(0)) p.reject(e);
    });
    const r = await this._request(null);
    if (r.err) throw win32Error(r.err, 'CreateFile');
  }

  _request(line) {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        const e = new Error('읽기 헬퍼가 실행 중이 아닙니다');
        e.code = 'EHELPER';
        return reject(e);
      }
      this.pending.push({ resolve, reject });
      if (line) this.proc.stdin.write(line + '\n');
    });
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const need = n - filled;
      if (c.length <= need) {
        c.copy(out, filled);
        filled += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, filled, 0, need);
        this.chunks[0] = c.subarray(need);
        filled += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  _onData(d) {
    this.chunks.push(d);
    this.buffered += d.length;
    for (;;) {
      if (this.buffered < 8) return;
      const hdr = this.chunks[0].length >= 8 ? this.chunks[0] : Buffer.concat(this.chunks);
      const n = hdr.readInt32LE(4);
      if (this.buffered < 8 + n) return;
      const err = this._take(8).readInt32LE(0);
      const data = n > 0 ? this._take(n) : Buffer.alloc(0);
      const p = this.pending.shift();
      if (p) p.resolve({ err, data });
    }
  }

  async read(buf, offset, length, position) {
    const r = await this._request(`R ${position} ${length}`);
    if (r.err) throw win32Error(r.err, 'ReadFile');
    r.data.copy(buf, offset);
    return r.data.length;
  }

  async reopen() {
    if (!this.proc) return this.open();
    const r = await this._request('O');
    if (r.err) throw win32Error(r.err, 'CreateFile');
  }

  async close() {
    if (!this.proc) return;
    const proc = this.proc;
    try { proc.stdin.end('Q\n'); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve(); }, 3000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

// Node 경로를 먼저 시도하고, 열기/첫 섹터 읽기가 실패하면 Win32 헬퍼로 전환한다.
// 첫 섹터 자체가 불량일 수도 있으므로, 열기에는 성공했지만 두 경로 모두 읽기에 실패하면 Node 경로를 그대로 쓴다.
async function openReader(devicePath, sectorSize, log = () => {}) {
  const probe = Buffer.alloc(sectorSize);
  let node = null;
  let nodeErr = null;
  try {
    node = new NodeReader(devicePath);
    await node.open();
    await node.read(probe, 0, sectorSize, 0);
    return node;
  } catch (e) {
    nodeErr = e;
    log(`Node fs 경로 실패: ${e.code || ''} ${e.message} → Win32 헬퍼로 재시도`, 'warn');
    if (node && node.fd == null) node = null;
  }

  const helper = new DotNetReader(devicePath);
  try {
    await helper.open();
  } catch (e) {
    await helper.close();
    if (node) return node;
    const err = new Error(`장치를 열 수 없습니다. Node: ${nodeErr.code || ''} ${nodeErr.message} / Win32: ${e.message}`);
    err.code = nodeErr.code === 'EPERM' || e.code === 'EPERM' ? 'EPERM' : (nodeErr.code || e.code);
    throw err;
  }
  try {
    await helper.read(probe, 0, sectorSize, 0);
  } catch (e) {
    if (node) {
      log('두 경로 모두 LBA 0 읽기 실패 – 불량 섹터로 간주하고 Node fs 경로로 진행', 'warn');
      await helper.close();
      return node;
    }
    log(`Win32 헬퍼 LBA 0 읽기 실패(${e.message}) – 불량 섹터로 간주하고 진행`, 'warn');
  }
  if (node) await node.close();
  return helper;
}

module.exports = { openReader, NodeReader, DotNetReader };
