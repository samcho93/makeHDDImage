'use strict';
const $ = (id) => document.getElementById(id);

const state = {
  admin: true,
  disks: [],
  selected: null,
  outInfo: null,
  running: false,
  lastOut: null,
};

function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}
function fmtGiB(n) { return `${(n / 1024 ** 3).toFixed(1)} GiB`; }
function fmtTime(s) {
  if (s == null || !isFinite(s)) return '-';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s % 60}초` : `${s}초`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function log(msg, level = 'info') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  while (el.childNodes.length > 2000) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function formatValue() {
  const v = $('format').value;
  return { format: v === 'gz' ? 'gz' : 'raw', sparse: v === 'raw-sparse' };
}

function renderDisks() {
  const list = $('diskList');
  if (!state.disks.length) {
    list.innerHTML = '<div class="muted">디스크가 없습니다</div>';
    return;
  }
  list.innerHTML = '';
  for (const d of state.disks) {
    const el = document.createElement('div');
    el.className = 'disk' + (state.selected === d.number ? ' selected' : '');
    const parts = d.partitions.length
      ? d.partitions.map((p) => (p.letter ? `${p.letter}:` : `#${p.number}`) + ` ${fmtBytes(p.size)}`).join(', ')
      : '파티션 없음/인식 불가';
    const tags = [
      d.busType ? `<span class="tag ${d.busType === 'USB' ? 'usb' : ''}">${esc(d.busType)}</span>` : '',
      d.isSystem || d.isBoot ? '<span class="tag sys">시스템/부팅</span>' : '',
      d.operationalStatus && d.operationalStatus !== 'Online' ? `<span class="tag">${esc(d.operationalStatus)}</span>` : '',
    ].join('');
    el.innerHTML = `
      <input type="radio" name="disk" ${state.selected === d.number ? 'checked' : ''}>
      <div>
        <div class="name">Disk ${d.number} · ${esc(d.model || d.friendlyName)}${tags}</div>
        <div class="meta">${esc(d.devicePath)} · 섹터 ${d.logicalSectorSize}/${d.physicalSectorSize} · S/N ${esc(d.serial || '-')} · ${esc(parts)}</div>
      </div>
      <div class="size">${fmtBytes(d.size)}<div class="meta">${fmtGiB(d.size)}</div></div>`;
    el.addEventListener('click', () => {
      if (state.running) return;
      state.selected = d.number;
      renderDisks();
      inspectOut();
    });
    list.appendChild(el);
  }
}

async function refreshDisks() {
  $('diskList').innerHTML = '<div class="muted">디스크 조회 중...</div>';
  try {
    state.disks = await window.api.listDisks();
    if (state.selected == null || !state.disks.some((d) => d.number === state.selected)) {
      // 기본 선택: 시스템 디스크가 아닌 USB 디스크
      const cand = state.disks.find((d) => d.busType === 'USB' && !d.isSystem && !d.isBoot);
      state.selected = cand ? cand.number : null;
    }
    renderDisks();
    inspectOut();
  } catch (e) {
    $('diskList').innerHTML = `<div class="hint"><span class="err">디스크 조회 실패: ${esc(e.message)}</span></div>`;
  }
}

function selectedDisk() { return state.disks.find((d) => d.number === state.selected) || null; }

let inspectSeq = 0;
async function inspectOut() {
  const outPath = $('outPath').value.trim();
  const disk = selectedDisk();
  const seq = ++inspectSeq;
  const info = outPath ? await window.api.inspectOutput({ outPath }) : null;
  if (seq !== inspectSeq) return;
  state.outInfo = info;

  const msgs = [];
  let blocking = false;
  const { format, sparse } = formatValue();
  if (info) {
    if (info.isDirectory) { msgs.push('<span class="err">폴더가 아니라 파일 경로를 지정하세요.</span>'); blocking = true; }
    if (!info.dirExists) { msgs.push('<span class="err">상위 폴더가 존재하지 않습니다.</span>'); blocking = true; }
    const v = info.volume;
    if (v) {
      msgs.push(`대상 ${v.letter}: (${v.fileSystem || '?'}) 여유 공간 ${fmtBytes(v.free)}`);
      if (disk && v.diskNumber === disk.number) { msgs.push('<span class="err">원본 디스크에는 저장할 수 없습니다.</span>'); blocking = true; }
      if (disk && v.free < disk.size) {
        if (format === 'raw' && !sparse) msgs.push(`<span class="warn">전체 기록에는 ${fmtBytes(disk.size)}가 필요합니다 – 공간 부족</span>`);
        else msgs.push('<span class="warn">디스크 크기보다 여유 공간이 작습니다. 실제 데이터가 많으면 도중에 공간이 부족할 수 있습니다(스파스/압축).</span>');
      }
      if (sparse && v.fileSystem && v.fileSystem !== 'NTFS' && v.fileSystem !== 'ReFS') {
        msgs.push(`<span class="warn">${v.fileSystem}는 스파스 파일을 지원하지 않습니다.</span>`);
      }
      if (format === 'raw' && v.fileSystem === 'FAT32') { msgs.push('<span class="err">FAT32는 4GB 이상 파일을 저장할 수 없습니다.</span>'); blocking = true; }
    }
    if (info.exists && !info.isDirectory && !info.resume) msgs.push('<span class="warn">기존 파일을 덮어씁니다.</span>');
  }
  $('outInfo').innerHTML = msgs.join(' · ');

  const canResume = !!(info && info.resume && format === 'raw' && disk && info.resume.size === disk.size);
  $('resumeWrap').classList.toggle('hidden', !canResume);
  if (canResume) {
    const r = info.resume;
    $('resumeText').textContent = `이어하기: ${fmtBytes(r.pos)} / ${fmtBytes(r.size)} 지점부터 (불량 섹터 ${r.badSectors}개, ${new Date(r.savedAt).toLocaleString()})`;
    if (!$('resume').dataset.touched) $('resume').checked = true;
  } else {
    $('resume').checked = false;
  }

  $('btnStart').disabled = state.running || !state.admin || !disk || !outPath || blocking;
}

function setRunning(running) {
  state.running = running;
  $('btnStart').classList.toggle('hidden', running);
  $('btnCancel').classList.toggle('hidden', !running);
  $('btnCancel').disabled = false;
  for (const id of ['format', 'outPath', 'btnBrowse', 'btnRefresh', 'chunk', 'retries', 'skipAfter', 'hash', 'resume']) {
    $(id).disabled = running;
  }
  if (!running) inspectOut();
}

async function start() {
  const disk = selectedDisk();
  if (!disk) return;
  const { format, sparse } = formatValue();
  const resume = $('resume').checked && !$('resumeWrap').classList.contains('hidden');
  if (disk.isSystem || disk.isBoot) {
    if (!confirm('시스템/부팅 디스크입니다. 사용 중인 디스크는 일관된 이미지가 만들어지지 않을 수 있습니다. 계속할까요?')) return;
  }
  const opts = {
    diskNumber: disk.number,
    outPath: $('outPath').value.trim(),
    format,
    sparse,
    resume,
    hash: $('hash').checked,
    chunkMiB: Number($('chunk').value),
    retries: Math.max(0, Number($('retries').value) || 0),
    skipAfterBadSectors: Math.max(0, Number($('skipAfter').value) || 0),
  };
  $('bar').className = '';
  $('bar').style.width = '0%';
  $('btnShow').classList.add('hidden');
  state.lastOut = opts.outPath;
  log(`시작: Disk ${disk.number} (${disk.model || disk.friendlyName}, ${fmtBytes(disk.size)}) → ${opts.outPath}`);
  setRunning(true);
  try {
    await window.api.start(opts);
  } catch (e) {
    log(`시작 실패: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    setRunning(false);
  }
}

window.api.onLog((l) => log(l.msg, l.level));
window.api.onProgress((p) => {
  const pct = p.size ? (p.pos / p.size) * 100 : 0;
  $('bar').style.width = `${pct.toFixed(2)}%`;
  $('stPct').textContent = `${p.phase === 'hash' ? '해시 ' : ''}${pct.toFixed(2)}%`;
  $('stBytes').textContent = `${fmtBytes(p.pos)} / ${fmtBytes(p.size)}`;
  $('stSpeed').textContent = `${fmtBytes(p.speed)}/s`;
  $('stEta').textContent = fmtTime(p.eta);
  $('stBad').textContent = `${p.badSectors} (${p.badRanges}구간)`;
  $('stBackend').textContent = p.backend;
});
window.api.onDone((r) => {
  $('bar').className = 'done';
  $('bar').style.width = '100%';
  log(`이미지 생성 완료: ${r.outPath}`, 'ok');
  log(`보고서: ${r.reportPath}`, 'ok');
  if (r.badSectors) log(`불량 섹터 ${r.badSectors}개는 0으로 채워졌습니다 (보고서 참조)`, 'warn');
  $('btnShow').classList.remove('hidden');
  setRunning(false);
});
window.api.onError((e) => {
  $('bar').className = 'err';
  log(`오류: ${e.code ? e.code + ' ' : ''}${e.message}`, 'error');
  if (e.code === 'EPERM' || e.code === 'EACCES') log('관리자 권한으로 실행했는지 확인하세요.', 'error');
  $('btnShow').classList.remove('hidden');
  setRunning(false);
});
window.api.onCancelled(() => {
  log('중지됨. raw 형식이면 같은 경로를 선택해 이어하기 할 수 있습니다.', 'warn');
  setRunning(false);
});

$('btnRefresh').addEventListener('click', refreshDisks);
$('btnBrowse').addEventListener('click', async () => {
  const p = await window.api.chooseOutput({ format: formatValue().format, diskNumber: state.selected });
  if (p) { $('outPath').value = p; inspectOut(); }
});
$('outPath').addEventListener('change', inspectOut);
$('outPath').addEventListener('input', () => { clearTimeout(state.t); state.t = setTimeout(inspectOut, 400); });
$('format').addEventListener('change', inspectOut);
$('resume').addEventListener('change', () => { $('resume').dataset.touched = '1'; });
$('btnStart').addEventListener('click', start);
$('btnCancel').addEventListener('click', () => {
  $('btnCancel').disabled = true;
  log('중지 요청 – 현재 블록 처리 후 멈춥니다...', 'warn');
  window.api.cancel();
});
$('btnShow').addEventListener('click', () => state.lastOut && window.api.showInFolder(state.lastOut));
$('btnAdmin').addEventListener('click', async () => {
  const r = await window.api.relaunchAdmin();
  if (!r.ok) log(`관리자 권한 재실행 실패/취소: ${r.error}`, 'error');
});

(async () => {
  const env = await window.api.envInfo();
  state.admin = env.isAdmin;
  $('adminBanner').classList.toggle('hidden', env.isAdmin);
  if (!env.isAdmin) log('관리자 권한이 아닙니다. 상단의 버튼으로 다시 실행하세요.', 'warn');
  await refreshDisks();
})();
