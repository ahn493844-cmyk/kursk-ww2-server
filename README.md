# KURSK 실시간 동기화 서버

SSE(Server-Sent Events) 기반 실시간 브로드캐스트 서버입니다.
게임 결과가 등록되면 연결된 모든 앱에 즉시 반영됩니다.

---

## 로컬 실행 (같은 네트워크 내 공유)

```bash
npm install
node server.js
```

같은 와이파이/LAN에 있는 PC는 이 PC의 내부 IP로 접속 가능합니다.
내부 IP 확인: 명령 프롬프트에서 `ipconfig` → IPv4 주소 (예: 192.168.0.5)

앱 서버 설정 탭에 `http://192.168.0.5:3000` 입력 후 연결.

---

## Railway 무료 클라우드 배포 (인터넷 어디서나 접속)

### 방법 1 — GitHub 연동 (권장)

1. https://github.com 가입 후 새 저장소(Repository) 만들기
2. 이 폴더의 파일들(`server.js`, `package.json`)을 업로드
3. https://railway.app 접속 → GitHub로 로그인
4. "New Project" → "Deploy from GitHub repo" → 위 저장소 선택
5. 자동 배포 완료 후 "Settings" → "Domains" → 주소 생성
6. 생성된 주소(예: `https://kursk-xxxx.up.railway.app`)를 앱에 입력

### 방법 2 — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | /ping | 서버 상태 확인 |
| GET | /data | 전체 데이터 조회 |
| GET | /events | SSE 실시간 구독 |
| POST | /game | 게임 결과 등록 |
| DELETE | /history/:idx | 전적 삭제 + 재계산 |
| PATCH | /player/:key | 플레이어 레이팅 수정 |
| DELETE | /player/:key | 플레이어 삭제 |
| PATCH | /player/:key/reset-stats | 통계 초기화 |

---

## 데이터 저장

`kursk_data.json` 파일에 저장됩니다.
Railway는 재배포 시 이 파일이 초기화될 수 있으므로,
중요한 데이터는 앱의 "JSON 내보내기" 기능으로 백업하세요.
