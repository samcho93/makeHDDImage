'use strict';
// PowerShell(Get-Disk / Win32_DiskDrive)로 물리 디스크 정보를 조회한다.
// 장치 크기는 fstat이 아니라 여기서 얻은 값을 사용한다.

const { execFile } = require('child_process');
const sys = require('./sysPaths');

function ps(script) {
  const full = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' + script;
  return new Promise((resolve, reject) => {
    execFile(sys.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

function asArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

async function listDisks() {
  const out = await ps(`
    $wmi = @{}
    Get-CimInstance Win32_DiskDrive | ForEach-Object { $wmi[[int]$_.Index] = $_ }
    @(Get-Disk | Sort-Object Number | ForEach-Object {
      $d = $_
      $w = $wmi[[int]$d.Number]
      $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ number = $_.PartitionNumber; letter = [string]$_.DriveLetter; size = [uint64]$_.Size; type = [string]$_.Type }
      })
      [pscustomobject]@{
        number = [int]$d.Number
        friendlyName = [string]$d.FriendlyName
        model = $(if ($w) { [string]$w.Model } else { [string]$d.Model })
        pnpId = $(if ($w) { [string]$w.PNPDeviceID } else { '' })
        serial = ([string]$d.SerialNumber).Trim()
        size = [uint64]$d.Size
        logicalSectorSize = [int]$d.LogicalSectorSize
        physicalSectorSize = [int]$d.PhysicalSectorSize
        busType = [string]$d.BusType
        partitionStyle = [string]$d.PartitionStyle
        operationalStatus = [string]$d.OperationalStatus
        isSystem = [bool]$d.IsSystem
        isBoot = [bool]$d.IsBoot
        isOffline = [bool]$d.IsOffline
        partitions = $parts
      }
    }) | ConvertTo-Json -Depth 4 -Compress`);
  return asArray(JSON.parse(out || '[]')).map((d) => ({
    ...d,
    devicePath: `\\\\.\\PhysicalDrive${d.number}`,
    partitions: asArray(d.partitions).map((p) => ({ ...p, letter: (p.letter || '').replace(/\0/g, '').trim() })),
  }));
}

// 출력 경로가 위치한 볼륨의 여유 공간 / 디스크 번호
async function volumeInfo(filePath) {
  const m = /^([a-zA-Z]):/.exec(filePath || '');
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const out = await ps(`
    $v = Get-Volume -DriveLetter ${letter}
    $p = Get-Partition -DriveLetter ${letter} -ErrorAction SilentlyContinue
    [pscustomobject]@{
      letter = '${letter}'
      fileSystem = [string]$v.FileSystem
      free = [uint64]$v.SizeRemaining
      size = [uint64]$v.Size
      diskNumber = $(if ($p) { [int]$p.DiskNumber } else { -1 })
    } | ConvertTo-Json -Compress`);
  return JSON.parse(out);
}

async function isAdmin() {
  try {
    const out = await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    return out === 'True';
  } catch {
    return false;
  }
}

module.exports = { listDisks, volumeInfo, isAdmin, ps };
