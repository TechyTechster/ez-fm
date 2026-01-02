/**
 * EZ File Manager - Main Process
 *
 * Electron main process handling window management, IPC communication,
 * and file system operations.
 *
 * @license MIT
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  clipboard,
  globalShortcut,
} = require("electron");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const sizeOf = require("image-size");

// ============================================================================
// Configuration
// ============================================================================

const isPicker = process.argv.includes("--picker");

// Set app name for window manager (WM_CLASS on Linux)
app.name = "ez-fm";

let mainWindow;

function toFileUrl(p) {
  // Ensure forward slashes and URI-encoding for file:// URLs
  const withSlashes = p.replace(/\\/g, "/");
  // If it already looks like an absolute *nix path, prefix with file://
  // On Windows it will look like C:/...
  return (
    "file://" +
    encodeURI(withSlashes.startsWith("/") ? withSlashes : "/" + withSlashes)
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 300,
    transparent: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 10 },
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Parse CLI args for picker mode
  const args = process.argv;
  let pickerMode = "open";
  if (args.includes("--mode=save")) pickerMode = "save";
  if (args.includes("--mode=directory")) pickerMode = "directory";
  const allowMultiple = args.includes("--multiple");
  
  let defaultFilename = "";
  const filenameArg = args.find(arg => arg.startsWith("--filename="));
  if (filenameArg) {
    defaultFilename = filenameArg.substring(11);
  }

  // Check command line args for a path to open
  let startPath = null;
  // Look for the last argument that isn't a flag.
  // In dev (electron .), we skip '.' if it's the app path.
  for (let i = process.argv.length - 1; i >= 1; i--) {
    const arg = process.argv[i];
    if (!arg.startsWith("-")) {
      if (arg === "." && process.defaultApp) continue; 
      startPath = arg;
      break;
    }
  }

  if (startPath) {
    // Ensure absolute path
    if (!path.isAbsolute(startPath)) startPath = path.resolve(process.cwd(), startPath);
    mainWindow.loadFile("index.html", { query: { 
      startPath,
      picker: isPicker ? "true" : "false",
      pickerMode,
      allowMultiple: allowMultiple ? "true" : "false",
      defaultFilename
    }});
  } else {
    mainWindow.loadFile("index.html", { query: {
      picker: isPicker ? "true" : "false",
      pickerMode,
      allowMultiple: allowMultiple ? "true" : "false",
      defaultFilename
    }});
  }

  // Set window title based on mode (after page loads to prevent HTML title override)
  mainWindow.webContents.on('did-finish-load', () => {
    if (isPicker) {
      const titles = {
        'open': 'Open File',
        'save': 'Save File',
        'directory': 'Select Folder'
      };
      mainWindow.setTitle(titles[pickerMode] || 'File Picker');
    } else {
      mainWindow.setTitle('EZ File Manager');
    }
  });

  // Remove default menu
  Menu.setApplicationMenu(null);

  // DevTools toggles (useful when no menu/devtools access)
  // F12 and Ctrl+Shift+I
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isF12 = input.type === "keyDown" && input.key === "F12";
    const isCtrlShiftI =
      input.type === "keyDown" &&
      input.key.toLowerCase() === "i" &&
      (input.control || input.meta) &&
      input.shift;

    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Global shortcuts as a fallback (in case before-input-event doesn't fire)
  try {
    globalShortcut.register("F12", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    });
    globalShortcut.register("CommandOrControl+Shift+I", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  } catch {
    // ignore
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }
});

// IPC Handlers

// Window controls
ipcMain.on("window-minimize", () => {
  mainWindow?.minimize();
});

ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on("window-close", () => {
  mainWindow?.close();
});

// Picker controls
ipcMain.on("picker-confirm", (event, paths) => {
  if (Array.isArray(paths)) {
    paths.forEach(p => process.stdout.write(p + "\n"));
  }
  app.exit(0);
});

ipcMain.on("picker-cancel", () => {
  app.exit(1);
});

// Get directory contents
ipcMain.handle("get-directory-contents", async (event, dirPath) => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const contents = await Promise.all(
      items.map(async (item) => {
        const fullPath = path.join(dirPath, item.name);
        let stats = null;
        let linkTarget = null;

        try {
          stats = await fs.stat(fullPath);
          if (item.isSymbolicLink()) {
            linkTarget = await fs.readlink(fullPath);
          }
        } catch (err) {
          // File might be inaccessible
        }

        return {
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          isSymlink: item.isSymbolicLink(),
          linkTarget,
          size: stats?.size || 0,
          modified: stats?.mtime || null,
          created: stats?.birthtime || null,
          extension: item.isFile()
            ? path.extname(item.name).toLowerCase()
            : null,
        };
      }),
    );

    // Sort: directories first, then files, both alphabetically
    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { success: true, contents, path: dirPath };
  } catch (error) {
    // If not a directory or doesn't exist, check if it's an archive path
    if (error.code === "ENOTDIR" || error.code === "ENOENT") {
      return await handleArchiveBrowsing(dirPath);
    }
    return { success: false, error: error.message };
  }
});

// Helper to browse archives using 7z
async function handleArchiveBrowsing(fullPath) {
  // 1. Find the archive file part of the path
  let archivePath = fullPath;
  let internalPath = "";
  let found = false;
  
  // Walk up the path until we find a real file (the archive)
  let depth = 0;
  while (depth < 20) { // Safety limit
    try {
      const stats = await fs.stat(archivePath);
      if (stats.isFile()) {
        found = true;
        break;
      } else if (stats.isDirectory()) {
        return { success: false, error: "Not a directory" };
      }
    } catch (e) {
      // Doesn't exist, move up
      const parent = path.dirname(archivePath);
      if (parent === archivePath) break; // Root
      const base = path.basename(archivePath);
      internalPath = internalPath ? path.join(base, internalPath) : base;
      archivePath = parent;
    }
    depth++;
  }

  if (!found) return { success: false, error: "Path not found" };

  // 2. List archive contents using 7z
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);
  
  try {
    // -slt: technical info, -ba: suppress headers, -sccUTF-8: utf8 output
    const safeArchivePath = archivePath.replace(/"/g, '\\"');
    
    // Check for compressed tarball extensions to handle transparently (skip the intermediate .tar)
    const isCompressedTar = /\.(tar\.(gz|xz|bz2)|tgz|txz|tbz2)$/i.test(archivePath);
    
    let cmd = `7z l -slt -ba -sccUTF-8 "${safeArchivePath}"`;
    if (isCompressedTar) {
      // Extract to stdout and list as tar
      cmd = `7z x -so "${safeArchivePath}" | 7z l -slt -ba -sccUTF-8 -si -ttar`;
    }

    const { stdout } = await execPromise(cmd, { maxBuffer: 10 * 1024 * 1024 });
    
    const contents = [];
    const seen = new Set();
    
    // Normalize internal path to forward slashes for comparison
    const normalizedInternal = internalPath.replace(/\\/g, '/');
    
    // Parse 7z output blocks
    const blocks = stdout.split(/\r?\n\r?\n/);
    
    for (const block of blocks) {
      const entry = {};
      block.split(/\r?\n/).forEach(line => {
        const match = line.match(/^(\w+)\s=\s(.*)$/);
        if (match) entry[match[1]] = match[2];
      });

      if (!entry.Path) continue;

      let entryPath = entry.Path.replace(/\\/g, '/');
      
      // Filter items inside current internal path
      if (normalizedInternal && !entryPath.startsWith(normalizedInternal + '/')) continue;
      
      // Get relative path
      let relative = normalizedInternal ? entryPath.slice(normalizedInternal.length + 1) : entryPath;
      if (!relative) continue; // Current folder itself
      
      const parts = relative.split('/');
      const name = parts[0];
      
      if (seen.has(name)) continue;
      seen.add(name);
      
      const isDirectChild = parts.length === 1;
      const isDir = !isDirectChild || (entry.Attributes && entry.Attributes.includes('D'));
      
      contents.push({
        name: name,
        path: path.join(fullPath, name),
        isDirectory: isDir,
        isFile: !isDir,
        isSymlink: false,
        size: isDir ? 0 : parseInt(entry.Size || '0', 10),
        modified: entry.Modified ? new Date(entry.Modified) : null,
        created: null,
        extension: isDir ? null : path.extname(name).toLowerCase()
      });
    }
    
    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { success: true, contents, path: fullPath, isArchive: true };
  } catch (err) {
    return { success: false, error: "Failed to read archive (7z required): " + err.message };
  }
}

// Get home directory
ipcMain.handle("get-home-directory", () => {
  return app.getPath("home");
});

// Get common directories
ipcMain.handle("get-common-directories", () => {
  const homePath = app.getPath("home");

  // Robust Linux resolution without xdg-user-dir:
  // - prefer existing directories returned by Electron
  // - fall back to typical $HOME folder names
  // - if not found, return homePath (last resort)
  const existingOrNull = (p) => {
    if (!p) return null;
    try {
      if (fsSync.existsSync(p) && fsSync.statSync(p).isDirectory()) return p;
    } catch {}
    return null;
  };

  const getElectronPathOrNull = (name) => {
    try {
      return existingOrNull(app.getPath(name));
    } catch {
      return null;
    }
  };

  const pickHomeSubdir = (candidates) => {
    for (const name of candidates) {
      const p = existingOrNull(path.join(homePath, name));
      if (p) return p;
    }
    return null;
  };

  // Common folder name candidates (including a few frequent variations)
  const desktop =
    getElectronPathOrNull("desktop") ??
    pickHomeSubdir(["Desktop", "desktop", "Schreibtisch", "Bureau"]) ??
    homePath;

  const documents =
    getElectronPathOrNull("documents") ??
    pickHomeSubdir(["Documents", "documents", "Dokumente", "Documenti"]) ??
    homePath;

  const downloads =
    getElectronPathOrNull("downloads") ??
    pickHomeSubdir([
      "Downloads",
      "downloads",
      "Téléchargements",
      "Scaricati",
    ]) ??
    homePath;

  const pictures =
    getElectronPathOrNull("pictures") ??
    pickHomeSubdir(["Pictures", "pictures", "Images", "Bilder", "Immagini"]) ??
    homePath;

  const music =
    getElectronPathOrNull("music") ??
    pickHomeSubdir(["Music", "music", "Musik", "Musica"]) ??
    homePath;

  const videos =
    getElectronPathOrNull("videos") ??
    pickHomeSubdir(["Videos", "videos", "Vidéo", "Video"]) ??
    homePath;

  // Best-effort Trash location:
  // - Linux: follows FreeDesktop spec (~/.local/share/Trash/files) when available
  // - macOS: ~/.Trash
  // - Windows: no real filesystem folder (Recycle Bin is virtual); we omit it
  const trash = (() => {
    try {
      if (process.platform === "darwin") {
        const p = path.join(homePath, ".Trash");
        return fsSync.existsSync(p) ? p : null;
      }
      if (process.platform === "linux") {
        const candidates = [
          path.join(homePath, ".local", "share", "Trash", "files"),
          path.join(homePath, ".Trash"),
        ];
        for (const p of candidates) {
          if (fsSync.existsSync(p)) return p;
        }
        return null;
      }
      return null;
    } catch {
      return null;
    }
  })();

  return {
    root: "/",
    ...(trash ? { trash } : {}),
    home: homePath,
    desktop,
    documents,
    downloads,
    pictures,
    music,
    videos,
    config: path.join(homePath, ".config"),
  };
});

// Open file with default application
ipcMain.handle("open-file", async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Show item in folder
ipcMain.handle("show-in-folder", async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

// Open terminal at path
ipcMain.handle("open-terminal", async (event, dirPath) => {
  const { spawn } = require("child_process");
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe"], { cwd: dirPath, shell: true });
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dirPath]);
    } else {
      // Linux: try kitty, fallback to x-terminal-emulator, then gnome-terminal
      const child = spawn("kitty", [], { cwd: dirPath, detached: true, stdio: 'ignore' });
      child.on('error', (e) => {
        if (e.code === 'ENOENT') {
           const child2 = spawn("x-terminal-emulator", [], { cwd: dirPath, detached: true, stdio: 'ignore' });
           child2.on('error', (e2) => {
             if (e2.code === 'ENOENT') {
                spawn("gnome-terminal", [`--working-directory=${dirPath}`], { detached: true, stdio: 'ignore' });
             }
           });
           child2.unref();
        }
      });
      child.unref();
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete file or directory (robust: force + chmod retry)
ipcMain.handle("delete-item", async (event, itemPath) => {
  try {
    const stats = await fs.stat(itemPath);

    if (stats.isDirectory()) {
      await fs.rm(itemPath, { recursive: true, force: true });
    } else {
      try {
        await fs.unlink(itemPath);
      } catch (err) {
        if (err && (err.code === "EACCES" || err.code === "EPERM")) {
          await fs.chmod(itemPath, 0o600);
          await fs.unlink(itemPath);
        } else {
          throw err;
        }
      }
    }

    return { success: true };
  } catch (error) {
    // Last-chance attempt: directory delete with force
    try {
      await fs.rm(itemPath, { recursive: true, force: true });
      return { success: true };
    } catch (finalErr) {
      return { success: false, error: finalErr.message, code: finalErr.code };
    }
  }
});

// Delete item with sudo (for permission denied scenarios)
ipcMain.handle("delete-item-sudo", async (event, itemPath, password) => {
  const { exec } = require("child_process");
  // Basic quote escaping for shell safety
  const safePath = itemPath.replace(/"/g, '\\"');

  return new Promise((resolve) => {
    // -S reads password from stdin, -p '' suppresses the prompt, -k ignores cached credentials
    const child = exec(`sudo -S -k -p '' rm -rf "${safePath}"`, (error, stdout, stderr) => {
      resolve(error ? { success: false, error: stderr || error.message } : { success: true });
    });

    child.stdin.write(password + "\n");
    child.stdin.end();
  });
});

// Move to trash
ipcMain.handle("trash-item", async (event, itemPath) => {
  try {
    await shell.trashItem(itemPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Rename file or directory
ipcMain.handle("rename-item", async (event, oldPath, newName) => {
  try {
    const dirName = path.dirname(oldPath);
    const newPath = path.join(dirName, newName);
    await fs.rename(oldPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Create new folder (safe + handles existing names)
ipcMain.handle("create-folder", async (event, parentPath, folderName) => {
  try {
    const basePath = path.resolve(parentPath);
    const desiredPath = path.join(basePath, folderName);

    // Create intermediate directories safely
    // (If it already exists, we'll handle below)
    try {
      await fs.mkdir(desiredPath, { recursive: false });
      return { success: true, path: desiredPath };
    } catch (err) {
      // If it exists, create a unique name like "New Folder (1)"
      if (err && (err.code === "EEXIST" || err.code === "ENOTEMPTY")) {
        const uniquePath = await findUniquePath(desiredPath, "folder");
        await fs.mkdir(uniquePath, { recursive: false });
        return { success: true, path: uniquePath };
      }
      // If parent path missing, try creating intermediate dirs for basePath then retry
      if (err && err.code === "ENOENT") {
        await fs.mkdir(basePath, { recursive: true });
        try {
          await fs.mkdir(desiredPath, { recursive: false });
          return { success: true, path: desiredPath };
        } catch (err2) {
          if (err2 && (err2.code === "EEXIST" || err2.code === "ENOTEMPTY")) {
            const uniquePath = await findUniquePath(desiredPath, "folder");
            await fs.mkdir(uniquePath, { recursive: false });
            return { success: true, path: uniquePath };
          }
          throw err2;
        }
      }
      throw err;
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Create new file (safe + handles existing names)
ipcMain.handle("create-file", async (event, parentPath, fileName) => {
  try {
    const basePath = path.resolve(parentPath);
    const desiredPath = path.join(basePath, fileName);

    // Ensure parent exists
    await fs.mkdir(basePath, { recursive: true });

    // Try exclusive create; if exists, pick a unique name like "New File (1).txt"
    try {
      const fh = await fs.open(desiredPath, "wx");
      await fh.close();
      return { success: true, path: desiredPath };
    } catch (err) {
      if (err && err.code === "EEXIST") {
        const uniquePath = await findUniquePath(desiredPath, "file");
        const fh = await fs.open(uniquePath, "wx");
        await fh.close();
        return { success: true, path: uniquePath };
      }
      throw err;
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper: pick a unique sibling path if the desired path already exists.
// - For folders: "Name (1)", "Name (2)", ...
// - For files: "Name (1).ext", "Name (2).ext", ...
async function findUniquePath(desiredPath, kind) {
  const dir = path.dirname(desiredPath);
  const parsed = path.parse(desiredPath);

  const baseName = kind === "file" ? parsed.name : parsed.base;
  const ext = kind === "file" ? parsed.ext : "";

  for (let i = 1; i < 10000; i++) {
    const candidateName = `${baseName} (${i})${ext}`;
    const candidatePath = path.join(dir, candidateName);
    try {
      await fs.access(candidatePath);
      // exists -> keep looping
    } catch {
      // doesn't exist
      return candidatePath;
    }
  }

  throw new Error("Could not find a unique name");
}

// Copy file or directory
ipcMain.handle("copy-item", async (event, sourcePath, destPath) => {
  try {
    const stats = await fs.stat(sourcePath);
    if (stats.isDirectory()) {
      await copyDirectory(sourcePath, destPath);
    } else {
      await fs.copyFile(sourcePath, destPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper function to copy directory recursively
async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const items = await fs.readdir(source, { withFileTypes: true });

  for (const item of items) {
    const srcPath = path.join(source, item.name);
    const destPath = path.join(destination, item.name);

    if (item.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// Move file or directory
ipcMain.handle("move-item", async (event, sourcePath, destPath) => {
  try {
    await fs.rename(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    // If rename fails (cross-device), try copy and delete
    try {
      const stats = await fs.stat(sourcePath);
      if (stats.isDirectory()) {
        await copyDirectory(sourcePath, destPath);
        await fs.rm(sourcePath, { recursive: true });
      } else {
        await fs.copyFile(sourcePath, destPath);
        await fs.unlink(sourcePath);
      }
      return { success: true };
    } catch (copyError) {
      return { success: false, error: copyError.message };
    }
  }
});

// Extract archive
ipcMain.handle("extract-archive", async (event, archivePath, destPath) => {
  try {
    const { execSync } = require("child_process");
    const baseName = path.basename(archivePath);

    // Create output directory based on archive name
    let outputDir = path.join(destPath, baseName.replace(/\.(zip|tar|gz|bz2|xz|7z|rar|tgz)$/gi, "").replace(/\.tar$/i, ""));

    // Use 7z for extraction (works with most formats)
    // Falls back to unzip for .zip if 7z not available
    const lower = archivePath.toLowerCase();

    try {
      await fs.mkdir(outputDir, { recursive: true });

      if (lower.endsWith(".zip")) {
        // Try unzip first, then 7z
        try {
          execSync(`unzip -o "${archivePath}" -d "${outputDir}"`, { stdio: "pipe" });
        } catch {
          execSync(`7z x "${archivePath}" -o"${outputDir}" -y`, { stdio: "pipe" });
        }
      } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
        execSync(`tar -xzf "${archivePath}" -C "${outputDir}"`, { stdio: "pipe" });
      } else if (lower.endsWith(".tar.bz2")) {
        execSync(`tar -xjf "${archivePath}" -C "${outputDir}"`, { stdio: "pipe" });
      } else if (lower.endsWith(".tar.xz")) {
        execSync(`tar -xJf "${archivePath}" -C "${outputDir}"`, { stdio: "pipe" });
      } else if (lower.endsWith(".tar")) {
        execSync(`tar -xf "${archivePath}" -C "${outputDir}"`, { stdio: "pipe" });
      } else if (lower.endsWith(".gz")) {
        execSync(`gunzip -c "${archivePath}" > "${path.join(outputDir, baseName.replace(/\.gz$/i, ""))}"`, { stdio: "pipe", shell: true });
      } else {
        // 7z handles most other formats (rar, 7z, etc.)
        execSync(`7z x "${archivePath}" -o"${outputDir}" -y`, { stdio: "pipe" });
      }

      return { success: true, outputDir };
    } catch (cmdError) {
      return { success: false, error: cmdError.message || "Extraction failed" };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Compress items to archive
ipcMain.handle("compress-items", async (event, paths, outputPath) => {
  try {
    const { execSync } = require("child_process");
    const lower = outputPath.toLowerCase();

    // Build list of items to compress
    const items = paths.map(p => `"${p}"`).join(" ");

    try {
      if (lower.endsWith(".zip")) {
        // Use zip command
        const baseNames = paths.map(p => path.basename(p)).join(" ");
        const parentDir = path.dirname(paths[0]);
        execSync(`cd "${parentDir}" && zip -r "${outputPath}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
        execSync(`tar -czf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      } else if (lower.endsWith(".tar.bz2")) {
        execSync(`tar -cjf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      } else if (lower.endsWith(".tar.xz")) {
        execSync(`tar -cJf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      } else if (lower.endsWith(".tar")) {
        execSync(`tar -cf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      } else if (lower.endsWith(".7z")) {
        execSync(`7z a "${outputPath}" ${items}`, { stdio: "pipe", shell: true });
      } else {
        // Default to zip
        execSync(`cd "${path.dirname(paths[0])}" && zip -r "${outputPath}" ${paths.map(p => `"${path.basename(p)}"`).join(" ")}`, { stdio: "pipe", shell: true });
      }

      return { success: true };
    } catch (cmdError) {
      return { success: false, error: cmdError.message || "Compression failed" };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Batch file operation (copy/move) with progress reporting
ipcMain.handle("batch-file-operation", async (event, items, operation) => {
  // items: [{ source, dest }]
  // operation: 'copy' | 'move'
  
  let totalBytes = 0;
  let processedBytes = 0;
  let totalFiles = 0;
  let processedFiles = 0;

  // Map of source path -> size (bytes) to track progress for atomic moves
  const itemSizes = new Map();

  // Helper to scan directory for totals
  const scan = async (p, rootItemPath) => {
    try {
      const stats = await fs.stat(p);
      if (stats.isDirectory()) {
        const children = await fs.readdir(p);
        for (const c of children) await scan(path.join(p, c), rootItemPath);
      } else {
        totalBytes += stats.size;
        totalFiles++;
        itemSizes.set(rootItemPath, (itemSizes.get(rootItemPath) || 0) + stats.size);
      }
    } catch {}
  };

  // 1. Scan phase
  for (const item of items) {
    await scan(item.source, item.source);
  }

  // Avoid division by zero
  if (totalBytes === 0) totalBytes = 1;

  const reportProgress = () => {
    const percent = Math.min(100, (processedBytes / totalBytes) * 100);
    event.sender.send("file-operation-progress", percent);
  };

  // Helper to copy with progress
  const copyRecursive = async (src, dest) => {
    const stats = await fs.stat(src);
    if (stats.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      const children = await fs.readdir(src);
      for (const child of children) {
        await copyRecursive(path.join(src, child), path.join(dest, child));
      }
    } else {
      await fs.copyFile(src, dest);
      processedBytes += stats.size;
      processedFiles++;
      reportProgress();
    }
  };

  // 2. Execution phase
  try {
    for (const item of items) {
      if (operation === "copy") {
        await copyRecursive(item.source, item.dest);
      } else {
        // Move: try rename first
        try {
          await fs.rename(item.source, item.dest);
          // Rename is instant, add the pre-calculated size of this item tree to progress
          const size = itemSizes.get(item.source) || 0;
          processedBytes += size;
          reportProgress();
        } catch (err) {
          // Cross-device move: copy then delete
          await copyRecursive(item.source, item.dest);
          await fs.rm(item.source, { recursive: true, force: true });
        }
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get file/folder info
ipcMain.handle("get-item-info", async (event, itemPath) => {
  try {
    const stats = await fs.stat(itemPath);
    let size = stats.size;

    // Calculate directory size
    if (stats.isDirectory()) {
      size = await getDirectorySize(itemPath);
    }

    return {
      success: true,
      info: {
        name: path.basename(itemPath),
        path: itemPath,
        size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper function to get directory size (recursive)
async function getDirectorySize(dirPath) {
  let size = 0;
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      try {
        if (item.isDirectory()) {
          size += await getDirectorySize(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          size += stats.size;
        }
      } catch (err) {
        // Skip inaccessible items
      }
    }
  } catch (err) {
    // Skip inaccessible directories
  }
  return size;
}

// Helper to get disk space (robust: fs.statfs -> wmic/df fallback)
async function getDiskSpace(pathStr) {
  try {
    // Node 18.15+ / Electron 25+
    if (fs.statfs) {
      const stats = await fs.statfs(pathStr);
      return {
        total: stats.blocks * stats.bsize,
        free: stats.bavail * stats.bsize,
      };
    }
  } catch {}

  // Fallback
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    if (process.platform === "win32") {
      const driveLetter = pathStr.substring(0, 2);
      const { stdout } = await execPromise(`wmic logicaldisk where "DeviceID='${driveLetter}'" get FreeSpace,Size /format:value`);
      const sizeMatch = stdout.match(/Size=(\d+)/);
      const freeMatch = stdout.match(/FreeSpace=(\d+)/);
      if (sizeMatch && freeMatch) {
        return { total: parseInt(sizeMatch[1], 10), free: parseInt(freeMatch[1], 10) };
      }
    } else {
      const { stdout } = await execPromise(`df -kP "${pathStr}"`);
      const lines = stdout.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 4) {
          return { total: parseInt(parts[1], 10) * 1024, free: parseInt(parts[3], 10) * 1024 };
        }
      }
    }
  } catch {}
  return null;
}

// Show open dialog
ipcMain.handle("show-open-dialog", async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

// Show save dialog
ipcMain.handle("show-save-dialog", async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// Get drives (for Windows) or block devices (Linux/macOS)
ipcMain.handle("get-drives", async () => {
  if (process.platform === "win32") {
    // Windows: get drive letters
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ":\\";
      try {
        await fs.access(drive);
        const space = await getDiskSpace(drive);
        drives.push({ name: drive, path: drive, mounted: true, space });
      } catch (err) {
        // Drive doesn't exist
      }
    }
    return drives;
  } else {
    // Linux/macOS: use lsblk to get all block devices
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const drives = [];

    try {
      // Get block devices with lsblk (JSON output) - include RO for read-only check
      const { stdout } = await execPromise(
        "lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT,LABEL,FSTYPE,RO 2>/dev/null"
      );
      const data = JSON.parse(stdout);

      const processDevice = (device, parentName = null) => {
        const name = device.name;
        const fullPath = `/dev/${name}`;
        const mountpoint = device.mountpoint;
        const label = device.label;
        const size = device.size;
        const fstype = device.fstype;
        const type = device.type;
        const ro = device.ro === "1" || device.ro === true;

        // Skip loop devices, ram disks, rom devices, and system partitions
        if (type === "loop" || type === "ram" || type === "rom") return;

        // Skip system/boot partitions and swap
        const skipFsTypes = ["swap", "vfat"]; // vfat at /boot/efi
        const skipMountpoints = ["/boot", "/boot/efi", "/efi", "[SWAP]"];
        const skipLabels = ["EFI", "SYSTEM", "Recovery", "RECOVERY", "BIOS"];

        if (fstype && skipFsTypes.includes(fstype) &&
            (mountpoint === "[SWAP]" || !mountpoint || skipMountpoints.some(m => mountpoint?.startsWith(m)))) return;
        if (mountpoint && skipMountpoints.some(m => mountpoint.startsWith(m))) return;
        if (label && skipLabels.includes(label)) return;

        // For partitions and disks with filesystems
        if (fstype || mountpoint) {
          let displayName = label || name;
          if (size) displayName += ` (${size})`;

          drives.push({
            name: displayName,
            path: mountpoint || fullPath,
            mounted: Boolean(mountpoint),
            size: size,
            device: fullPath,
            fstype: fstype,
            readonly: ro,
          });
        }

        // Process children (partitions)
        if (device.children) {
          for (const child of device.children) {
            processDevice(child, name);
          }
        }
      };

      if (data.blockdevices) {
        for (const device of data.blockdevices) {
          processDevice(device);
        }
      }
    } catch (err) {
      // lsblk failed, fall back to basic method
      console.error("lsblk failed, using fallback:", err.message);
    }

    // Always include root
    if (!drives.some((d) => d.path === "/")) {
      drives.unshift({ name: "Root", path: "/", mounted: true });
    }

    // Add common mount point directories as fallback
    const commonMounts = ["/mnt", "/media", "/Volumes", "/run/media"];
    for (const mount of commonMounts) {
      try {
        await fs.access(mount);
        const items = await fs.readdir(mount, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const itemPath = path.join(mount, item.name);
            // Check subdirectories for /run/media/$USER/
            if (mount === "/run/media") {
              try {
                const subItems = await fs.readdir(itemPath, { withFileTypes: true });
                for (const subItem of subItems) {
                  if (subItem.isDirectory()) {
                    const subPath = path.join(itemPath, subItem.name);
                    if (!drives.some((d) => d.path === subPath)) {
                      drives.push({
                        name: subItem.name,
                        path: subPath,
                        mounted: true,
                      });
                    }
                  }
                }
              } catch (e) {
                // Skip inaccessible
              }
            } else if (!drives.some((d) => d.path === itemPath)) {
              drives.push({
                name: item.name,
                path: itemPath,
                mounted: true,
              });
            }
          }
        }
      } catch (err) {
        // Mount point doesn't exist
      }
    }

    // Populate space info for mounted drives
    for (const d of drives) {
      if (d.mounted && d.path) {
        d.space = await getDiskSpace(d.path);
      }
    }

    return drives;
  }
});

// Unmount a device using udisksctl
ipcMain.handle("unmount-device", async (event, devicePath) => {
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    await execPromise(`udisksctl unmount -b ${devicePath} 2>&1`);
    return { success: true };
  } catch (error) {
    // Try alternative: gio mount -u
    try {
      await execPromise(`gio mount -u ${devicePath} 2>&1`);
      return { success: true };
    } catch (gioErr) {
      // Try umount as last resort
      try {
        await execPromise(`umount ${devicePath} 2>&1`);
        return { success: true };
      } catch (umountErr) {
        return { success: false, error: error.message || "Unmount failed" };
      }
    }
  }
});

// Mount a device using udisksctl
ipcMain.handle("mount-device", async (event, devicePath) => {
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    // Use udisksctl to mount (works without root on most Linux distros)
    const { stdout } = await execPromise(`udisksctl mount -b ${devicePath} 2>&1`);
    // Parse mount point from output like "Mounted /dev/sdb1 at /run/media/user/LABEL"
    const match = stdout.match(/at (.+?)\.?\s*$/);
    const mountpoint = match ? match[1].trim() : null;
    return { success: true, mountpoint };
  } catch (error) {
    // Try alternative: gio mount
    try {
      await execPromise(`gio mount -d ${devicePath} 2>&1`);
      // Get mount point from lsblk
      const { stdout: lsblkOut } = await execPromise(
        `lsblk -n -o MOUNTPOINT ${devicePath} 2>/dev/null`
      );
      const mountpoint = lsblkOut.trim() || null;
      if (mountpoint) {
        return { success: true, mountpoint };
      }
    } catch (gioErr) {
      // gio also failed
    }
    return { success: false, error: error.message || "Mount failed" };
  }
});

// Check if path exists
ipcMain.handle("path-exists", async (event, checkPath) => {
  try {
    await fs.access(checkPath);
    return true;
  } catch {
    return false;
  }
});

// Get parent directory
ipcMain.handle("get-parent-directory", (event, currentPath) => {
  return path.dirname(currentPath);
});

// Join paths
ipcMain.handle("join-paths", (event, ...paths) => {
  return path.join(...paths);
});

// Parse path
ipcMain.handle("parse-path", (event, pathString) => {
  return path.parse(pathString);
});

// Copy file paths to OS clipboard (as text and as file list where supported)
ipcMain.handle("clipboard-copy-paths", async (event, paths) => {
  try {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (list.length === 0)
      return { success: false, error: "No paths provided" };

    // Always write plain text (newline-separated)
    clipboard.writeText(list.join("\n"));

    // Also try to write a file list for apps that support it (best-effort)
    try {
      clipboard.write({
        text: list.join("\n"),
        // Many apps accept a text/uri-list for file drops
        "text/uri-list": list.map(toFileUrl).join("\n"),
      });
    } catch {
      // ignore format failures; text is already written
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Read file contents for preview (text files only, with size limit)
ipcMain.handle("read-file-preview", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    
    // Only read text files, and limit to 1MB for preview
    const MAX_PREVIEW_SIZE = 1024 * 1024; // 1MB
    if (stats.size > MAX_PREVIEW_SIZE) {
      return { success: false, error: "File too large for preview" };
    }

    // Check if it's likely a text file by extension
    const ext = path.extname(filePath).toLowerCase();
    const textExtensions = [
      ".txt", ".md", ".json", ".xml", ".html", ".css", ".js", ".ts",
      ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".rs", ".go", ".rb",
      ".php", ".sh", ".bat", ".yml", ".yaml", ".ini", ".conf", ".log",
      ".csv", ".tsv", ".sql", ".rtf", ".tex", ".latex"
    ];

    if (!textExtensions.includes(ext)) {
      return { success: false, error: "File type not supported for text preview" };
    }

    const content = await fs.readFile(filePath, "utf8");
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get image metadata (dimensions, format, etc.)
ipcMain.handle("get-image-metadata", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    let dimensions = null;

    try {
      dimensions = sizeOf(filePath);
    } catch (e) {
      // image-size failed, but we still return basic stats
    }
    
    return {
      success: true,
      metadata: {
        width: dimensions?.width,
        height: dimensions?.height,
        type: dimensions?.type,
        orientation: dimensions?.orientation,
        hasAlpha: dimensions?.hasAlpha,
        fileSize: stats.size,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get video metadata (duration, resolution, codec, etc.)
ipcMain.handle("get-video-metadata", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    // Try to use ffprobe if available (common on Linux)
    try {
      const { stdout } = await execPromise(
        `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}" 2>/dev/null`
      );
      const data = JSON.parse(stdout);
      
      const videoStream = data.streams?.find((s) => s.codec_type === "video");
      const audioStream = data.streams?.find((s) => s.codec_type === "audio");
      const format = data.format;

      return {
        success: true,
        metadata: {
          duration: format?.duration ? parseFloat(format.duration) : null,
          fileSize: stats.size,
          bitrate: format?.bit_rate ? parseInt(format.bit_rate) : null,
          videoCodec: videoStream?.codec_name || null,
          videoWidth: videoStream?.width || null,
          videoHeight: videoStream?.height || null,
          videoFps: videoStream?.r_frame_rate ? (() => {
            const parts = videoStream.r_frame_rate.split("/");
            if (parts.length === 2) {
              return parseFloat(parts[0]) / parseFloat(parts[1]);
            }
            return parseFloat(videoStream.r_frame_rate);
          })() : null,
          audioCodec: audioStream?.codec_name || null,
          audioChannels: audioStream?.channels || null,
          audioSampleRate: audioStream?.sample_rate || null,
        },
      };
    } catch (ffprobeError) {
      // ffprobe not available or failed, return basic info
      return {
        success: true,
        metadata: {
          fileSize: stats.size,
          note: "Install ffprobe for detailed video metadata",
        },
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});
