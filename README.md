# EZ File Manager

A modern, lightweight file manager for Linux featuring a transparent glassmorphism UI and native XDG Desktop Portal integration.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)
![Electron](https://img.shields.io/badge/electron-28.0.0-47848F.svg)

<!-- Add screenshot here -->
<!-- ![Screenshot](screenshots/main.png) -->

## Features

- **Glassmorphism UI** - Transparent, frosted-glass design that blends with your desktop
- **Multiple View Modes** - Detailed list, compact list, grid, and thumbnail views
- **Tab Support** - Multi-tab browsing with drag-and-drop between tabs
- **Smart Sorting** - Sort by name, date modified, date added, size, or type
- **Grouping** - Group files by type, date, or size with collapsible sections
- **Per-Folder Settings** - View preferences saved per directory
- **Quick Access Sidebar** - Pinned folders and tag-based organization
- **File Tagging** - Color-coded tags for file organization
- **Preview Panel** - Built-in preview for images, videos, and text files
- **Archive Support** - Browse inside zip, tar, 7z, and other archives
- **XDG Portal Integration** - Acts as system file picker for all applications
- **Keyboard Navigation** - Full keyboard support with familiar shortcuts
- **Memory Optimized** - Virtual scrolling and lazy loading for large directories

## Installation

### Prerequisites

```bash
# Arch Linux
sudo pacman -S nodejs npm electron

# Ubuntu/Debian
sudo apt install nodejs npm
```

### Quick Start

```bash
# Clone the repository
git clone https://github.com/TechyTechster/ez-fm.git
cd ez-fm

# Install dependencies
npm install

# Run
npm start
```

### System Integration (Optional)

To use EZ File Manager as your system-wide file picker:

```bash
./install.sh
```

This integrates with XDG Desktop Portal so applications like Firefox, Chrome, and other GTK/Qt apps use EZ File Manager for file dialogs.

## Usage

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+L` | Focus path bar |
| `Ctrl+F` | Search |
| `Ctrl+H` | Toggle hidden files |
| `Ctrl+C` | Copy |
| `Ctrl+X` | Cut |
| `Ctrl+V` | Paste |
| `Delete` | Move to trash |
| `Shift+Delete` | Permanent delete |
| `F2` | Rename |
| `Backspace` | Go up |
| `Enter` | Open selected |
| `Ctrl+A` | Select all |

### Command Line

```bash
# Open specific directory
npm start -- /path/to/directory

# File picker mode
npm start -- --picker --mode=open
npm start -- --picker --mode=save --filename=document.txt
npm start -- --picker --mode=directory
```

## Configuration

View settings are automatically saved per-folder. Global preferences are stored in your browser's localStorage.

### Hyprland Integration

Add to `~/.config/hypr/hyprland.conf`:

```conf
# Float file picker dialogs
windowrulev2 = float, title:^(Open File|Save File|Select Folder)$
windowrulev2 = center, title:^(Open File|Save File|Select Folder)$
windowrulev2 = size 1000 700, title:^(Open File|Save File|Select Folder)$
```

## Architecture

```
ez-fm/
├── main.js           # Electron main process
├── renderer.js       # UI logic and file operations
├── preload.js        # IPC bridge
├── portal-service.js # XDG Desktop Portal backend
├── index.html        # Application markup
├── styles.css        # UI styling
└── install.sh        # System integration installer
```

## Building

```bash
# Development with logging
npm run dev

# Build for distribution (requires electron-builder)
npm run build
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Portal service issues

```bash
# Check service status
systemctl --user status myfm-portal

# View logs
journalctl --user -u myfm-portal -f

# Restart portals
systemctl --user restart xdg-desktop-portal
```

### Application not using EZ File Manager as picker

Some applications cache portal connections. Try:
1. Restart the application
2. Restart xdg-desktop-portal: `systemctl --user restart xdg-desktop-portal`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- Uses [dbus-next](https://github.com/dbusjs/node-dbus-next) for portal integration
- Inspired by modern macOS Finder aesthetics
