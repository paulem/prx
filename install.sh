#!/usr/bin/env bash
# Installs prx from this checkout: builds the bundle, copies it to ~/.local/bin/prx and,
# unless ~/.local/bin is already on PATH or --no-modify-path is given, exports it from .zshrc
# inside a marked block that prx uninstall removes. Never prompts; re-run to upgrade
set -euo pipefail

MINIMUM_NODE_MAJOR=24
BIN_DIR="$HOME/.local/bin"
BINARY="$BIN_DIR/prx"
ZSHRC="$HOME/.zshrc"
PATH_BLOCK_START='# >>> prx >>>'
PATH_BLOCK_END='# <<< prx <<<'

usage() {
  echo "Usage: ./install.sh [--no-modify-path]" >&2
}

modify_path=true
for arg in "$@"; do
  case "$arg" in
    --no-modify-path) modify_path=false ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option '$arg'" >&2
      usage
      exit 2
      ;;
  esac
done

if ! command -v node > /dev/null; then
  echo "prx needs Node $MINIMUM_NODE_MAJOR or newer, but no node command was found on PATH" >&2
  exit 1
fi
node_version="$(node --version)"
node_version="${node_version#v}"
node_major="${node_version%%.*}"
if [ "$node_major" -lt "$MINIMUM_NODE_MAJOR" ]; then
  echo "prx needs Node $MINIMUM_NODE_MAJOR or newer, found $node_version" >&2
  exit 1
fi
if ! command -v pnpm > /dev/null; then
  echo "prx is built with pnpm, but no pnpm command was found on PATH" >&2
  exit 1
fi

cd "$(dirname "$0")"
pnpm install --frozen-lockfile --silent
pnpm --silent build > /dev/null

install -d "$BIN_DIR"
install -m 755 dist/prx.js "$BINARY"
echo "Installed prx to $BINARY"

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

has_path_block() {
  [ -f "$ZSHRC" ] && grep -qxF "$PATH_BLOCK_START" "$ZSHRC"
}

if on_path || has_path_block; then
  exit 0
fi
if [ "$modify_path" = false ]; then
  echo "$BIN_DIR is not on PATH, add it yourself to use prx"
  exit 0
fi

# The literal $HOME keeps .zshrc portable; the blank line before the block goes with it on uninstall
printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n%s\n' "$PATH_BLOCK_START" "$PATH_BLOCK_END" >> "$ZSHRC"
echo "Added $BIN_DIR to PATH in $ZSHRC, open a new shell to use prx"
