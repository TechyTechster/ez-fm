const { contextBridge, ipcRenderer } = require("electron");


const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);

const fileManagerApi = {
  getDirectoryContents: invoke("get-directory-contents"),
  getHomeDirectory: invoke("get-home-directory"),
  getCommonDirectories: invoke("get-common-directories"),
  getDrives: invoke("get-drives"),
  mountDevice: invoke("mount-device"),
  unmountDevice: invoke("unmount-device"),
  getParentDirectory: invoke("get-parent-directory"),
  getWalThemes: invoke("get-wal-themes"),

  openFile: invoke("open-file"),
  showInFolder: invoke("show-in-folder"),
  openTerminal: invoke("open-terminal"),
  deleteItem: invoke("delete-item"),
  deleteItemSudo: invoke("delete-item-sudo"),
  trashItem: invoke("trash-item"),
  renameItem: invoke("rename-item"),
  createFolder: invoke("create-folder"),
  createFile: invoke("create-file"),
  copyItem: invoke("copy-item"),
  moveItem: invoke("move-item"),
  getItemInfo: invoke("get-item-info"),
  readFilePreview: invoke("read-file-preview"),
  getImageMetadata: invoke("get-image-metadata"),
  getVideoMetadata: invoke("get-video-metadata"),

  extractArchive: invoke("extract-archive"),
  compressItems: invoke("compress-items"),

  batchFileOperation: invoke("batch-file-operation"),
  onFileOperationProgress: (callback) =>
    ipcRenderer.on("file-operation-progress", (event, percent) => callback(percent)),

  clipboardCopyPaths: invoke("clipboard-copy-paths"),

  pathExists: invoke("path-exists"),
  joinPaths: invoke("join-paths"),
  parsePath: invoke("parse-path"),

  showOpenDialog: invoke("show-open-dialog"),
  showSaveDialog: invoke("show-save-dialog"),

  minimizeWindow: send("window-minimize"),
  maximizeWindow: send("window-maximize"),
  closeWindow: send("window-close"),
  
  pickerConfirm: send("picker-confirm"),
  pickerCancel: send("picker-cancel"),

  platform: process.platform,
};

contextBridge.exposeInMainWorld("fileManager", fileManagerApi);
