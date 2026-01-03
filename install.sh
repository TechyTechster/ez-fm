#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${REPO_URL:-https://github.com/TechyTechster/ez-fm.git}"
REPO_REF="${REPO_REF:-main}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/ez-fm-build}"
APP_PATH_OVERRIDE="${APP_PATH:-}"

APP_PATH=""
NODE_BIN=""
ELECTRON_BIN=""

print_header() {
  echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║            EZ File Manager Installer                    ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo -e "${RED}✗ Missing command: $1${NC}"
    exit 1
  fi
}

resolve_bins() {
  NODE_BIN="$(command -v node || true)"
  ELECTRON_BIN="$(command -v electron || true)"
}

resolve_app_path() {
  if [ -n "$APP_PATH_OVERRIDE" ]; then
    APP_PATH="$APP_PATH_OVERRIDE"
  elif [ -d /usr/share/ez-fm ]; then
    APP_PATH="/usr/share/ez-fm"
  else
    APP_PATH="$SCRIPT_DIR"
  fi
  APP_PATH="$(realpath "$APP_PATH")"
}

check_picker_deps() {
  local missing=()
  for dep in electron node npm; do
    if ! command -v "$dep" >/dev/null 2>&1; then
      missing+=("$dep")
    fi
  done
  if [ ${#missing[@]} -ne 0 ]; then
    echo -e "${RED}✗ Missing dependencies: ${missing[*]}${NC}"
    echo "Install with: sudo pacman -S electron nodejs npm"
    exit 1
  fi
}

ensure_dbus_next() {
  if ! (cd "$APP_PATH" && node -e "require('dbus-next')" 2>/dev/null); then
    if [ -w "$APP_PATH" ]; then
      echo -e "${YELLOW}⚠ dbus-next not installed${NC}"
      echo "Installing dbus-next..."
      (cd "$APP_PATH" && npm install --omit=dev dbus-next)
    else
      echo -e "${RED}✗ dbus-next missing in $APP_PATH and path is not writable${NC}"
      echo "Reinstall the package or set APP_PATH to a writable copy."
      exit 1
    fi
  fi
}

check_hyprland() {
  if [[ "$XDG_CURRENT_DESKTOP" != *"Hyprland"* ]]; then
    echo -e "${YELLOW}⚠ Not running on Hyprland${NC}"
    echo "This integration is tuned for Hyprland but may work elsewhere."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  fi
}

install_file_manager() {
  echo -e "${BLUE}→ Installing file manager...${NC}"
  need_cmd git
  need_cmd makepkg
  need_cmd sudo

  mkdir -p "$(dirname "$BUILD_DIR")"

  if [ -d "$BUILD_DIR/.git" ]; then
    git -C "$BUILD_DIR" fetch --all --prune
    if git -C "$BUILD_DIR" rev-parse --verify "origin/$REPO_REF" >/dev/null 2>&1; then
      git -C "$BUILD_DIR" reset --hard "origin/$REPO_REF"
    else
      git -C "$BUILD_DIR" reset --hard HEAD
    fi
  else
    rm -rf "$BUILD_DIR"
    git clone "$REPO_URL" "$BUILD_DIR"
    if [ -n "$REPO_REF" ]; then
      git -C "$BUILD_DIR" checkout "$REPO_REF" || true
    fi
  fi

  if [ ! -d "$BUILD_DIR/packaging/aur" ]; then
    echo -e "${RED}✗ Packaging files not found in $BUILD_DIR${NC}"
    exit 1
  fi

  (cd "$BUILD_DIR/packaging/aur" && makepkg -si)
  echo -e "${GREEN}✓ File manager installed${NC}"
}

install_zenity_wrapper() {
  need_cmd sudo
  if [ ! -f /usr/bin/zenity ] && [ ! -f /usr/bin/zenity.real ]; then
    echo -e "${RED}✗ zenity not found at /usr/bin/zenity${NC}"
    echo "Install zenity first, then rerun this installer."
    exit 1
  fi

  if [ -f /usr/bin/zenity ] && [ ! -f /usr/bin/zenity.real ]; then
    echo "Backing up original zenity..."
    sudo mv /usr/bin/zenity /usr/bin/zenity.real
    echo -e "${GREEN}✓ Backup created: /usr/bin/zenity.real${NC}"
  fi

  sudo sed \
    -e "s|@APP_PATH@|$APP_PATH|g" \
    -e "s|@ELECTRON_BIN@|$ELECTRON_BIN|g" \
    "$SCRIPT_DIR/zenity-wrapper.sh" > /tmp/zenity-wrapper
  sudo cp /tmp/zenity-wrapper /usr/bin/zenity
  rm -f /tmp/zenity-wrapper
  sudo chmod +x /usr/bin/zenity
  echo -e "${GREEN}✓ Zenity wrapper installed${NC}"

  if zenity --version &>/dev/null; then
    echo -e "${GREEN}✓ Zenity wrapper working${NC}"
  else
    echo -e "${YELLOW}⚠ Zenity wrapper may not be working correctly${NC}"
  fi
}

install_portal_backend() {
  need_cmd sudo
  need_cmd systemctl

  check_hyprland
  ensure_dbus_next

  local src_portal="$SCRIPT_DIR/portal-service.js"
  local dest_portal="$APP_PATH/portal-service.js"

  if [ ! -f "$dest_portal" ]; then
    if [ ! -f "$src_portal" ]; then
      echo -e "${RED}✗ portal-service.js not found${NC}"
      exit 1
    fi
    sudo cp "$src_portal" "$dest_portal"
  fi
  sudo chmod +x "$dest_portal"
  echo -e "${GREEN}✓ Portal service installed${NC}"

  mkdir -p ~/.config/systemd/user
  sed \
    -e "s|@APP_PATH@|$APP_PATH|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@ELECTRON_BIN@|$ELECTRON_BIN|g" \
    "$SCRIPT_DIR/myfm-portal.service" > ~/.config/systemd/user/myfm-portal.service
  echo -e "${GREEN}✓ Systemd service installed${NC}"

  sudo mkdir -p /usr/share/xdg-desktop-portal/portals
  sudo cp "$SCRIPT_DIR/myfm.portal" /usr/share/xdg-desktop-portal/portals/myfm.portal
  echo -e "${GREEN}✓ Portal registered${NC}"

  systemctl --user daemon-reload
  systemctl --user enable --now myfm-portal.service

  sleep 2
  if systemctl --user is-active --quiet myfm-portal.service; then
    echo -e "${GREEN}✓ Portal service running${NC}"
  else
    echo -e "${YELLOW}⚠ Portal service may have failed to start${NC}"
    echo "Check logs with: journalctl --user -u myfm-portal.service"
  fi

  systemctl --user restart xdg-desktop-portal.service
  systemctl --user restart xdg-desktop-portal-hyprland.service 2>/dev/null || true
  echo -e "${GREEN}✓ Portals restarted${NC}"
}

install_picker_menu() {
  resolve_app_path
  resolve_bins
  check_picker_deps

  if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}✗ File manager not found at $APP_PATH${NC}"
    echo "Set APP_PATH or install the file manager first."
    exit 1
  fi

  echo -e "${BLUE}Select picker integration:${NC}"
  echo "  1) Zenity wrapper only"
  echo "  2) Portal backend only"
  echo "  3) Both"
  echo ""
  read -p "Choice [1-3]: " picker_choice

  case $picker_choice in
    1)
      install_zenity_wrapper
      ;;
    2)
      install_portal_backend
      ;;
    3)
      install_zenity_wrapper
      install_portal_backend
      ;;
    *)
      echo -e "${RED}✗ Invalid choice${NC}"
      exit 1
      ;;
  esac
}

uninstall_picker() {
  need_cmd sudo

  if [ -f /usr/bin/zenity.real ]; then
    sudo rm -f /usr/bin/zenity
    sudo mv /usr/bin/zenity.real /usr/bin/zenity
    echo -e "${GREEN}✓ Zenity wrapper removed${NC}"
  fi

  systemctl --user stop myfm-portal.service 2>/dev/null || true
  systemctl --user disable myfm-portal.service 2>/dev/null || true
  rm -f ~/.config/systemd/user/myfm-portal.service
  sudo rm -f /usr/share/xdg-desktop-portal/portals/myfm.portal

  systemctl --user daemon-reload
  systemctl --user restart xdg-desktop-portal.service

  echo -e "${GREEN}✓ Picker integration removed${NC}"
}

print_header

echo -e "${BLUE}Select install type:${NC}"
echo "  1) File manager (build & install package)"
echo "  2) File picker integration"
echo "  3) Both"
echo "  4) Uninstall picker integration"
echo ""
read -p "Choice [1-4]: " choice

case $choice in
  1)
    install_file_manager
    ;;
  2)
    install_picker_menu
    ;;
  3)
    install_file_manager
    install_picker_menu
    ;;
  4)
    uninstall_picker
    exit 0
    ;;
  *)
    echo -e "${RED}✗ Invalid choice${NC}"
    exit 1
    ;;
esac

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Installation Complete!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

resolve_app_path
resolve_bins

if [ -d "$APP_PATH" ] && [ -n "$ELECTRON_BIN" ]; then
  echo -e "${BLUE}Testing:${NC}"
  echo "  $ELECTRON_BIN \"$APP_PATH\" --picker --mode=open"
  echo ""
fi

echo -e "${BLUE}Optional tools:${NC}"
echo "  - p7zip (7z), unzip, zip, tar, gzip, bzip2, xz: archive support"
echo "  - ffmpeg/ffprobe: video metadata in preview"
echo "  - udisks2 (udisksctl), gio, lsblk: drive mount/unmount + detection"
echo "  - zenity: zenity wrapper integration"
echo "  - xdg-desktop-portal + compositor portal: portal picker"
echo "  - kitty/gnome-terminal/x-terminal-emulator: Open in Terminal"
echo ""

echo -e "${YELLOW}Note: Some apps may need restart to detect the new picker${NC}"
