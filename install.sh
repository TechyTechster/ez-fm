#!/bin/bash
# Installation script for Custom File Manager System Picker
# For Arch Linux + Hyprland
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

APP_PATH="/home/tomiwaf/.local/share/transparent-file-manager"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Custom File Manager → System Picker Integration      ║${NC}"
echo -e "${BLUE}║  For Arch Linux + Hyprland                             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running on Hyprland
if [[ "$XDG_CURRENT_DESKTOP" != *"Hyprland"* ]]; then
    echo -e "${YELLOW}⚠ Warning: Not running on Hyprland${NC}"
    echo "This installation is optimized for Hyprland but may work on other Wayland compositors."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if file manager exists
if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}✗ Error: File manager not found at $APP_PATH${NC}"
    echo "Please update APP_PATH in this script."
    exit 1
fi

# Check dependencies
echo -e "${BLUE}→ Checking dependencies...${NC}"
missing_deps=()

for dep in electron node npm; do
    if ! command -v $dep &> /dev/null; then
        missing_deps+=($dep)
    fi
done

if [ ${#missing_deps[@]} -ne 0 ]; then
    echo -e "${RED}✗ Missing dependencies: ${missing_deps[*]}${NC}"
    echo "Install with: sudo pacman -S electron nodejs npm"
    exit 1
fi

# Check if dbus-next is installed
if ! node -e "require('dbus-next')" 2>/dev/null; then
    echo -e "${YELLOW}⚠ dbus-next not installed${NC}"
    echo "Installing dbus-next..."
    cd "$APP_PATH"
    npm install dbus-next
fi

echo -e "${GREEN}✓ All dependencies satisfied${NC}"
echo ""

# Installation options menu
echo -e "${BLUE}Select installation level:${NC}"
echo "  1) Zenity wrapper only (instant, ~60% coverage)"
echo "  2) Full portal integration (best, all Wayland apps)"
echo "  3) Both (recommended)"
echo "  4) Uninstall"
echo ""
read -p "Choice [1-4]: " choice

case $choice in
    1|3)
        echo ""
        echo -e "${BLUE}→ Installing Zenity wrapper...${NC}"
        
        # Backup original zenity
        if [ -f /usr/bin/zenity ] && [ ! -f /usr/bin/zenity.real ]; then
            echo "Backing up original zenity..."
            sudo mv /usr/bin/zenity /usr/bin/zenity.real
            echo -e "${GREEN}✓ Backup created: /usr/bin/zenity.real${NC}"
        fi
        
        # Install wrapper
        sudo cp "$SCRIPT_DIR/zenity-wrapper.sh" /usr/bin/zenity
        sudo chmod +x /usr/bin/zenity
        echo -e "${GREEN}✓ Zenity wrapper installed${NC}"
        
        # Test
        if zenity --version &>/dev/null; then
            echo -e "${GREEN}✓ Zenity wrapper working${NC}"
        else
            echo -e "${YELLOW}⚠ Warning: Zenity wrapper may not be working correctly${NC}"
        fi
        echo ""
        ;;&
    
    2|3)
        echo ""
        echo -e "${BLUE}→ Installing Portal backend...${NC}"
        
        # Copy portal service script
        cp "$SCRIPT_DIR/portal-service.js" "$APP_PATH/portal-service.js"
        chmod +x "$APP_PATH/portal-service.js"
        echo -e "${GREEN}✓ Portal service installed${NC}"
        
        # Install systemd user service
        mkdir -p ~/.config/systemd/user
        sed "s|/home/tomiwaf/file manager|$APP_PATH|g" "$SCRIPT_DIR/myfm-portal.service" > ~/.config/systemd/user/myfm-portal.service
        echo -e "${GREEN}✓ Systemd service installed${NC}"
        
        # Install portal registration
        sudo mkdir -p /usr/share/xdg-desktop-portal/portals
        sudo cp "$SCRIPT_DIR/myfm.portal" /usr/share/xdg-desktop-portal/portals/myfm.portal
        echo -e "${GREEN}✓ Portal registered${NC}"
        
        # Reload systemd and portals
        echo ""
        echo -e "${BLUE}→ Activating portal...${NC}"
        systemctl --user daemon-reload
        systemctl --user enable --now myfm-portal.service
        
        # Wait a moment for service to start
        sleep 2
        
        if systemctl --user is-active --quiet myfm-portal.service; then
            echo -e "${GREEN}✓ Portal service running${NC}"
        else
            echo -e "${YELLOW}⚠ Portal service may have failed to start${NC}"
            echo "Check logs with: journalctl --user -u myfm-portal.service"
        fi
        
        # Restart xdg-desktop-portal
        systemctl --user restart xdg-desktop-portal.service
        systemctl --user restart xdg-desktop-portal-hyprland.service 2>/dev/null || true
        
        echo -e "${GREEN}✓ Portals restarted${NC}"
        echo ""
        ;;&
    
    4)
        echo ""
        echo -e "${BLUE}→ Uninstalling...${NC}"
        
        # Remove zenity wrapper
        if [ -f /usr/bin/zenity.real ]; then
            sudo rm -f /usr/bin/zenity
            sudo mv /usr/bin/zenity.real /usr/bin/zenity
            echo -e "${GREEN}✓ Zenity wrapper removed${NC}"
        fi
        
        # Remove portal
        systemctl --user stop myfm-portal.service 2>/dev/null || true
        systemctl --user disable myfm-portal.service 2>/dev/null || true
        rm -f ~/.config/systemd/user/myfm-portal.service
        sudo rm -f /usr/share/xdg-desktop-portal/portals/myfm.portal
        rm -f "$APP_PATH/portal-service.js"
        
        systemctl --user daemon-reload
        systemctl --user restart xdg-desktop-portal.service
        
        echo -e "${GREEN}✓ Uninstallation complete${NC}"
        exit 0
        ;;
    
    *)
        echo -e "${RED}✗ Invalid choice${NC}"
        exit 1
        ;;
esac

# Final status
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Installation Complete!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

if [[ $choice == 1 || $choice == 3 ]]; then
    echo -e "${BLUE}Zenity Integration:${NC}"
    echo "  ✓ GTK apps using zenity will now use your file manager"
    echo "  Test: zenity --file-selection"
    echo ""
fi

if [[ $choice == 2 || $choice == 3 ]]; then
    echo -e "${BLUE}Portal Integration:${NC}"
    echo "  ✓ Wayland apps will now use your file manager"
    echo "  Test: GTK_USE_PORTAL=1 firefox"
    echo ""
    echo -e "${BLUE}Troubleshooting:${NC}"
    echo "  • Check service: systemctl --user status myfm-portal"
    echo "  • View logs: journalctl --user -u myfm-portal -f"
    echo "  • Test DBus: busctl --user list | grep myfm"
    echo ""
fi

echo -e "${BLUE}Testing:${NC}"
echo "  npx electron \"$APP_PATH\" --picker --mode=open"
echo ""

echo -e "${YELLOW}Note: Some apps may need restart to detect the new picker${NC}"
