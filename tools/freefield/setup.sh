#!/usr/bin/env bash
# Installs Freefield (github.com/neuregex/freefield) into .freefield/ so the
# "freefield" MCP server in .mcp.json can use it. Safe to run repeatedly.
#   FREEFIELD_DIR  where to install (default: <repo>/.freefield)
#   FREEFIELD_REF  branch or tag to check out (default: the repo's default branch)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="${FREEFIELD_DIR:-$repo_root/.freefield}"
url="https://github.com/neuregex/freefield"

if [ ! -d "$dir/.git" ]; then
  echo "freefield: cloning into $dir" >&2
  args=(--depth 1)
  [ -n "${FREEFIELD_REF:-}" ] && args+=(--branch "$FREEFIELD_REF")
  GIT_LFS_SKIP_SMUDGE=1 git clone "${args[@]}" "$url" "$dir" >&2
fi

if [ ! -d "$dir/node_modules/@comfyorg/sdk" ]; then
  echo "freefield: installing npm packages" >&2
  (cd "$dir" && npm install --no-audit --no-fund >&2)
fi

# a local .env with a gateway token; COMFY_BASE_URL still has to point at a GPU backend
if [ ! -f "$dir/.env" ] && command -v python3 >/dev/null; then
  (cd "$dir" && python3 tools/setup_token.py --env-only >/dev/null 2>&1) || true
fi

echo "freefield: ready in $dir" >&2
