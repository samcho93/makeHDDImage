'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const { listDisks, volumeInfo, isAdmin, ps } = require('./disks');
const { Imager, readResumeState } = require('./imager');

let win = null;
let disks = [];
let job = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: 'MakeHDDImage',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!job) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['계속 진행', '중단하고 종료'],
      defaultId: 0,
      cancelId: 0,
      message: '이미징이 진행 중입니다.',
      detail: '종료하면 현재 위치까지 이어하기 상태가 저장됩니다(raw 형식).',
    });
    if (choice === 0) e.preventDefault();
    else job.cancel();
  });
}

ipcMain.handle('env:info', async () => ({
  isAdmin: await isAdmin(),
  platform: process.platform,
  version: app.getVersion(),
}));

ipcMain.handle('env:relaunchAdmin', async () => {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argList = args.length ? ` -ArgumentList ${args.map((a) => q(`"${a}"`)).join(',')}` : '';
  try {
    await ps(`Start-Process -FilePath ${q(process.execPath)} -Verb RunAs${argList}`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  app.quit();
  return { ok: true };
});

ipcMain.handle('disks:list', async () => {
  disks = await listDisks();
  return disks;
});

ipcMain.handle('out:choose', async (_e, { format, diskNumber }) => {
  const ext = format === 'gz' ? 'img.gz' : 'img';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await dialog.showSaveDialog(win, {
    title: '이미지 저장 위치',
    defaultPath: `disk${diskNumber ?? ''}_${stamp}.${ext}`,
    filters: format === 'gz'
      ? [{ name: 'Gzip 압축 이미지', extensions: ['gz'] }]
      : [{ name: 'Raw 디스크 이미지', extensions: ['img', 'dd', 'raw', 'bin'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('out:inspect', async (_e, { outPath }) => {
  const res = { volume: null, resume: null, isDirectory: false, exists: false, dirExists: true };
  if (!outPath) return res;
  try {
    const st = fs.statSync(outPath);
    res.exists = true;
    res.isDirectory = st.isDirectory();
  } catch { /* 없음 */ }
  res.dirExists = fs.existsSync(path.dirname(outPath));
  try { res.volume = await volumeInfo(outPath); } catch { /* 네트워크 드라이브 등 */ }
  res.resume = await readResumeState(outPath);
  return res;
});

ipcMain.handle('image:start', async (_e, opts) => {
  if (job) throw new Error('이미 진행 중입니다');
  const disk = disks.find((d) => d.number === opts.diskNumber);
  if (!disk) throw new Error('디스크를 다시 조회하세요');
  if (!opts.outPath) throw new Error('저장 경로를 지정하세요');
  if (fs.existsSync(opts.outPath) && fs.statSync(opts.outPath).isDirectory()) {
    throw new Error('저장 경로가 폴더입니다. 파일 이름을 지정하세요');
  }
  const vol = await volumeInfo(opts.outPath).catch(() => null);
  if (vol && vol.diskNumber === disk.number) throw new Error('원본 디스크에는 이미지를 저장할 수 없습니다');

  const imager = new Imager({
    devicePath: disk.devicePath,
    diskSerial: disk.serial,
    diskLabel: `(${disk.model || disk.friendlyName}, ${disk.busType}, serial ${disk.serial})`,
    size: disk.size,
    sectorSize: disk.logicalSectorSize || 512,
    outPath: opts.outPath,
    format: opts.format,
    sparse: opts.sparse,
    hash: opts.hash,
    resume: opts.resume,
    chunkSize: opts.chunkMiB * 1024 * 1024,
    retries: opts.retries,
    skipAfterBadSectors: opts.skipAfterBadSectors,
  });
  job = imager;
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  imager.on('log', (l) => send('image:log', l));
  imager.on('progress', (p) => send('image:progress', p));
  imager.run()
    .then((result) => send('image:done', result))
    .catch((err) => send(err.code === 'ECANCELLED' ? 'image:cancelled' : 'image:error',
      { message: err.message, code: err.code || '' }))
    .finally(() => {
      powerSaveBlocker.stop(blocker);
      job = null;
    });
  return true;
});

ipcMain.handle('image:cancel', () => {
  if (job) job.cancel();
  return true;
});

ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
