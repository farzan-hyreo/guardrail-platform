#!/usr/bin/env bash
# SOT: sot-script, grep-first, find-source-of-truth
# WHAT   Finds the file that owns a concept without reading any file.
# WHY    Reading files to locate a concept is what fills a context window. This returns
#        paths only: a handful of tokens instead of a few thousand.
# HOW    pnpm sot permissions   -> files whose SOT header claims that keyword
#        pnpm sot:map           -> every concept in the repo
set -euo pipefail

if [ "${1:-}" = "--map" ]; then
  grep -rh --include='*.ts' --include='*.tsx' ' SOT: ' apps packages services tools scripts \
    | sed 's/^[[:space:]]*\*[[:space:]]*SOT:[[:space:]]*//' | sort -u
  exit 0
fi

query="${1:-}"
if [ -z "$query" ]; then
  echo "usage: pnpm sot <keyword>   |   pnpm sot:map"
  exit 1
fi

matches=$(grep -rl --include='*.ts' --include='*.tsx' -i "SOT:.*${query}" apps packages services tools scripts || true)

if [ -z "$matches" ]; then
  echo "No source-of-truth file claims '${query}'. Closest files mentioning it:"
  grep -rl --include='*.ts' --include='*.tsx' -i "$query" apps packages services tools scripts | head -20 || true
  exit 0
fi

echo "$matches" | sort
