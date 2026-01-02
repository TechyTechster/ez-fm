// EZ File Manager — main process
// MIT License

// ============================================================================
// Imports & configuration
// ============================================================================

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

const isPicker = process.argv.includes("--picker");
let devtoolsEnabled = false;

app.name = "ez-fm";

let mainWindow;

// ============================================================================
// Utilities
// ============================================================================

function toFileUrl(p) {
  const withSlashes = p.replace(/\\/g, "/");

  return (
    "file://" +
    encodeURI(withSlashes.startsWith("/") ? withSlashes : "/" + withSlashes)
  );
}

// ============================================================================
// Window lifecycle
// ============================================================================

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
      devTools: devtoolsEnabled,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const args = process.argv;
  let pickerMode = "open";
  if (args.includes("--mode=save")) pickerMode = "save";
  if (args.includes("--mode=directory")) pickerMode = "directory";
  const allowMultiple = args.includes("--multiple");

  let defaultFilename = "";
  const filenameArg = args.find((arg) => arg.startsWith("--filename="));
  if (filenameArg) {
    defaultFilename = filenameArg.substring(11);
  }

  let startPath = null;

  for (let i = process.argv.length - 1; i >= 1; i--) {
    const arg = process.argv[i];
    if (!arg.startsWith("-")) {
      if (arg === "." && process.defaultApp) continue;
      startPath = arg;
      break;
    }
  }

  if (startPath) {
    if (!path.isAbsolute(startPath))
      startPath = path.resolve(process.cwd(), startPath);
    mainWindow.loadFile("index.html", {
      query: {
        startPath,
        picker: isPicker ? "true" : "false",
        pickerMode,
        allowMultiple: allowMultiple ? "true" : "false",
        defaultFilename,
      },
    });
  } else {
    mainWindow.loadFile("index.html", {
      query: {
        picker: isPicker ? "true" : "false",
        pickerMode,
        allowMultiple: allowMultiple ? "true" : "false",
        defaultFilename,
      },
    });
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (isPicker) {
      const titles = {
        open: "Open File",
        save: "Save File",
        directory: "Select Folder",
      };
      mainWindow.setTitle(titles[pickerMode] || "File Picker");
    } else {
      mainWindow.setTitle("EZ File Manager");
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isF12 = input.type === "keyDown" && input.key === "F12";
    const isCtrlShiftI =
      input.type === "keyDown" &&
      input.key.toLowerCase() === "i" &&
      (input.control || input.meta) &&
      input.shift;

    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
      if (devtoolsEnabled && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  devtoolsEnabled = process.env.EZFM_DEVTOOLS === "1";
  createWindow();

  if (devtoolsEnabled) {
    const registerDevtoolsShortcut = (accelerator) => {
      globalShortcut.register(accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.toggleDevTools();
        }
      });
    };

    try {
      registerDevtoolsShortcut("F12");
      registerDevtoolsShortcut("CommandOrControl+Shift+I");
    } catch (error) {
      console.warn("Failed to register devtools shortcuts:", error);
    }
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
  } catch (error) {
    console.warn("Failed to unregister global shortcuts:", error);
  }
});

// ============================================================================
// window controls
// ============================================================================

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

ipcMain.on("picker-confirm", (event, paths) => {
  if (Array.isArray(paths)) {
    paths.forEach((p) => process.stdout.write(p + "\n"));
  }
  app.exit(0);
});

ipcMain.on("picker-cancel", () => {
  app.exit(1);
});

// ============================================================================
// filesystem basics
// ============================================================================

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
        } catch (err) {}

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

    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { success: true, contents, path: dirPath };
  } catch (error) {
    if (error.code === "ENOTDIR" || error.code === "ENOENT") {
      return await handleArchiveBrowsing(dirPath);
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-home-directory", () => {
  return app.getPath("home");
});

ipcMain.handle("get-common-directories", () => {
  const homePath = app.getPath("home");

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

ipcMain.handle("path-exists", async (event, checkPath) => {
  try {
    await fs.access(checkPath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("get-parent-directory", (event, currentPath) => {
  return path.dirname(currentPath);
});

ipcMain.handle("join-paths", (event, ...paths) => {
  return path.join(...paths);
});

ipcMain.handle("parse-path", (event, pathString) => {
  return path.parse(pathString);
});

// ============================================================================
// file operations
// ============================================================================

ipcMain.handle("open-file", async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("show-in-folder", async (event, filePath) => {
  shell.showItemInFolder(filePath);
  return { success: true };
});

ipcMain.handle("open-terminal", async (event, dirPath) => {
  const { spawn } = require("child_process");
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe"], {
        cwd: dirPath,
        shell: true,
      });
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dirPath]);
    } else {
      const child = spawn("kitty", [], {
        cwd: dirPath,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (e) => {
        if (e.code === "ENOENT") {
          const child2 = spawn("x-terminal-emulator", [], {
            cwd: dirPath,
            detached: true,
            stdio: "ignore",
          });
          child2.on("error", (e2) => {
            if (e2.code === "ENOENT") {
              spawn("gnome-terminal", [`--working-directory=${dirPath}`], {
                detached: true,
                stdio: "ignore",
              });
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
    try {
      await fs.rm(itemPath, { recursive: true, force: true });
      return { success: true };
    } catch (finalErr) {
      return { success: false, error: finalErr.message, code: finalErr.code };
    }
  }
});

ipcMain.handle("delete-item-sudo", async (event, itemPath, password) => {
  const { exec } = require("child_process");

  const safePath = itemPath.replace(/"/g, '\\"');

  return new Promise((resolve) => {
    const child = exec(
      `sudo -S -k -p '' rm -rf "${safePath}"`,
      (error, stdout, stderr) => {
        resolve(
          error
            ? { success: false, error: stderr || error.message }
            : { success: true },
        );
      },
    );

    child.stdin.write(password + "\n");
    child.stdin.end();
  });
});

ipcMain.handle("trash-item", async (event, itemPath) => {
  try {
    await shell.trashItem(itemPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

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

ipcMain.handle("create-folder", async (event, parentPath, folderName) => {
  try {
    const basePath = path.resolve(parentPath);
    const desiredPath = path.join(basePath, folderName);

    try {
      await fs.mkdir(desiredPath, { recursive: false });
      return { success: true, path: desiredPath };
    } catch (err) {
      if (err && (err.code === "EEXIST" || err.code === "ENOTEMPTY")) {
        const uniquePath = await findUniquePath(desiredPath, "folder");
        await fs.mkdir(uniquePath, { recursive: false });
        return { success: true, path: uniquePath };
      }

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

ipcMain.handle("create-file", async (event, parentPath, fileName) => {
  try {
    const basePath = path.resolve(parentPath);
    const desiredPath = path.join(basePath, fileName);

    await fs.mkdir(basePath, { recursive: true });

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
    } catch {
      return candidatePath;
    }
  }

  throw new Error("Could not find a unique name");
}

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

ipcMain.handle("move-item", async (event, sourcePath, destPath) => {
  try {
    await fs.rename(sourcePath, destPath);
    return { success: true };
  } catch (error) {
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

ipcMain.handle("batch-file-operation", async (event, items, operation) => {
  let totalBytes = 0;
  let processedBytes = 0;
  let totalFiles = 0;
  let processedFiles = 0;

  const itemSizes = new Map();

  const scan = async (p, rootItemPath) => {
    try {
      const stats = await fs.stat(p);
      if (stats.isDirectory()) {
        const children = await fs.readdir(p);
        for (const c of children) await scan(path.join(p, c), rootItemPath);
      } else {
        totalBytes += stats.size;
        totalFiles++;
        itemSizes.set(
          rootItemPath,
          (itemSizes.get(rootItemPath) || 0) + stats.size,
        );
      }
    } catch {}
  };

  for (const item of items) {
    await scan(item.source, item.source);
  }

  if (totalBytes === 0) totalBytes = 1;

  const reportProgress = () => {
    const percent = Math.min(100, (processedBytes / totalBytes) * 100);
    event.sender.send("file-operation-progress", percent);
  };

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

  try {
    for (const item of items) {
      if (operation === "copy") {
        await copyRecursive(item.source, item.dest);
      } else {
        try {
          await fs.rename(item.source, item.dest);

          const size = itemSizes.get(item.source) || 0;
          processedBytes += size;
          reportProgress();
        } catch (err) {
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

ipcMain.handle("get-item-info", async (event, itemPath) => {
  try {
    const stats = await fs.stat(itemPath);
    let size = stats.size;

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
      } catch (err) {}
    }
  } catch (err) {}
  return size;
}

ipcMain.handle("clipboard-copy-paths", async (event, paths) => {
  try {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (list.length === 0)
      return { success: false, error: "No paths provided" };

    clipboard.writeText(list.join("\n"));

    try {
      clipboard.write({
        text: list.join("\n"),

        "text/uri-list": list.map(toFileUrl).join("\n"),
      });
    } catch {}

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================================================
// archives
// ============================================================================

async function handleArchiveBrowsing(fullPath) {
  let archivePath = fullPath;
  let internalPath = "";
  let found = false;

  let depth = 0;
  while (depth < 20) {
    try {
      const stats = await fs.stat(archivePath);
      if (stats.isFile()) {
        found = true;
        break;
      } else if (stats.isDirectory()) {
        return { success: false, error: "Not a directory" };
      }
    } catch (e) {
      const parent = path.dirname(archivePath);
      if (parent === archivePath) break;
      const base = path.basename(archivePath);
      internalPath = internalPath ? path.join(base, internalPath) : base;
      archivePath = parent;
    }
    depth++;
  }

  if (!found) return { success: false, error: "Path not found" };

  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    const safeArchivePath = archivePath.replace(/"/g, '\\"');

    const isCompressedTar = /\.(tar\.(gz|xz|bz2)|tgz|txz|tbz2)$/i.test(
      archivePath,
    );

    let cmd = `7z l -slt -ba -sccUTF-8 "${safeArchivePath}"`;
    if (isCompressedTar) {
      cmd = `7z x -so "${safeArchivePath}" | 7z l -slt -ba -sccUTF-8 -si -ttar`;
    }

    const { stdout } = await execPromise(cmd, { maxBuffer: 10 * 1024 * 1024 });

    const contents = [];
    const seen = new Set();

    const normalizedInternal = internalPath.replace(/\\/g, "/");

    const blocks = stdout.split(/\r?\n\r?\n/);

    for (const block of blocks) {
      const entry = {};
      block.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^(\w+)\s=\s(.*)$/);
        if (match) entry[match[1]] = match[2];
      });

      if (!entry.Path) continue;

      let entryPath = entry.Path.replace(/\\/g, "/");

      if (normalizedInternal && !entryPath.startsWith(normalizedInternal + "/"))
        continue;

      let relative = normalizedInternal
        ? entryPath.slice(normalizedInternal.length + 1)
        : entryPath;
      if (!relative) continue;

      const parts = relative.split("/");
      const name = parts[0];

      if (seen.has(name)) continue;
      seen.add(name);

      const isDirectChild = parts.length === 1;
      const isDir =
        !isDirectChild || (entry.Attributes && entry.Attributes.includes("D"));

      contents.push({
        name: name,
        path: path.join(fullPath, name),
        isDirectory: isDir,
        isFile: !isDir,
        isSymlink: false,
        size: isDir ? 0 : parseInt(entry.Size || "0", 10),
        modified: entry.Modified ? new Date(entry.Modified) : null,
        created: null,
        extension: isDir ? null : path.extname(name).toLowerCase(),
      });
    }

    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { success: true, contents, path: fullPath, isArchive: true };
  } catch (err) {
    return {
      success: false,
      error: "Failed to read archive (7z required): " + err.message,
    };
  }
}

ipcMain.handle("extract-archive", async (event, archivePath, destPath) => {
  try {
    const { execSync } = require("child_process");
    const baseName = path.basename(archivePath);

    let outputDir = path.join(
      destPath,
      baseName
        .replace(/\.(zip|tar|gz|bz2|xz|7z|rar|tgz)$/gi, "")
        .replace(/\.tar$/i, ""),
    );

    const lower = archivePath.toLowerCase();

    try {
      await fs.mkdir(outputDir, { recursive: true });

      if (lower.endsWith(".zip")) {
        try {
          execSync(`unzip -o "${archivePath}" -d "${outputDir}"`, {
            stdio: "pipe",
          });
        } catch {
          execSync(`7z x "${archivePath}" -o"${outputDir}" -y`, {
            stdio: "pipe",
          });
        }
      } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
        execSync(`tar -xzf "${archivePath}" -C "${outputDir}"`, {
          stdio: "pipe",
        });
      } else if (lower.endsWith(".tar.bz2")) {
        execSync(`tar -xjf "${archivePath}" -C "${outputDir}"`, {
          stdio: "pipe",
        });
      } else if (lower.endsWith(".tar.xz")) {
        execSync(`tar -xJf "${archivePath}" -C "${outputDir}"`, {
          stdio: "pipe",
        });
      } else if (lower.endsWith(".tar")) {
        execSync(`tar -xf "${archivePath}" -C "${outputDir}"`, {
          stdio: "pipe",
        });
      } else if (lower.endsWith(".gz")) {
        execSync(
          `gunzip -c "${archivePath}" > "${path.join(outputDir, baseName.replace(/\.gz$/i, ""))}"`,
          { stdio: "pipe", shell: true },
        );
      } else {
        execSync(`7z x "${archivePath}" -o"${outputDir}" -y`, {
          stdio: "pipe",
        });
      }

      return { success: true, outputDir };
    } catch (cmdError) {
      return { success: false, error: cmdError.message || "Extraction failed" };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("compress-items", async (event, paths, outputPath) => {
  try {
    const { execSync } = require("child_process");
    const lower = outputPath.toLowerCase();

    const items = paths.map((p) => `"${p}"`).join(" ");

    try {
      if (lower.endsWith(".zip")) {
        const baseNames = paths.map((p) => path.basename(p)).join(" ");
        const parentDir = path.dirname(paths[0]);
        execSync(
          `cd "${parentDir}" && zip -r "${outputPath}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
        execSync(
          `tar -czf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      } else if (lower.endsWith(".tar.bz2")) {
        execSync(
          `tar -cjf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      } else if (lower.endsWith(".tar.xz")) {
        execSync(
          `tar -cJf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      } else if (lower.endsWith(".tar")) {
        execSync(
          `tar -cf "${outputPath}" -C "${path.dirname(paths[0])}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      } else if (lower.endsWith(".7z")) {
        execSync(`7z a "${outputPath}" ${items}`, {
          stdio: "pipe",
          shell: true,
        });
      } else {
        execSync(
          `cd "${path.dirname(paths[0])}" && zip -r "${outputPath}" ${paths.map((p) => `"${path.basename(p)}"`).join(" ")}`,
          { stdio: "pipe", shell: true },
        );
      }

      return { success: true };
    } catch (cmdError) {
      return {
        success: false,
        error: cmdError.message || "Compression failed",
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================================================
// devices & mounts
// ============================================================================

async function getDiskSpace(pathStr) {
  try {
    if (fs.statfs) {
      const stats = await fs.statfs(pathStr);
      return {
        total: stats.blocks * stats.bsize,
        free: stats.bavail * stats.bsize,
      };
    }
  } catch {}

  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    if (process.platform === "win32") {
      const driveLetter = pathStr.substring(0, 2);
      const { stdout } = await execPromise(
        `wmic logicaldisk where "DeviceID='${driveLetter}'" get FreeSpace,Size /format:value`,
      );
      const sizeMatch = stdout.match(/Size=(\d+)/);
      const freeMatch = stdout.match(/FreeSpace=(\d+)/);
      if (sizeMatch && freeMatch) {
        return {
          total: parseInt(sizeMatch[1], 10),
          free: parseInt(freeMatch[1], 10),
        };
      }
    } else {
      const { stdout } = await execPromise(`df -kP "${pathStr}"`);
      const lines = stdout.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 4) {
          return {
            total: parseInt(parts[1], 10) * 1024,
            free: parseInt(parts[3], 10) * 1024,
          };
        }
      }
    }
  } catch {}
  return null;
}

ipcMain.handle("get-drives", async () => {
  if (process.platform === "win32") {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ":\\";
      try {
        await fs.access(drive);
        const space = await getDiskSpace(drive);
        drives.push({ name: drive, path: drive, mounted: true, space });
      } catch (err) {}
    }
    return drives;
  } else {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const drives = [];

    try {
      const { stdout } = await execPromise(
        "lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT,LABEL,FSTYPE,RO 2>/dev/null",
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

        if (type === "loop" || type === "ram" || type === "rom") return;

        const skipFsTypes = ["swap", "vfat"];
        const skipMountpoints = ["/boot", "/boot/efi", "/efi", "[SWAP]"];
        const skipLabels = ["EFI", "SYSTEM", "Recovery", "RECOVERY", "BIOS"];

        if (
          fstype &&
          skipFsTypes.includes(fstype) &&
          (mountpoint === "[SWAP]" ||
            !mountpoint ||
            skipMountpoints.some((m) => mountpoint?.startsWith(m)))
        )
          return;
        if (mountpoint && skipMountpoints.some((m) => mountpoint.startsWith(m)))
          return;
        if (label && skipLabels.includes(label)) return;

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
      console.error("lsblk failed, using fallback:", err.message);
    }

    if (!drives.some((d) => d.path === "/")) {
      drives.unshift({ name: "Root", path: "/", mounted: true });
    }

    const commonMounts = ["/mnt", "/media", "/Volumes", "/run/media"];
    for (const mount of commonMounts) {
      try {
        await fs.access(mount);
        const items = await fs.readdir(mount, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const itemPath = path.join(mount, item.name);

            if (mount === "/run/media") {
              try {
                const subItems = await fs.readdir(itemPath, {
                  withFileTypes: true,
                });
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
              } catch (e) {}
            } else if (!drives.some((d) => d.path === itemPath)) {
              drives.push({
                name: item.name,
                path: itemPath,
                mounted: true,
              });
            }
          }
        }
      } catch (err) {}
    }

    for (const d of drives) {
      if (d.mounted && d.path) {
        d.space = await getDiskSpace(d.path);
      }
    }

    return drives;
  }
});

ipcMain.handle("unmount-device", async (event, devicePath) => {
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    await execPromise(`udisksctl unmount -b ${devicePath} 2>&1`);
    return { success: true };
  } catch (error) {
    try {
      await execPromise(`gio mount -u ${devicePath} 2>&1`);
      return { success: true };
    } catch (gioErr) {
      try {
        await execPromise(`umount ${devicePath} 2>&1`);
        return { success: true };
      } catch (umountErr) {
        return { success: false, error: error.message || "Unmount failed" };
      }
    }
  }
});

ipcMain.handle("mount-device", async (event, devicePath) => {
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);

  try {
    const { stdout } = await execPromise(
      `udisksctl mount -b ${devicePath} 2>&1`,
    );

    const match = stdout.match(/at (.+?)\.?\s*$/);
    const mountpoint = match ? match[1].trim() : null;
    return { success: true, mountpoint };
  } catch (error) {
    try {
      await execPromise(`gio mount -d ${devicePath} 2>&1`);

      const { stdout: lsblkOut } = await execPromise(
        `lsblk -n -o MOUNTPOINT ${devicePath} 2>/dev/null`,
      );
      const mountpoint = lsblkOut.trim() || null;
      if (mountpoint) {
        return { success: true, mountpoint };
      }
    } catch (gioErr) {}
    return { success: false, error: error.message || "Mount failed" };
  }
});

// ============================================================================
// dialogs
// ============================================================================

ipcMain.handle("show-open-dialog", async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle("show-save-dialog", async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// ============================================================================
// metadata & preview
// ============================================================================

ipcMain.handle("read-file-preview", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);

    const MAX_PREVIEW_SIZE = 1024 * 1024;
    if (stats.size > MAX_PREVIEW_SIZE) {
      return { success: false, error: "File too large for preview" };
    }

    const ext = path.extname(filePath).toLowerCase();
    const textExtensions = [
      ".txt",
      ".md",
      ".json",
      ".xml",
      ".html",
      ".css",
      ".js",
      ".ts",
      ".py",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".hpp",
      ".rs",
      ".go",
      ".rb",
      ".php",
      ".sh",
      ".bat",
      ".yml",
      ".yaml",
      ".ini",
      ".conf",
      ".log",
      ".csv",
      ".tsv",
      ".sql",
      ".rtf",
      ".tex",
      ".latex",
    ];

    if (!textExtensions.includes(ext)) {
      return {
        success: false,
        error: "File type not supported for text preview",
      };
    }

    const content = await fs.readFile(filePath, "utf8");
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-image-metadata", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    let dimensions = null;

    try {
      dimensions = sizeOf(filePath);
    } catch (e) {}

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

ipcMain.handle("get-video-metadata", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      const { stdout } = await execPromise(
        `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}" 2>/dev/null`,
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
          videoFps: videoStream?.r_frame_rate
            ? (() => {
                const parts = videoStream.r_frame_rate.split("/");
                if (parts.length === 2) {
                  return parseFloat(parts[0]) / parseFloat(parts[1]);
                }
                return parseFloat(videoStream.r_frame_rate);
              })()
            : null,
          audioCodec: audioStream?.codec_name || null,
          audioChannels: audioStream?.channels || null,
          audioSampleRate: audioStream?.sample_rate || null,
        },
      };
    } catch (ffprobeError) {
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
