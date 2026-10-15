#!/usr/bin/env bash
# Find Syncthing conflict copies, back them up, and show what each one differs in.
# Read-only for the vault: deletes and merges are left to the agent.
#
# usage: bash scan.sh [all] [--backup DIR]
#   (no arg) - the vault containing the current directory (git toplevel, else cwd)
#   all      - every `vault` path from $VAULTS_CONFIG (default ~/.claude/vaults-config.md)
#   --backup - where to copy conflict files before anything is deleted
#              (default: a fresh mktemp -d)
set -uo pipefail

MODE=current
BACKUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    all) MODE=all ;;
    --backup) BACKUP="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

CONFIG="${VAULTS_CONFIG:-$HOME/.claude/vaults-config.md}"
MAX_DIFF_LINES="${MAX_DIFF_LINES:-80}"

vaults=()
if [[ "$MODE" == all ]]; then
  if [[ ! -f "$CONFIG" ]]; then
    echo "no $CONFIG - scanning the current vault only" >&2
    MODE=current
  else
    # lines like: - `vault`: `/path/to/vault`
    while IFS= read -r p; do
      [[ -d "$p" ]] && vaults+=("$p") || echo "skip missing vault: $p" >&2
    done < <(sed -nE 's/^- `vault`: `([^`]+)`.*/\1/p' "$CONFIG")
  fi
fi
if [[ "$MODE" == current ]]; then
  vaults+=("$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
fi

[[ -z "$BACKUP" ]] && BACKUP="$(mktemp -d)"
mkdir -p "$BACKUP"

# GNU and BSD date both support -r <file>
mtime() { date -r "$1" '+%F %T'; }

total=0
for v in "${vaults[@]}"; do
  echo "######## vault: $v"
  copies=()
  while IFS= read -r -d '' f; do copies+=("$f"); done \
    < <(find "$v" -path "$v/.git" -prune -o -name '*.sync-conflict-*' -type f -print0 | sort -z)
  markers=$(grep -rlE --include='*.md' --exclude-dir=.git '^(<<<<<<<|>>>>>>>) ' "$v" 2>/dev/null)
  [[ -n "$markers" ]] && { echo "git conflict markers in:"; echo "$markers" | sed 's/^/  /'; }
  if [[ ${#copies[@]} -eq 0 ]]; then echo "no conflict copies"; continue; fi

  # sorted, so copies of one original are adjacent
  prev_orig=""; prev_first=""
  for c in "${copies[@]}"; do
    total=$((total + 1))
    rel="${c#$v/}"
    orig="$(echo "$c" | sed -E 's/\.sync-conflict-[0-9]{8}-[0-9]{6}-[A-Z0-9]{7}//')"
    dev="$(echo "$c" | grep -oE 'sync-conflict-[0-9]{8}-[0-9]{6}-[A-Z0-9]{7}' | cut -d- -f5)"
    mkdir -p "$BACKUP/$(basename "$v")/$(dirname "$rel")"
    cp -p "$c" "$BACKUP/$(basename "$v")/$rel"

    echo
    echo "=== $rel"
    echo "device: $dev | copy mtime: $(mtime "$c")"
    case "$rel" in .obsidian/*|*/.obsidian/*) echo "kind: obsidian-ui-state" ;; esac
    if [[ ! -f "$orig" ]]; then
      echo "verdict: ORIGINAL MISSING (${orig#$v/})"
      continue
    fi
    echo "original mtime: $(mtime "$orig")"
    if cmp -s "$c" "$orig"; then echo "verdict: IDENTICAL to original"; continue; fi
    if [[ "$orig" == "$prev_orig" ]] && cmp -s "$c" "$prev_first"; then
      echo "verdict: DUPLICATE of ${prev_first#$v/}"; continue
    fi
    prev_orig="$orig"; prev_first="$c"
    echo "verdict: DIFFERS (- original, + copy)"
    /usr/bin/diff -u "$orig" "$c" | tail -n +3 | head -n "$MAX_DIFF_LINES"
  done
done

echo
echo "conflict copies: $total | backup: $BACKUP"
