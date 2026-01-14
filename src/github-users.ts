/**
 * GitHub 사용자 매핑 관리
 *
 * 슬랙 유저 ID를 GitHub 유저네임/이메일로 매핑합니다.
 * 이를 통해 커밋 작성자를 올바르게 설정할 수 있습니다.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 매핑 파일 구조: 슬랙 유저 ID → GitHub 유저네임 */
type GitHubUsersConfig = Record<string, string>;

/**
 * 매핑 파일을 로드합니다.
 * 파일이 없거나 파싱에 실패하면 빈 객체를 반환합니다.
 */
function loadGitHubUsers(): GitHubUsersConfig {
  const projectRoot = process.env.PROJECT_DIR || process.cwd();
  const configPath = join(projectRoot, "github-users.json");

  if (!existsSync(configPath)) {
    console.warn(`⚠️ GitHub 사용자 매핑 파일이 없습니다: ${configPath}`);
    console.warn("   github-users.example.json을 참고하여 github-users.json을 생성하세요.");
    return {};
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error("❌ GitHub 사용자 매핑 파일 파싱 실패:", error);
    return {};
  }
}

/**
 * 슬랙 유저 ID로 커밋 author 문자열을 생성합니다.
 * Git의 --author 옵션에 사용할 수 있는 형식입니다.
 *
 * @param slackUserId 슬랙 유저 ID
 * @returns "username <이메일>" 형식의 문자열 또는 undefined
 */
export function getGitAuthor(slackUserId?: string): string {
  const FALLBACK_AUTHOR = "cartanova-dev <dev@cartanova.ai>";

  if (!slackUserId) {
    return FALLBACK_AUTHOR;
  }
  const users = loadGitHubUsers();
  const username = users[slackUserId];
  return username ? `${username} <${username}@users.noreply.github.com>` : FALLBACK_AUTHOR;
}
