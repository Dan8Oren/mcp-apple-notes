#!/usr/bin/env bash
set -e

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Config ───────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/Dan8Oren/mcp-apple-notes.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.mcp-servers/mcp-apple-notes}"

# ─── Helpers ──────────────────────────────────────────────────────────────────
info()    { printf "${BLUE}▸${RESET} %s\n" "$1"; }
success() { printf "${GREEN}✔${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
error()   { printf "${RED}✖${RESET} %s\n" "$1" >&2; }
header()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }

# ─── Prerequisites ────────────────────────────────────────────────────────────
header "MCP Apple Notes — Installer"

if [[ "$(uname)" != "Darwin" ]]; then
  error "This tool requires macOS (Apple Notes is only available on macOS)."
  exit 1
fi

HAS_BUN=false
HAS_NODE=false

if command -v bun &>/dev/null; then
  HAS_BUN=true
  success "Found bun $(bun --version)"
fi

if command -v node &>/dev/null; then
  HAS_NODE=true
  success "Found node $(node --version)"
fi

if ! $HAS_BUN && ! $HAS_NODE; then
  error "Node.js or Bun is required but neither was found."
  echo "  Install Node.js: https://nodejs.org"
  echo "  Install Bun:     curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ─── Clone or Update ─────────────────────────────────────────────────────────
header "Installing to $INSTALL_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing installation found — pulling latest…"
  git -C "$INSTALL_DIR" pull --ff-only || {
    warn "Fast-forward pull failed. You may have local changes."
    warn "Skipping update — using existing version."
  }
else
  info "Cloning repository…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

success "Source ready at $INSTALL_DIR"

# ─── Install Dependencies ────────────────────────────────────────────────────
header "Installing dependencies"

cd "$INSTALL_DIR"

if $HAS_BUN; then
  info "Using bun…"
  bun install
else
  info "Using npm…"
  npm install
fi

success "Dependencies installed"

# ─── Build MCP config snippet ────────────────────────────────────────────────
if $HAS_BUN; then
  SERVER_CMD="bun"
  SERVER_ARGS="[\"run\", \"$INSTALL_DIR/index.ts\"]"
else
  SERVER_CMD="npx"
  SERVER_ARGS="[\"tsx\", \"$INSTALL_DIR/index.ts\"]"
fi

MCP_SNIPPET=$(cat <<EOF
{
  "mcpServers": {
    "apple-notes": {
      "command": "$SERVER_CMD",
      "args": $SERVER_ARGS
    }
  }
}
EOF
)

# ─── Done ─────────────────────────────────────────────────────────────────────
header "Installation complete!"

echo ""
success "Server installed at: $INSTALL_DIR"
echo ""
info "Add this to your MCP client config:"
echo ""
printf "${DIM}%s${RESET}\n" "$MCP_SNIPPET"
echo ""

# Copy to clipboard
echo "$MCP_SNIPPET" | pbcopy
success "Copied to clipboard"

echo ""
info "Paste it into your client's MCP config, restart the client,"
info "and ask your AI assistant to ${BOLD}\"index my notes\"${RESET} to get started."
echo ""
