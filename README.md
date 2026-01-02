# EZ File Manager

A lightweight Linux file manager with a transparent UI and proper XDG Desktop Portal support.
Built mainly because I wanted a modern-looking file picker that actually behaves how I expect.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)
![Electron](https://img.shields.io/badge/electron-28.3.3-47848F.svg)

<!-- Screenshot coming soon -->

<!-- ![Screenshot](screenshots/main.png) -->

## What it does

* Transparent, glass-style UI that blends into the desktop
* Multiple views: list, compact list, grid, thumbnails
* Tabs, with drag-and-drop between them
* Sorting by name, date, size, type, etc.
* Optional grouping (by type, date, size)
* Per-folder view settings (saved automatically)
* Sidebar with pinned folders
* Simple color-based file tagging
* Preview panel for images, videos, and text files
* Browse archives (zip, tar, 7z, etc.)
* Works as a system file picker via XDG Desktop Portal
* Full keyboard navigation
* Handles large folders efficiently using lazy loading

## Installation

### Requirements

```bash
# Arch Linux
sudo pacman -S nodejs npm electron

# Ubuntu / Debian
sudo apt install nodejs npm
```

### Run locally

```bash
git clone https://github.com/TechyTechster/ez-fm.git
cd ez-fm

npm install
npm start
```

### Optional: system file picker integration

```bash
./install.sh
```

After this, apps using XDG Desktop Portal (Firefox, Chromium, GTK/Qt apps, etc.) will use EZ File Manager for file dialogs.

## Usage

### Keyboard shortcuts

| Shortcut       | Action                   |
| -------------- | ------------------------ |
| `Ctrl+T`       | New tab                  |
| `Ctrl+W`       | Close tab                |
| `Ctrl+L`       | Focus path bar           |
| `Ctrl+F`       | Search                   |
| `Ctrl+H`       | Show / hide hidden files |
| `Ctrl+C`       | Copy                     |
| `Ctrl+X`       | Cut                      |
| `Ctrl+V`       | Paste                    |
| `Delete`       | Move to trash            |
| `Shift+Delete` | Delete permanently       |
| `F2`           | Rename                   |
| `Backspace`    | Go up                    |
| `Enter`        | Open                     |
| `Ctrl+A`       | Select all               |

### Command-line options

```bash
# Open a directory
npm start -- /path/to/folder

# File picker modes
npm start -- --picker --mode=open
npm start -- --picker --mode=save --filename=document.txt
npm start -- --picker --mode=directory
```

## Configuration

* View settings are saved per folder automatically
* Global preferences are stored in localStorage

No config files needed unless you want to customize window rules.

### Hyprland example

```conf
windowrulev2 = float, title:^(Open File|Save File|Select Folder)$
windowrulev2 = center, title:^(Open File|Save File|Select Folder)$
windowrulev2 = size 1000 700, title:^(Open File|Save File|Select Folder)$
```

## Project layout

```
ez-fm/
├── main.js           # Electron main process
├── renderer.js       # UI logic
├── preload.js        # IPC bridge
├── portal-service.js # XDG portal backend
├── index.html        # UI markup
├── styles.css        # Styling
└── install.sh        # Portal installer
```

## Building

```bash
# Development mode
npm run dev
```

Release builds are not wired yet. If you want packaged builds, add a build
script and electron-builder or similar tooling.

## Contributing

PRs are welcome.

1. Fork the repo
2. Create a branch
3. Commit your changes
4. Open a pull request

If you’re unsure about something, open an issue first.

## Troubleshooting

### Portal service problems

```bash
systemctl --user status myfm-portal
journalctl --user -u myfm-portal -f
systemctl --user restart xdg-desktop-portal
```

### App not using EZ File Manager as picker

Some apps cache portal connections.

Try:

1. Restart the app
2. Restart `xdg-desktop-portal`

## License

MIT — see [LICENSE](LICENSE).

## Notes

* Built with Electron
* Uses `dbus-next` for portal integration
* UI loosely inspired by macOS Finder (without copying its behavior)
