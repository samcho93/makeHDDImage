'use strict';
// PATH에 같은 이름의 다른 도구(예: WinAVR의 유닉스 유틸)가 있어도 Windows 기본 도구를 쓰도록 절대 경로를 사용한다.
const path = require('path');

const system32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');

module.exports = {
  powershell: path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  fsutil: path.join(system32, 'fsutil.exe'),
};
