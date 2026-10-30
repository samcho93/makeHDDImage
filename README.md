# MakeHDDImage

Electron으로 만든 물리 디스크(HDD) → 이미지 파일 생성 도구 (Windows).

## 실행

```bash
npm install
npm start
```

원시 디스크(`\\.\PhysicalDriveN`)를 읽으려면 **관리자 권한**이 필요합니다. 일반 권한으로 실행하면 상단 배너의 버튼으로 UAC 승인 후 다시 실행할 수 있습니다.
배포용 실행 파일(`npm run dist`)은 manifest에 `requireAdministrator`가 들어가서 항상 관리자 권한으로 실행됩니다.

## EISDIR / fstat 오류 대응

`fs.createReadStream`, `fs.readFile`, `fs.copyFile` 등은 내부적으로 `fstat()`을 호출하는데, Windows 원시 장치 핸들에서는
`EISDIR: illegal operation on a directory, fstat` 같은 오류로 실패합니다. 이 프로그램은

1. `fstat`을 전혀 호출하지 않습니다. 디스크 크기와 섹터 크기는 `Get-Disk`로 조회하고, 읽기는 `fs.open` + `fs.read`(명시적 오프셋, 섹터 정렬)만 사용합니다.
2. 그래도 Node 경로가 실패하면 Win32 `CreateFile`/`ReadFile`을 직접 호출하는 PowerShell/C# 헬퍼로 자동 전환합니다(`src/rawReader.js`).

## 불량 섹터 / 장치 오류 처리

- 청크 읽기가 실패하면 64KiB 블록 → 섹터 단위로 쪼개서 재시도합니다.
- 끝내 읽히지 않는 섹터는 0으로 채우고 위치를 `<이미지>.report.txt`에 기록합니다.
- 64KiB 블록 안에서 연속으로 N개(기본 64개) 실패하면 블록의 나머지 섹터를 건너뛰어 오래 멈추지 않게 합니다(옵션에서 0으로 하면 섹터를 하나씩 끝까지 시도).
- USB 연결이 끊기는 등 장치가 응답하지 않으면 최대 1분 동안 다시 연결을 시도합니다.
- raw 형식은 10초마다 `<이미지>.resume.json`에 진행 상태를 저장합니다. 중지·오류 후 같은 파일을 선택하면 **이어하기**를 할 수 있습니다.

## 출력 형식

| 형식 | 설명 |
|---|---|
| Raw .img (스파스) | 기본값. 0으로 채워진 영역은 NTFS 스파스 처리되어 디스크 공간을 차지하지 않습니다 |
| Raw .img (전체) | 디스크 크기만큼 공간을 모두 사용합니다 |
| Gzip .img.gz | 압축합니다. 이어하기는 지원하지 않습니다 |

## 테스트

```bash
npm run test:engine
```

가짜 장치(첫 읽기에서 EISDIR 오류, 불량 섹터 포함)를 대상으로 raw/스파스/gzip/이어하기를 검증합니다.
