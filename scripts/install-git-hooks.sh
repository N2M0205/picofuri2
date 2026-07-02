#!/usr/bin/env bash
# ピコフリ2 gitフック導入スクリプト
#
# 目的: .git/hooks/ 配下のフックは git 管理外のため、リポジトリ再clone/VPS再構築時に
#       同じフックを復元できるよう、フック内容をここに集約して再導入する。
#
# 使い方:
#   cd <picofuri2リポジトリrootディレクトリ>
#   bash scripts/install-git-hooks.sh
#
# 効果:
#   - .git/hooks/pre-commit : main への直接コミットを拒否
#   - .git/hooks/pre-push   : main への push は OWNER_APPROVED=1 が必要

set -euo pipefail

# リポジトリrootでの実行を強制
if [ ! -d ".git" ]; then
  echo "❌ .git ディレクトリが見つかりません。リポジトリrootで実行してください。"
  exit 1
fi

HOOK_DIR=".git/hooks"
mkdir -p "$HOOK_DIR"

# ---------- pre-commit ----------
cat > "$HOOK_DIR/pre-commit" <<'HOOK_EOF'
#!/usr/bin/env bash
# ピコフリ2 pre-commit hook: main への直接コミットを拒否
# 導入: scripts/install-git-hooks.sh から再導入可能

set -euo pipefail

current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

if [ "$current_branch" = "main" ]; then
  echo ""
  echo "❌ [pre-commit] mainへの直接コミットは禁止。ブランチを切ってください"
  echo ""
  echo "  例: git checkout -b feat/xxx"
  echo ""
  exit 1
fi

exit 0
HOOK_EOF

# ---------- pre-push ----------
cat > "$HOOK_DIR/pre-push" <<'HOOK_EOF'
#!/usr/bin/env bash
# ピコフリ2 pre-push hook: main への push はオーナー承認（OWNER_APPROVED=1）が必要
# 導入: scripts/install-git-hooks.sh から再導入可能
#
# git は push の対象 ref 一覧を stdin で渡してくる:
#   <local ref> <local sha1> <remote ref> <remote sha1>

set -euo pipefail

while read -r local_ref local_sha remote_ref remote_sha; do
  # 削除push（local_sha == 0000...）は対象外
  zero="0000000000000000000000000000000000000000"
  if [ "$local_sha" = "$zero" ]; then
    continue
  fi

  if [ "$remote_ref" = "refs/heads/main" ]; then
    if [ "${OWNER_APPROVED:-}" != "1" ]; then
      echo ""
      echo "❌ [pre-push] mainへのpushはオーナー承認後、OWNER_APPROVED=1 を付けて実行してください"
      echo ""
      echo "  例: OWNER_APPROVED=1 git push origin main"
      echo ""
      exit 1
    fi
    echo "✅ [pre-push] OWNER_APPROVED=1 検出。main への push を許可します"
  fi
done

exit 0
HOOK_EOF

chmod +x "$HOOK_DIR/pre-commit" "$HOOK_DIR/pre-push"

echo "✅ gitフック導入完了:"
echo "  - $HOOK_DIR/pre-commit （main直接commit禁止）"
echo "  - $HOOK_DIR/pre-push   （main push は OWNER_APPROVED=1 必須）"
