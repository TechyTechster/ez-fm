/**
 * EZ File Manager - Preload Script
 *
 * Securely exposes IPC methods to the renderer process via contextBridge.
 * Acts as a bridge between the sandboxed renderer and the main process.
 *
 * @license MIT
 */

const { contextBridge, ipcRenderer } = require("electron");

// ============================================================================
// IPC Bridge
// ============================================================================

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("fileManager", {
  // Directory operations
  getDirectoryContents: (dirPath) =>
    ipcRenderer.invoke("get-directory-contents", dirPath),
  getHomeDirectory: () => ipcRenderer.invoke("get-home-directory"),
  getCommonDirectories: () => ipcRenderer.invoke("get-common-directories"),
  getDrives: () => ipcRenderer.invoke("get-drives"),
  mountDevice: (devicePath) => ipcRenderer.invoke("mount-device", devicePath),
  unmountDevice: (devicePath) => ipcRenderer.invoke("unmount-device", devicePath),
  getParentDirectory: (currentPath) =>
    ipcRenderer.invoke("get-parent-directory", currentPath),

  // File operations
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  showInFolder: (filePath) => ipcRenderer.invoke("show-in-folder", filePath),
  openTerminal: (dirPath) => ipcRenderer.invoke("open-terminal", dirPath),
  deleteItem: (itemPath) => ipcRenderer.invoke("delete-item", itemPath),
  deleteItemSudo: (itemPath, password) => ipcRenderer.invoke("delete-item-sudo", itemPath, password),
  trashItem: (itemPath) => ipcRenderer.invoke("trash-item", itemPath),
  renameItem: (oldPath, newName) =>
    ipcRenderer.invoke("rename-item", oldPath, newName),
  createFolder: (parentPath, folderName) =>
    ipcRenderer.invoke("create-folder", parentPath, folderName),
  createFile: (parentPath, fileName) =>
    ipcRenderer.invoke("create-file", parentPath, fileName),
  copyItem: (sourcePath, destPath) =>
    ipcRenderer.invoke("copy-item", sourcePath, destPath),
  moveItem: (sourcePath, destPath) =>
    ipcRenderer.invoke("move-item", sourcePath, destPath),
  getItemInfo: (itemPath) => ipcRenderer.invoke("get-item-info", itemPath),
  readFilePreview: (filePath) => ipcRenderer.invoke("read-file-preview", filePath),
  getImageMetadata: (filePath) => ipcRenderer.invoke("get-image-metadata", filePath),
  getVideoMetadata: (filePath) => ipcRenderer.invoke("get-video-metadata", filePath),

  // Archive operations
  extractArchive: (archivePath, destPath) => ipcRenderer.invoke("extract-archive", archivePath, destPath),
  compressItems: (paths, outputPath) => ipcRenderer.invoke("compress-items", paths, outputPath),

  // Batch operations with progress
  batchFileOperation: (items, operation) => ipcRenderer.invoke("batch-file-operation", items, operation),
  onFileOperationProgress: (callback) => 
    ipcRenderer.on("file-operation-progress", (event, percent) => callback(percent)),

  // Clipboard
  clipboardCopyPaths: (paths) =>
    ipcRenderer.invoke("clipboard-copy-paths", paths),

  // Path utilities
  pathExists: (checkPath) => ipcRenderer.invoke("path-exists", checkPath),
  joinPaths: (...paths) => ipcRenderer.invoke("join-paths", ...paths),
  parsePath: (pathString) => ipcRenderer.invoke("parse-path", pathString),

  // Dialogs
  showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),
  showSaveDialog: (options) => ipcRenderer.invoke("show-save-dialog", options),

  // Window controls
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),
  
  // Picker controls
  pickerConfirm: (paths) => ipcRenderer.send("picker-confirm", paths),
  pickerCancel: () => ipcRenderer.send("picker-cancel"),

  // Platform info
  platform: process.platform,
});
