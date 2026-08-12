#!/usr/bin/env bash
# Enforces the pure-core constraint in src/raft/.
# Exit 2 so Claude Code surfaces stderr to the model. Exit 1 would be silent.

set -uo pipefail

payload=$(cat)
file=$(printf '%s' "$payload" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//; s/"$//')

[ -z "$file" ] && exit 0
case "$file" in
  *"/src/raft/"*) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
case "$file" in *.test.ts|*.spec.ts) exit 0 ;; esac

violations=""
check() {
  if grep -nE "$1" "$file" >/dev/null 2>&1; then
    violations="${violations}
  [$2]
$(grep -nE "$1" "$file" | head -3 | sed 's/^/    /')"
  fi
}

check '\bsetTimeout\b|\bsetInterval\b|requestAnimationFrame' 'timer in pure core'
check 'Date\.now|performance\.now|new Date\(' 'wall-clock read in pure core'
check 'Math\.random' 'unseeded randomness in pure core'
check '\bfetch\(|WebSocket|XMLHttpRequest|localStorage' 'I/O in pure core'
check "from ['\"][^'\"]*\.\./ui|from ['\"]react|from ['\"][^'\"]*\.\./sim" 'core importing outward'

if [ -n "$violations" ]; then
  cat >&2 <<EOF
CORE PURITY VIOLATION in $file
$violations

src/raft/ must be a pure function with no I/O. Time enters as a TickEvent;
randomness comes from the seeded PRNG passed in by the driver. Dependency
direction is one-way: ui -> sim -> raft.

Fix the code. Do not suppress this check.
EOF
  exit 2
fi

if command -v npx >/dev/null 2>&1 && [ -f "package.json" ]; then
  if ! npx --no-install vitest run src/raft --silent >/tmp/homonoia-core.log 2>&1; then
    echo "Core tests failing after edit to $file:" >&2
    tail -30 /tmp/homonoia-core.log >&2
    exit 2
  fi
fi

exit 0
