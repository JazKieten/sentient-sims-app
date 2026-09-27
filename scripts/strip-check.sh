#!/usr/bin/env bash
# Local strip check: does the COMMITTED tree still build as <tier> once the tier's
# stripped paths are gone? CI runs the same steps (.github/workflows/strip-check.yml).
#
#   scripts/strip-check.sh core|stream [--keep]
#
# Works on a throwaway git worktree of HEAD, so uncommitted edits are not part of the
# check and your working tree is never touched. node_modules and release/app/node_modules
# are linked in (a junction on Windows). The links are removed BEFORE the worktree is:
# `git worktree remove` on a tree with a live junction deletes through it.
set -euo pipefail

tier="${1:-}"
if [[ "$tier" != "core" && "$tier" != "stream" ]]; then
  echo "usage: scripts/strip-check.sh core|stream [--keep]" >&2
  exit 2
fi
keep="${2:-}"

repo="$(git rev-parse --show-toplevel)"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ss-strip-${tier}-$$"

is_windows() {
  [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]
}

make_link() {
  if is_windows; then
    cmd //c mklink /J "$(cygpath -w "$2")" "$(cygpath -w "$1")" >/dev/null
  else
    ln -s "$1" "$2"
  fi
}

drop_link() {
  if [[ -e "$1" || -L "$1" ]]; then
    if is_windows; then
      cmd //c rmdir "$(cygpath -w "$1")"
    else
      rm "$1"
    fi
  fi
}

cleanup() {
  drop_link "$work/release/app/node_modules"
  drop_link "$work/node_modules"
  if [[ "$keep" == "--keep" ]]; then
    echo "kept worktree at $work (links removed; remove it with: git worktree remove --force $work)"
  else
    git -C "$repo" worktree remove --force "$work"
  fi
}

git -C "$repo" worktree add --detach "$work" HEAD >/dev/null
trap cleanup EXIT

make_link "$repo/node_modules" "$work/node_modules"
make_link "$repo/release/app/node_modules" "$work/release/app/node_modules"

cd "$work"
# Node 24 (.nvmrc) runs .ts directly; the flag keeps Node 22 working too
node_ts=(node --experimental-strip-types --disable-warning=ExperimentalWarning)

echo "== strip ($tier)"
"${node_ts[@]}" scripts/strip-tree.ts --tier "$tier" --yes
echo "== compile"
npm run compile
echo "== unit tests"
npm run test:unit
echo "== build"
npm run build
echo "== verify build"
"${node_ts[@]}" scripts/verify-build.ts --tier "$tier"
echo "strip check $tier: ok"
