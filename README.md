# TM Timer

**포모도로 공부 타이머 + 오늘의 세계 공부 순위**
A Pomodoro study timer with a daily world study ranking.

🌐 **https://tm-timer.pages.dev**

![TM Timer](docs/screenshot-timer.png)

## 기능 · Features

| | 한국어 | English |
|---|---|---|
| ⏱ | 공부 25분 → 휴식 5분 자동 반복, 4회마다 긴 휴식 15분 | Focus 25 → break 5 on repeat, a 15-min long break every 4th session |
| 🔔 | 단계가 바뀔 때 알림음 (처음 시작할 때는 무음) | Chimes on every phase change (silent on the first start) |
| 🪟 | 다른 창 위에 항상 떠 있는 미니 타이머 (Document Picture-in-Picture) | Mini timer that stays on top of other windows |
| ⚙️ | 공부·휴식·긴 휴식 시간과 간격 직접 설정, 빠른 선택 25/5/15 · 50/10/30 · 90/20/30 | Custom durations and presets |
| 🌍 | 오늘의 세계 공부 순위 — 하루 2시간 이상 공부한 사람 상위 20명 + 국가 순위 | Daily world ranking — top 20 people with 2+ hours, plus countries |
| 🈯 | 한국어 · English · 日本語 · 中文 | Four languages |

![World ranking](docs/screenshot-ranking.png)

## 구조 · Structure

```
public/                 정적 사이트 (index.html 한 파일, 외부 라이브러리 없음)
functions/api/ranking.js  세계 순위 API — Cloudflare Pages Functions
schema.sql              순위 DB 표 (Cloudflare D1 / SQLite)
tests/ranking.test.mjs  API 테스트 (node:sqlite 로 D1 흉내)
wrangler.toml           Cloudflare 설정
```

- **프론트엔드:** 빌드 도구 없이 HTML/CSS/JS 한 파일. 타이머는 끝나는 시각 기준으로 계산하고 Web Worker 로 틱을 보내서 탭이 백그라운드여도 밀리지 않습니다.
- **순위 API:** 타이머를 시작하면 서버가 시각을 기록하고, 일시정지·단계 종료·창 닫기 때 공부한 분을 받습니다. 서버는 **실제로 흐른 시간보다 많이 인정하지 않아서** 시작/정지 연타나 조작으로 시간을 부풀릴 수 없습니다. 국가는 Cloudflare 가 IP 로 판별한 국가 코드만 저장합니다 (IP 는 저장하지 않음).

## 직접 배포하기 · Deploy your own

```bash
npx wrangler login
npx wrangler d1 create tm-timer          # 나온 database_id 를 wrangler.toml 에 입력
npx wrangler d1 execute tm-timer --remote --file=schema.sql
npx wrangler pages deploy
```

테스트 (Node 22.5+):

```bash
node --no-warnings tests/ranking.test.mjs
```
