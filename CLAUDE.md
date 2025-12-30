# slack-vibecoder 프로젝트 지침

## 버전 관리 (SemVer)
slack-vibecoder 프로젝트에 변경사항을 커밋하고 푸시할 때는 반드시 package.json의 version 필드를 SemVer 규칙에 맞춰 업데이트해야 합니다.

- MAJOR.MINOR.PATCH 형식 (예: 1.0.0)
- MAJOR: 호환되지 않는 API 변경
- MINOR: 하위 호환성을 유지하면서 기능 추가
- PATCH: 하위 호환성을 유지하면서 버그 수정

버전 업데이트 예시:
- 버그 수정: 1.0.0 → 1.0.1
- 기능 추가: 1.0.1 → 1.1.0
- 주요 변경: 1.1.0 → 2.0.0
