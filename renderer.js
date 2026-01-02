/**
 * EZ File Manager - Renderer Process
 *
 * Handles the file manager UI, user interactions, file operations,
 * and view management. Implements virtual scrolling and lazy loading
 * for optimal memory usage.
 *
 * @license MIT
 */

// ============================================================================
// State Management
// ============================================================================

// Global state represents the *active* tab's state.
// When switching tabs, we save these globals to the old tab object
// and load the new tab's values into these globals.
let currentPath = "";
let history = [];
let historyIndex = -1;
let selectedItems = new Set();
let clipboardItems = [];
let clipboardOperation = null;
let currentItems = [];
let sortBy = "name";
let sortAscending = true;
let showHidden = false;
let calculateFolderSizes = true;
let fileTags = {}; // path -> ["red", "blue"]
let viewMode = "detailed"; // detailed, list, grid, thumbnail
let thumbnailSize = 140; // thumbnail size in pixels
let showPreviewPane = false;
let groupBy = "none"; // none, type, dateModified, dateAdded, size
let visibleColumns = { size: true, modified: true, added: true }; // column visibility
let viewSettingsCache = {}; // path -> { sortBy, sortAscending, groupBy, visibleColumns }
let commonDirs = {};
let collapsedGroups = new Set();
let pickerMode = null;

// Tab management
let tabs = [];
let activeTabIndex = -1;

// Customizable quick access (pins + built-ins)
const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];
const TAG_HEX = {
  red: "#ff5f57",
  orange: "#ffbd2e",
  yellow: "#ffcc00",
  green: "#28c940",
  blue: "#3578f6",
  purple: "#bd93f9",
  gray: "#8e8e93"
};

// PINS + BUILT-INS ARE STORED TOGETHER so you can reorder, unpin built-ins, etc.
const QUICK_ACCESS_STORAGE_KEY = "quickAccessItemsV1";
const DEFAULT_BUILTINS = [
  // default order
  { id: "trash", type: "builtin", key: "trash", label: "Trash" },
  { id: "root", type: "builtin", key: "root", label: "Root" },
  { id: "home", type: "builtin", key: "home", label: "Home" },
  { id: "desktop", type: "builtin", key: "desktop", label: "Desktop" },
  { id: "documents", type: "builtin", key: "documents", label: "Documents" },
  { id: "downloads", type: "builtin", key: "downloads", label: "Downloads" },
  { id: "pictures", type: "builtin", key: "pictures", label: "Pictures" },
  { id: "music", type: "builtin", key: "music", label: "Music" },
  { id: "videos", type: "builtin", key: "videos", label: "Videos" },
  { id: "config", type: "builtin", key: "config", label: ".config" },
];

// Built-in registry (used to repin built-ins with correct icon + metadata)
const BUILTIN_REGISTRY = DEFAULT_BUILTINS.reduce((acc, b) => {
  acc[b.key] = b;
  return acc;
}, {});

// Infer built-in key from a folder/label name (case-insensitive, tolerant).
// This lets us "go from the folder name" when deciding whether to repin as a built-in.
function inferBuiltinKeyFromName(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  if (!n) return null;

  const map = {
    trash: "trash",
    "recycle bin": "trash",

    root: "root",
    "/": "root",

    home: "home",
    "~": "home",

    desktop: "desktop",
    documents: "documents",
    downloads: "downloads",
    pictures: "pictures",
    music: "music",
    videos: "videos",

    ".config": "config",
    config: "config",
  };

  return map[n] || null;
}

// One list rendered in sidebar; each item:
// - builtin: { id, type:"builtin", key, label }
// - pin:     { id, type:"pin", path, label }
let quickAccessItems = [];
let pinnedListEl = null;
let drivesListEl = null;
let tagsListEl = null;

// Some platforms don’t expose Trash as a real filesystem directory.
// If Trash is not available, we fall back to opening the OS trash UI.
let hasRealTrashFolder = false;

// Whether the current view is the trash folder (exact match)
let isInTrash = false;

// Toolbar elements (set in init)
let newFolderBtn;
let newFileBtn;
let emptyTrashBtn;

// Drag and drop state
let draggedItems = []; // Array of paths being dragged
let isDragging = false;
let dragScrollInterval = null;
let draggedQaId = null; // Quick access item being reordered
let dragHoverTimer = null; // Timer for opening folders on drag hover
const DRAG_HOVER_DELAY = 800; // ms before opening folder on hover (while dragging)

// Context menu state (dynamic menu + submenu)
let contextMenuPanel;
let contextSubmenu;
let contextMenuMode = "background"; // "background" | "item" | "quickAccess"
let contextSubmenuOpen = false;

// Context menu pin target
let contextPinTargetPath = null;
let contextPinTargetLabel = null;

// Quick access context target (for move/unpin actions)
let contextQuickAccessId = null;

// Validate names for creating new items (folders/files)
function validateNewItemName(rawName) {
  const name = (rawName ?? "").trim();
  if (!name) return { ok: false, reason: "Name cannot be empty" };

  // Disallow path separators so users can't create nested paths by accident
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, reason: "Name cannot contain / or \\" };
  }

  // Disallow special directory entries
  if (name === "." || name === "..") {
    return { ok: false, reason: "Invalid name" };
  }

  // Basic Windows-invalid characters (also good to avoid generally)
  if (/[<>:"|?*]/.test(name)) {
    return {
      ok: false,
      reason: 'Name cannot contain any of: < > : " | ? *',
    };
  }

  return { ok: true, name };
}

function escapeHtmlAttr(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Custom modal prompt because window.prompt() can be blocked / disabled
function showTextInputModal(title, message, defaultValue, okLabel = "OK", inputType = "text") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-role", "fm-modal-overlay");
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: var(--modal-backdrop);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 6000;
    `;

    const dialog = document.createElement("div");
    dialog.setAttribute("data-role", "fm-modal");
    dialog.style.cssText = `
      width: 420px;
      max-width: calc(100vw - 32px);
      background: var(--bg-overlay);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 16px;
      color: var(--text-primary);
    `;

    dialog.innerHTML = `
      <div style="font-size: 14px; font-weight: 600; margin-bottom: 10px;">${escapeHtmlAttr(title)}</div>
      <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">${escapeHtmlAttr(message)}</div>
      <input data-role="fm-modal-input" type="${inputType}" value="${escapeHtmlAttr(defaultValue ?? "")}" style="
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        outline: none;
        font-size: 13px;
        box-sizing: border-box;
      "/>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top: 14px;">
        <button data-role="fm-modal-cancel" style="
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--border-color);
          background: var(--bg-tertiary);
          color: var(--text-primary);
          cursor: pointer;
        ">Cancel</button>
        <button data-role="fm-modal-ok" style="
          padding: 9px 12px;
          border-radius: 10px;
          border: none;
          background: var(--accent-color);
          color: white;
          cursor: pointer;
        ">${escapeHtmlAttr(okLabel)}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const input = dialog.querySelector('[data-role="fm-modal-input"]');
    const ok = dialog.querySelector('[data-role="fm-modal-ok"]');
    const cancel = dialog.querySelector('[data-role="fm-modal-cancel"]');

    const cleanup = () => overlay.remove();

    const finish = (val) => {
      cleanup();
      resolve(val);
    };

    ok.addEventListener("click", () => finish(input.value));
    cancel.addEventListener("click", () => finish(null));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
      if (e.key === "Escape") finish(null);
    });

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

// In-app confirm dialog for delete actions
function showDeleteChoiceModal(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-role", "fm-delete-overlay");
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: var(--modal-backdrop);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 6000;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      width: 460px;
      max-width: calc(100vw - 32px);
      background: var(--bg-overlay);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 16px;
      color: var(--text-primary);
    `;

    dialog.innerHTML = `
      <div style="font-size: 14px; font-weight: 700; margin-bottom: 10px;">${escapeHtmlAttr(title)}</div>
      <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 14px; line-height: 1.4;">${escapeHtmlAttr(message)}</div>
      <div style="display:flex; justify-content:flex-end; flex-wrap: wrap; gap:10px;">
        <button data-role="fm-del-cancel" style="
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--border-color);
          background: var(--bg-tertiary);
          color: var(--text-primary);
          cursor: pointer;
        ">Cancel</button>
        <button data-role="fm-del-trash" style="
          padding: 9px 12px;
          border-radius: 10px;
          border: none;
          background: var(--accent-color);
          color: white;
          cursor: pointer;
        ">Move to Trash</button>
        <button data-role="fm-del-perm" style="
          padding: 9px 12px;
          border-radius: 10px;
          border: none;
          background: var(--danger-color);
          color: white;
          cursor: pointer;
        ">Delete Permanently</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cancel = dialog.querySelector('[data-role="fm-del-cancel"]');
    const trash = dialog.querySelector('[data-role="fm-del-trash"]');
    const perm = dialog.querySelector('[data-role="fm-del-perm"]');

    const cleanup = () => overlay.remove();

    const finish = (val) => {
      cleanup();
      resolve(val);
    };

    cancel.addEventListener("click", () => finish("cancel"));
    trash.addEventListener("click", () => finish("trash"));
    perm.addEventListener("click", () => finish("permanent"));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish("cancel");
    });

    document.addEventListener(
      "keydown",
      function onKey(e) {
        if (e.key === "Escape") finish("cancel");
      },
      { once: true },
    );
  });
}

// Lazy async folder-size calculation (no toggle)
// - Only for visible folder rows
// - Cached by absolute path
// - Concurrency-limited to avoid UI jank
const folderSizeCache = new Map(); // path -> { size: number, mtime: number }
const folderSizeInFlight = new Map(); // path -> Promise<number|null>
const folderSizeQueue = [];
let folderSizeActive = 0;
const FOLDER_SIZE_CONCURRENCY = 3;
const FOLDER_SIZE_CACHE_TTL_MS = 5 * 60 * 1000;

// Memory optimization constants
const MAX_FOLDER_SIZE_CACHE_ENTRIES = 500;
const MAX_VIEW_SETTINGS_CACHE_ENTRIES = 100;
const MAX_HISTORY_LENGTH = 50;
const MAX_ITEMS_BEFORE_VIRTUAL_SCROLL = 200;
const MAX_LOADED_THUMBNAILS = 50; // Maximum number of thumbnails to keep loaded

// LRU cache helper - trims oldest entries when over limit
function trimCache(cache, maxEntries) {
  if (cache.size <= maxEntries) return;
  const entriesToRemove = cache.size - maxEntries;
  const keys = Array.from(cache.keys());
  for (let i = 0; i < entriesToRemove; i++) {
    cache.delete(keys[i]);
  }
}

// Trim object-based caches (like viewSettingsCache)
function trimObjectCache(obj, maxEntries) {
  const keys = Object.keys(obj);
  if (keys.length <= maxEntries) return;
  const entriesToRemove = keys.length - maxEntries;
  for (let i = 0; i < entriesToRemove; i++) {
    delete obj[keys[i]];
  }
}

// Thumbnail lazy loading with IntersectionObserver
let thumbnailObserver = null;
const loadedThumbnails = new Set(); // Track which elements have loaded thumbnails

function setupThumbnailObserver() {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }

  thumbnailObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const iconEl = entry.target;
      const path = iconEl.dataset.thumbPath;
      const fallbackIcon = iconEl.dataset.fallbackIcon;

      if (entry.isIntersecting) {
        // Load thumbnail when visible
        if (!iconEl.querySelector('img') && path) {
          const img = document.createElement('img');
          img.src = `file://${path}`;
          img.loading = 'lazy';
          img.draggable = false;
          img.onerror = () => {
            iconEl.innerHTML = fallbackIcon || '';
            loadedThumbnails.delete(iconEl);
          };
          img.onload = () => {
            loadedThumbnails.add(iconEl);
            // If we have too many thumbnails loaded, unload some off-screen ones
            if (loadedThumbnails.size > MAX_LOADED_THUMBNAILS) {
              unloadOffscreenThumbnails();
            }
          };
          iconEl.innerHTML = '';
          iconEl.appendChild(img);
        }
      }
    });
  }, {
    root: null,
    rootMargin: '100px', // Load slightly before entering viewport
    threshold: 0
  });
}

function unloadOffscreenThumbnails() {
  // Get all loaded thumbnails and check which are off-screen
  const toUnload = [];
  loadedThumbnails.forEach(iconEl => {
    const rect = iconEl.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Check if element is significantly off-screen (more than 500px away)
    const isOffscreen = rect.bottom < -500 || rect.top > viewportHeight + 500 ||
                        rect.right < -500 || rect.left > viewportWidth + 500;

    if (isOffscreen) {
      toUnload.push(iconEl);
    }
  });

  // Unload the oldest half of off-screen thumbnails
  const unloadCount = Math.min(toUnload.length, Math.floor(loadedThumbnails.size / 2));
  for (let i = 0; i < unloadCount; i++) {
    const iconEl = toUnload[i];
    const fallbackIcon = iconEl.dataset.fallbackIcon;
    if (fallbackIcon) {
      iconEl.innerHTML = fallbackIcon;
    }
    loadedThumbnails.delete(iconEl);
  }
}

function observeThumbnail(element) {
  if (thumbnailObserver && element) {
    thumbnailObserver.observe(element);
  }
}

function clearThumbnailObserver() {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }
  loadedThumbnails.clear();
}

// Virtual scrolling state
const ITEMS_PER_CHUNK = 50; // Number of items to render per chunk
let renderedItemCount = 0;
let filteredItems = []; // Store filtered/sorted items for chunked rendering
let isLoadingMore = false;
let scrollLoadObserver = null;

function setupScrollLoadObserver() {
  if (scrollLoadObserver) {
    scrollLoadObserver.disconnect();
  }

  scrollLoadObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !isLoadingMore && renderedItemCount < filteredItems.length) {
        loadMoreItems();
      }
    });
  }, {
    root: null,
    rootMargin: '200px',
    threshold: 0
  });
}

function loadMoreItems() {
  if (isLoadingMore || renderedItemCount >= filteredItems.length) return;
  isLoadingMore = true;

  const startIdx = renderedItemCount;
  const endIdx = Math.min(startIdx + ITEMS_PER_CHUNK, filteredItems.length);

  requestAnimationFrame(() => {
    const fragment = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      fragment.appendChild(renderItemForVirtualScroll(filteredItems[i]));
    }

    // Remove old sentinel if exists
    const oldSentinel = fileList.querySelector('.load-more-sentinel');
    if (oldSentinel) oldSentinel.remove();

    fileList.appendChild(fragment);
    renderedItemCount = endIdx;

    // Add new sentinel if there are more items
    if (renderedItemCount < filteredItems.length) {
      const sentinel = document.createElement('div');
      sentinel.className = 'load-more-sentinel';
      sentinel.style.height = '1px';
      fileList.appendChild(sentinel);
      if (scrollLoadObserver) {
        scrollLoadObserver.observe(sentinel);
      }
    }

    isLoadingMore = false;
    scheduleVisibleFolderSizes();
  });
}

// Store reference to renderItem function for virtual scroll
let renderItemForVirtualScroll = null;

// SVG Icons
const icons = {
  folder: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23,7 16,12 23,17 23,7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21,8 21,21 3,21 3,8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></svg>`,
  executable: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16 10,8"/></svg>`,
  spreadsheet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
  presentation: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
};

// File type configurations
const fileTypes = {
  folder: {
    icon: icons.folder,
    color: "#ffd866",
  },
  image: {
    icon: icons.image,
    color: "#ff79c6",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "svg",
      "webp",
      "ico",
      "tiff",
    ],
  },
  video: {
    icon: icons.video,
    color: "#bd93f9",
    extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"],
  },
  audio: {
    icon: icons.audio,
    color: "#8be9fd",
    extensions: ["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a"],
  },
  document: {
    icon: icons.document,
    color: "#50fa7b",
    extensions: ["pdf", "doc", "docx", "txt", "rtf", "odt", "md"],
  },
  spreadsheet: {
    icon: icons.spreadsheet,
    color: "#69ff94",
    extensions: ["xls", "xlsx", "csv", "ods"],
  },
  presentation: {
    icon: icons.presentation,
    color: "#ffb86c",
    extensions: ["ppt", "pptx", "odp"],
  },
  archive: {
    icon: icons.archive,
    color: "#ff5555",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  },
  code: {
    icon: icons.code,
    color: "#f1fa8c",
    extensions: [
      "js",
      "ts",
      "py",
      "java",
      "c",
      "cpp",
      "h",
      "css",
      "html",
      "json",
      "xml",
      "php",
      "rb",
      "go",
      "rs",
      "swift",
      "kt",
      "sh",
      "bat",
    ],
  },
  executable: {
    icon: icons.executable,
    color: "#ff5555",
    extensions: ["exe", "msi", "app", "dmg", "deb", "rpm"],
  },
  default: {
    icon: icons.file,
    color: "#f8f8f2",
  },
};

// DOM Elements
let fileList;
let pathSegments;
let searchInput;
let itemCountEl;
let selectedCountEl;
let currentPathEl;
let contextMenu;
let previewPanel;
let previewContent;
let tabBarEl;
let progressBarContainer;
let progressBarFill;

let viewMenu;
let viewModeBtn;
let sortBtn;
let groupBtn;
let settingsMenu;
let settingsBtn;

// Initialize
async function init() {
  // Get DOM elements
  fileList = document.getElementById("file-grid");
  pathSegments = document.getElementById("path-segments");
  searchInput = document.getElementById("search-input");
  itemCountEl = document.getElementById("item-count");
  selectedCountEl = document.getElementById("selected-count");
  currentPathEl = document.getElementById("current-path");
  contextMenu = document.getElementById("context-menu");
  contextMenuPanel = document.getElementById("context-menu-panel");
  contextSubmenu = document.getElementById("context-submenu");
  tabBarEl = document.getElementById("tab-bar");
  progressBarContainer = document.getElementById("progress-bar-container");
  progressBarFill = document.getElementById("progress-bar-fill");
  viewMenu = document.getElementById("view-menu");
  viewModeBtn = document.getElementById("view-mode-btn");
  sortBtn = document.getElementById("sort-btn");
  groupBtn = document.getElementById("group-btn");
  settingsMenu = document.getElementById("settings-menu");
  settingsBtn = document.getElementById("settings-btn");

  // Sidebar containers
  pinnedListEl = document.getElementById("pinned-list");
  drivesListEl = document.getElementById("drives-list");
  tagsListEl = document.getElementById("tags-list");

  // Toolbar elements
  newFolderBtn = document.getElementById("new-folder-btn");
  newFileBtn = document.getElementById("new-file-btn");
  emptyTrashBtn = document.getElementById("empty-trash-btn");

  // Preview panel elements
  previewPanel = document.getElementById("preview-panel");
  previewContent = document.getElementById("preview-content");

  try {
    // Check for startPath from URL params (passed by main process)
    const params = new URLSearchParams(window.location.search);
    const startPathArg = params.get("startPath");
    currentPath = startPathArg || await window.fileManager.getHomeDirectory();
    
    // Picker Mode Initialization
    const isPicker = params.get("picker") === "true";
    if (isPicker) {
      pickerMode = params.get("pickerMode") || "open";
      const multiple = params.get("allowMultiple") === "true";
      const defaultFilename = params.get("defaultFilename") || "";
      initPickerMode(pickerMode, multiple, defaultFilename);
    }

    // Load essential preferences BEFORE first render
    try {
      const saved = localStorage.getItem("showHidden");
      if (saved !== null) showHidden = saved === "true";
    } catch {}

    // Fast path for picker mode - skip non-essential loading
    if (pickerMode) {
      // Show picker immediately, then load files
      document.documentElement.classList.add('picker-ready');

      // Show loading state
      const fileList = document.getElementById("file-grid");
      if (fileList) fileList.innerHTML = '<div style="padding: 20px; color: var(--text-secondary);">Loading...</div>';

      // Load files
      await navigateTo(currentPath);

      // Load sidebar data in background (non-blocking)
      window.fileManager.getCommonDirectories().then(dirs => {
        commonDirs = dirs;
        hasRealTrashFolder = Boolean(dirs && dirs.trash);
        loadQuickAccessItems();
        renderPinnedItems();
      });
      renderDisks(); // Don't await
    } else {
      // Full initialization for file manager mode
      commonDirs = await window.fileManager.getCommonDirectories();
      hasRealTrashFolder = Boolean(commonDirs && commonDirs.trash);
      loadQuickAccessItems();
      renderPinnedItems();
      await renderDisks();

      // Load persisted file tags
      try {
        const savedTags = localStorage.getItem("fileTags");
        if (savedTags) fileTags = JSON.parse(savedTags);
      } catch {}

      renderTagsSidebar();

      // Load persisted calculate-folder-sizes preference
      try {
        const savedCalc = localStorage.getItem("calculateFolderSizes");
        if (savedCalc !== null) calculateFolderSizes = savedCalc === "true";
      } catch {}

      // Load persisted preview-pane preference
      try {
        const savedPreview = localStorage.getItem("showPreviewPane");
        if (savedPreview !== null) showPreviewPane = savedPreview === "true";
      } catch {}

      // Load persisted thumbnail size
      try {
        const savedThumbSize = localStorage.getItem("thumbnailSize");
        if (savedThumbSize !== null) thumbnailSize = parseInt(savedThumbSize, 10) || 140;
        updateThumbnailSizeCSS();
      } catch {}

      // Load per-folder view settings
      try {
        viewSettingsCache = JSON.parse(localStorage.getItem("folderViewSettings") || "{}");
      } catch {
        viewSettingsCache = {};
      }

      // Load persisted folder size cache
      try {
        const savedSizes = localStorage.getItem("folderSizeCache");
        if (savedSizes) {
          const parsed = JSON.parse(savedSizes);
          for (const [path, data] of Object.entries(parsed)) {
            folderSizeCache.set(path, data);
          }
          // Trim to limit on load
          trimCache(folderSizeCache, MAX_FOLDER_SIZE_CACHE_ENTRIES);
        }
      } catch {}

      await navigateTo(currentPath);
    }

    // Initialize first tab
    tabs.push({
      id: Date.now(),
      path: currentPath,
      history: [currentPath],
      historyIndex: 0,
      selectedItems: new Set(),
      scrollTop: 0
    });
    await activateTab(0);

    setupEventListeners();
    setupTabEventListeners();
    setupThumbnailObserver();

    // Ensure UI matches persisted hidden-files state on first load
    renderFiles();
    updateStatusBar();
    updatePreviewPanelVisibility();
  } catch (error) {
    console.error("Initialization error:", error);
    showNotification("Failed to initialize: " + error.message, "error");
  }

  // Listen for progress events from main process
  window.fileManager.onFileOperationProgress((percent) => {
    setProgress(percent);
  });
}

function initPickerMode(mode, multiple, defaultFilename) {
  document.body.classList.add("picker-mode");
  
  const footer = document.createElement("div");
  footer.className = "picker-footer";
  
  const hiddenToggleHtml = `<button class="picker-btn toggle-hidden ${showHidden ? 'active' : ''}" id="picker-hidden-toggle" title="Show Hidden Files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>`;

  if (mode === 'save') {
    footer.innerHTML = `
      <div class="picker-status" style="flex: 1; display: flex; align-items: center; gap: 10px;">
        <span>Name:</span>
        <input type="text" id="picker-filename-input" class="picker-input" placeholder="Filename" style="flex: 1; max-width: 400px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary); outline: none;">
      </div>
      <div class="picker-actions">
        ${hiddenToggleHtml}
        <button class="picker-btn new-folder" id="picker-new-folder-btn" title="Create New Folder">New Folder</button>
        <button class="picker-btn cancel" id="picker-cancel-btn">Cancel</button>
        <button class="picker-btn confirm" id="picker-confirm-btn">Save</button>
      </div>
    `;
  } else if (mode === 'directory') {
    footer.innerHTML = `
      <div class="picker-status">
        Select Directory: <span id="picker-selection-label"></span>
      </div>
      <div class="picker-actions">
        ${hiddenToggleHtml}
        <button class="picker-btn new-folder" id="picker-new-folder-btn" title="Create New Folder">New Folder</button>
        <button class="picker-btn cancel" id="picker-cancel-btn">Cancel</button>
        <button class="picker-btn confirm" id="picker-confirm-btn">Select</button>
      </div>
    `;
  } else {
    footer.innerHTML = `
      <div class="picker-status">
        Select File: <span id="picker-selection-label"></span>
      </div>
      <div class="picker-actions">
        ${hiddenToggleHtml}
        <button class="picker-btn cancel" id="picker-cancel-btn">Cancel</button>
        <button class="picker-btn confirm" id="picker-confirm-btn">Select</button>
      </div>
    `;
  }

  document.querySelector(".app-container").appendChild(footer);

  const confirmBtn = document.getElementById("picker-confirm-btn");
  const cancelBtn = document.getElementById("picker-cancel-btn");
  const filenameInput = document.getElementById("picker-filename-input");
  const newFolderPickerBtn = document.getElementById("picker-new-folder-btn");
  const hiddenToggleBtn = document.getElementById("picker-hidden-toggle");

  // New Folder button handler
  if (newFolderPickerBtn) {
    newFolderPickerBtn.addEventListener("click", () => {
      createNewFolder();
    });
  }

  // Hidden files toggle handler
  if (hiddenToggleBtn) {
    hiddenToggleBtn.addEventListener("click", () => {
      showHidden = !showHidden;
      hiddenToggleBtn.classList.toggle("active", showHidden);
      try { localStorage.setItem("showHidden", String(showHidden)); } catch {}
      renderFiles();
    });
  }

  // Initial state
  if (mode === 'open') confirmBtn.disabled = true;
  if (mode === 'save') confirmBtn.disabled = true;
  
  if (mode === 'save' && defaultFilename) {
    filenameInput.value = defaultFilename;
    confirmBtn.disabled = false;
  }

  cancelBtn.addEventListener("click", () => {
    window.fileManager.pickerCancel();
  });

  confirmBtn.addEventListener("click", async () => {
    if (mode === 'save') {
      const name = filenameInput.value.trim();
      if (!name) return;

      const fullPath = await window.fileManager.joinPaths(currentPath, name);
      window.fileManager.pickerConfirm([fullPath]);
      return;
    }

    if (mode === 'directory') {
      const items = Array.from(selectedItems);
      if (items.length > 0) {
        window.fileManager.pickerConfirm(items);
      } else {
        window.fileManager.pickerConfirm([currentPath]);
      }
    } else {
      // open
      const items = Array.from(selectedItems);
      if (items.length > 0) {
        window.fileManager.pickerConfirm(items);
      }
    }
  });

  // Update label on selection change
  const originalUpdateSelectionUI = updateSelectionUI;
  updateSelectionUI = () => {
    originalUpdateSelectionUI();
    
    if (mode === 'open') {
      // Only enable if at least one file is selected (folders don't count)
      const hasFile = Array.from(selectedItems).some(p => {
        const item = currentItems.find(i => i.path === p);
        return item && !item.isDirectory;
      });
      confirmBtn.disabled = !hasFile;
      const label = document.getElementById("picker-selection-label");
      if (label) label.textContent = Array.from(selectedItems).map(p => p.split(/[/\\]/).pop()).join(", ");
    } else if (mode === 'directory') {
      const label = document.getElementById("picker-selection-label");
      if (label) {
        label.textContent = selectedItems.size > 0 
          ? Array.from(selectedItems).map(p => p.split(/[/\\]/).pop()).join(", ")
          : currentPath;
      }
    }
  };

  if (filenameInput) {
    filenameInput.focus();
    filenameInput.addEventListener("input", () => {
      confirmBtn.disabled = !filenameInput.value.trim();
    });
    filenameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click();
    });
  }
}

// ---- Tab Management ----

async function activateTab(index) {
  if (index < 0 || index >= tabs.length) return;

  // Save state of currently active tab
  if (activeTabIndex !== -1 && tabs[activeTabIndex]) {
    const currentTab = tabs[activeTabIndex];
    currentTab.path = currentPath;
    currentTab.history = [...history];
    currentTab.historyIndex = historyIndex;
    currentTab.selectedItems = new Set(selectedItems);
    currentTab.scrollTop = fileList ? fileList.scrollTop : 0;
  }

  activeTabIndex = index;
  const tab = tabs[index];

  // Restore state
  currentPath = tab.path;
  history = [...tab.history];
  historyIndex = tab.historyIndex;
  selectedItems = new Set(tab.selectedItems);
  
  // Render tabs UI to show active state
  renderTabs();

  // Load content for the new tab
  try {
    const result = await window.fileManager.getDirectoryContents(currentPath);
    if (result.success) {
      currentItems = result.contents;
      
      // Handle archive mode
      const appContainer = document.querySelector(".app-container");
      if (result.isArchive) appContainer.classList.add("archive-mode");
      else appContainer.classList.remove("archive-mode");

      applyViewSettings(currentPath);
      updateUI();
      renderFiles();
      updateStatusBar();
      updatePreviewPanelVisibility();

      // Restore scroll position
      if (fileList) fileList.scrollTop = tab.scrollTop;
    }
  } catch (e) {
    console.error("Failed to load tab content", e);
  }
}

async function createNewTab(path) {
  const startPath = path || (await window.fileManager.getHomeDirectory());
  tabs.push({
    id: Date.now() + Math.random(),
    path: startPath,
    history: [startPath],
    historyIndex: 0,
    selectedItems: new Set(),
    scrollTop: 0
  });
  await activateTab(tabs.length - 1);
}

async function closeTab(index, e) {
  if (e) e.stopPropagation();
  
  if (tabs.length <= 1) {
    // Don't close the last tab, maybe just navigate home?
    // Or close app? For now, let's just reset it to home.
    const home = await window.fileManager.getHomeDirectory();
    if (tabs[0].path !== home) {
      await navigateTo(home);
    }
    return;
  }

  tabs.splice(index, 1);
  
  // If we closed the active tab, switch to the previous one (or 0)
  if (index === activeTabIndex) {
    // Reset active index so activateTab doesn't try to save the closed tab
    activeTabIndex = -1; 
    const newIndex = Math.max(0, index - 1);
    await activateTab(newIndex);
  } else {
    // If we closed a tab before the active one, decrement index
    if (index < activeTabIndex) {
      activeTabIndex--;
    }
    renderTabs();
  }
}

function renderTabs() {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = tabs.map((tab, i) => `
    <div class="tab ${i === activeTabIndex ? 'active' : ''}" data-tab-index="${i}">
      <div class="tab-icon">${icons.folder}</div>
      <div class="tab-title" title="${escapeHtmlAttr(tab.path)}">${escapeHtml(tab.path.split(/[/\\]/).pop() || tab.path)}</div>
      <div class="tab-close" data-tab-close="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </div>
    </div>
  `).join("") + `
    <div class="new-tab-btn" data-new-tab title="New Tab">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </div>
  `;
}

function setupTabEventListeners() {
  if (!tabBarEl) return;

  let dragHoverTimeout = null;
  let dragHoverTabIndex = null;

  tabBarEl.addEventListener('click', async (e) => {
    // Check for new tab button
    const newTabBtn = e.target.closest('[data-new-tab]');
    if (newTabBtn) {
      await createNewTab();
      return;
    }

    // Check for close button
    const closeBtn = e.target.closest('[data-tab-close]');
    if (closeBtn) {
      const index = parseInt(closeBtn.dataset.tabClose, 10);
      await closeTab(index, e);
      return;
    }

    // Check for tab click
    const tab = e.target.closest('[data-tab-index]');
    if (tab) {
      const index = parseInt(tab.dataset.tabIndex, 10);
      await activateTab(index);
    }
  });

  // Drag-hover to switch tabs after 800ms
  tabBarEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const tab = e.target.closest('[data-tab-index]');
    if (!tab) {
      clearTimeout(dragHoverTimeout);
      dragHoverTabIndex = null;
      return;
    }

    const index = parseInt(tab.dataset.tabIndex, 10);
    if (index === activeTabIndex) return; // Already on this tab

    if (dragHoverTabIndex !== index) {
      clearTimeout(dragHoverTimeout);
      dragHoverTabIndex = index;
      dragHoverTimeout = setTimeout(async () => {
        if (dragHoverTabIndex === index) {
          await activateTab(index);
        }
      }, 800);
    }
  });

  tabBarEl.addEventListener('dragleave', (e) => {
    // Only clear if leaving the tab bar entirely
    if (!tabBarEl.contains(e.relatedTarget)) {
      clearTimeout(dragHoverTimeout);
      dragHoverTabIndex = null;
    }
  });

  tabBarEl.addEventListener('drop', () => {
    clearTimeout(dragHoverTimeout);
    dragHoverTabIndex = null;
  });
}

// Setup event listeners
function setupEventListeners() {
  // Window controls
  // Navigation buttons
  document.getElementById("back-btn").addEventListener("click", goBack);
  document.getElementById("forward-btn").addEventListener("click", goForward);
  document.getElementById("up-btn").addEventListener("click", goUp);
  document.getElementById("refresh-btn").addEventListener("click", refresh);

  // Sidebar toggle (for small screens)
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebar = document.getElementById("sidebar");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");

  if (sidebarToggleBtn && sidebar && sidebarBackdrop) {
    const toggleSidebar = () => {
      const isOpen = sidebar.classList.toggle("open");
      sidebarBackdrop.classList.toggle("visible", isOpen);
    };

    const closeSidebar = () => {
      sidebar.classList.remove("open");
      sidebarBackdrop.classList.remove("visible");
    };

    sidebarToggleBtn.addEventListener("click", toggleSidebar);
    sidebarBackdrop.addEventListener("click", closeSidebar);

    // Close sidebar when navigating on small screens
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest(".sidebar-item, .nav-item")) {
        // Only close if we're in mobile overlay mode
        if (window.innerWidth <= 800) {
          closeSidebar();
        }
      }
    });

    // Close overlay when window becomes large enough to show sidebar normally
    window.addEventListener("resize", () => {
      if (window.innerWidth > 800) {
        closeSidebar();
      }
    });
  }

  // Search
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderFiles();
    });
  }

  // Sort select
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      const value = e.target.value;
      if (value.startsWith("-")) {
        sortBy = value.slice(1);
        sortAscending = false;
      } else {
        sortBy = value;
        sortAscending = true;
      }
      renderFiles();
    });
  }

  // Group select
  const groupSelect = document.getElementById("group-select");
  if (groupSelect) {
    groupSelect.addEventListener("change", (e) => {
      groupBy = e.target.value;
      renderFiles();
    });
  }

  // New folder button
  if (newFolderBtn) {
    newFolderBtn.addEventListener("click", (e) => {
      console.log("[ui] new-folder-btn clicked");
      e.preventDefault();
      e.stopPropagation();
      createNewFolder();
    });
  }

  // New file button
  if (newFileBtn) {
    newFileBtn.addEventListener("click", (e) => {
      console.log("[ui] new-file-btn clicked");
      e.preventDefault();
      e.stopPropagation();
      createNewFile();
    });
  }

  // Empty trash button (2x1 button shown only when in Trash)
  if (emptyTrashBtn) {
    emptyTrashBtn.addEventListener("click", async (e) => {
      console.log("[ui] empty-trash-btn clicked");
      e.preventDefault();
      e.stopPropagation();
      await emptyTrash();
    });
  }

  // Toggle hidden button (persist across sessions)
  const toggleHiddenBtn = document.getElementById("toggle-hidden-btn");
  if (toggleHiddenBtn) {
    try {
      const saved = localStorage.getItem("showHidden");
      if (saved !== null) {
        showHidden = saved === "true";
      }
    } catch {
      // ignore storage errors
    }

    toggleHiddenBtn.classList.toggle("active", showHidden);

    toggleHiddenBtn.addEventListener("click", () => {
      showHidden = !showHidden;
      toggleHiddenBtn.classList.toggle("active", showHidden);
      try {
        localStorage.setItem("showHidden", String(showHidden));
      } catch {
        // ignore storage errors
      }
      renderFiles();
      updateStatusBar();
    });
  }

  // Toggle preview pane button
  const togglePreviewBtn = document.getElementById("toggle-preview-btn");
  if (togglePreviewBtn) {
    togglePreviewBtn.classList.toggle("active", showPreviewPane);

    togglePreviewBtn.addEventListener("click", () => {
      showPreviewPane = !showPreviewPane;
      togglePreviewBtn.classList.toggle("active", showPreviewPane);
      try {
        localStorage.setItem("showPreviewPane", String(showPreviewPane));
      } catch {
        // ignore
      }
      updatePreviewPanelVisibility();
    });
  }

  // View Mode Button
  if (viewModeBtn) {
    viewModeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleViewMenu("view", viewModeBtn);
    });
  }

  // Sort Button
  if (sortBtn) {
    sortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleViewMenu("sort", sortBtn);
    });
  }

  // Group Button
  if (groupBtn) {
    groupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleViewMenu("group", groupBtn);
    });
  }

  // Settings Button (Bottom Left)
  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSettingsMenu();
    });
  }

  // Context menu - hide on click (and close submenu)
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".context-menu")) {
      hideContextMenu();
    }

    // Close view menu when clicking elsewhere
    if (viewMenu && viewMenu.style.display === "block") {
      if (
        !viewMenu.contains(e.target) &&
        e.target !== viewModeBtn &&
        e.target !== sortBtn &&
        e.target !== groupBtn
      ) {
        viewMenu.style.display = "none";
      }
    }

    // Close settings menu when clicking elsewhere
    if (settingsMenu && settingsMenu.style.display === "block") {
      if (!settingsMenu.contains(e.target) && e.target !== settingsBtn) {
        settingsMenu.style.display = "none";
      }
    }
  });

  // Close submenu when leaving the context menu
  if (contextMenu) {
    contextMenu.addEventListener("mouseleave", () => {
      closeContextSubmenu();
    });
  }

  // File list context menu
  if (fileList) {
    fileList.addEventListener("contextmenu", (e) => {
      e.preventDefault();

      // Reset pin target on each open
      contextPinTargetPath = null;
      contextPinTargetLabel = null;

      // Treat it as an item context menu ONLY if the right-click happened inside the file list
      // AND the closest `.file-item` is still contained by `fileList`.
      // This prevents background right-clicks from accidentally picking a nearby item.
      const candidate = e.target.closest(".file-item");
      const fileItem =
        candidate && fileList.contains(candidate) ? candidate : null;

      if (fileItem) {
        contextMenuMode = "item";
        if (!selectedItems.has(fileItem.dataset.path)) {
          selectedItems.clear();
          selectedItems.add(fileItem.dataset.path);
          updateSelectionUI();
        }

        // Pin source: selected (exactly one)
        if (selectedItems.size === 1) {
          const p = Array.from(selectedItems)[0];
          const it = currentItems.find((x) => x.path === p);
          if (it && it.isDirectory) {
            contextPinTargetPath = it.path;
            contextPinTargetLabel = it.name;
          }
        }
      } else {
        contextMenuMode = "background";
        selectedItems.clear();
        updateSelectionUI();

        // Pin source: current folder
        contextPinTargetPath = currentPath;
        contextPinTargetLabel = "Pinned";
      }

      renderContextMenu();
      showContextMenu(e.clientX, e.clientY);
    });

    // Click on file list background to deselect
    fileList.addEventListener("click", (e) => {
      if (e.target === fileList) {
        selectedItems.clear();
        updateSelectionUI();
      }
    });

    // File list drop zone - drop files into current folder
    fileList.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";

      // Auto-scroll when near edges
      const rect = fileList.getBoundingClientRect();
      const edgeSize = 50;
      const scrollSpeed = 10;

      clearInterval(dragScrollInterval);

      if (e.clientY < rect.top + edgeSize) {
        // Near top - scroll up
        dragScrollInterval = setInterval(() => {
          fileList.scrollTop -= scrollSpeed;
        }, 16);
      } else if (e.clientY > rect.bottom - edgeSize) {
        // Near bottom - scroll down
        dragScrollInterval = setInterval(() => {
          fileList.scrollTop += scrollSpeed;
        }, 16);
      }

      // Only show drop target on background
      if (e.target === fileList || e.target.closest(".file-item")?.dataset.isDirectory !== "true") {
        fileList.classList.add("drop-target");
      }
    });

    // Allow scroll wheel while dragging
    fileList.addEventListener("wheel", (e) => {
      if (isDragging) {
        fileList.scrollTop += e.deltaY;
      }
    }, { passive: true });

    fileList.addEventListener("dragleave", (e) => {
      // Only remove if leaving the file list entirely
      if (!fileList.contains(e.relatedTarget)) {
        fileList.classList.remove("drop-target");
        clearInterval(dragScrollInterval);
        dragScrollInterval = null;
      }
    });

    fileList.addEventListener("drop", async (e) => {
      e.preventDefault();
      fileList.classList.remove("drop-target");
      clearInterval(dragScrollInterval);
      dragScrollInterval = null;

      // Only handle drops on the background, not on folders
      const targetFolder = e.target.closest(".file-item");
      if (targetFolder?.dataset.isDirectory === "true") return;

      // Handle internal drag
      if (draggedItems.length > 0) {
        const isCopy = e.ctrlKey;
        await handleFileDrop(draggedItems, currentPath, isCopy);
        return;
      }

      // Handle external file drop
      if (e.dataTransfer.files.length > 0) {
        const externalPaths = Array.from(e.dataTransfer.files).map((f) => f.path);
        await handleFileDrop(externalPaths, currentPath, true);
      }
    });
  }

  // Quick access sidebar (event delegation)
  // No await here: quick access lazily loads directories on click.
  setupQuickAccess();

  // Keyboard shortcuts
  document.addEventListener("keydown", handleKeyboard);
}

// Setup quick access sidebar (event delegation so clicks on SVG/text always work)
function setupQuickAccess() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  sidebar.addEventListener("click", async (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;

    e.preventDefault();

    const pathType = item.dataset.path;
    if (!pathType) return;

    // Lazily load common directories if needed
    if (!commonDirs || Object.keys(commonDirs).length === 0) {
      try {
        commonDirs = await window.fileManager.getCommonDirectories();
      } catch (err) {
        showNotification("Quick access: failed to load directories", "error");
        return;
      }
    }

    // Special-case Trash:
    // - If we have a real trash directory path, navigate to it.
    // - Otherwise, open the OS trash UI by calling "show in folder" on a dummy path
    //   (not all platforms support browsing trash as a normal folder).
    if (pathType === "trash") {
      if (commonDirs.trash) {
        try {
          await navigateTo(commonDirs.trash);
          return;
        } catch (err) {
          showNotification("Trash: cannot open folder", "error");
          return;
        }
      }

      // No real trash folder path provided by the OS
      showNotification(
        "Trash folder is not available on this platform",
        "error",
      );
      return;
    }

    const targetPath = commonDirs[pathType];
    if (!targetPath) {
      showNotification(`Quick access: "${pathType}" not available`, "error");
      return;
    }

    try {
      await navigateTo(targetPath);
      // Do NOT manually toggle .active here.
      // Highlight is synced based on currentPath in syncQuickAccessHighlight().
    } catch (err) {
      showNotification("Quick access: cannot open that directory", "error");
    }
  });

  // Sidebar drag and drop
  sidebar.addEventListener("dragover", (e) => {
    // Ignore if reordering quick access items
    if (draggedQaId) return;

    // Accept both internal drags (draggedItems) and external file drops
    const hasInternalDrag = draggedItems.length > 0;
    const hasExternalDrag = e.dataTransfer.types.includes("Files");
    if (!hasInternalDrag && !hasExternalDrag) return;

    e.preventDefault();
    e.stopPropagation();

    // Clear previous drop targets
    sidebar.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));

    // Check if hovering over a sidebar item (pinned or builtin)
    const sidebarItem = e.target.closest(".sidebar-item, .nav-item");
    if (sidebarItem) {
      const pinnedPath = sidebarItem.dataset.pinnedPath;
      const builtinKey = sidebarItem.dataset.builtinKey;
      const tagColor = sidebarItem.dataset.tagColor;

      if (pinnedPath || builtinKey) {
        // Hovering over a folder - will move items into it
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        sidebarItem.classList.add("drop-target");
        sidebar.classList.remove("drag-over");

        // Hover to open after delay
        if (!dragHoverTimer) {
          const targetPath = pinnedPath || (commonDirs && commonDirs[builtinKey]);
          if (targetPath) {
            dragHoverTimer = setTimeout(async () => {
              dragHoverTimer = null;
              if (sidebarItem.classList.contains("drop-target")) {
                await navigateTo(targetPath);
              }
            }, DRAG_HOVER_DELAY);
          }
        }
        return;
      } else if (tagColor) {
        // Hovering over a tag - will apply tag
        e.dataTransfer.dropEffect = "link";
        sidebarItem.classList.add("drop-target");
        sidebar.classList.remove("drag-over");
        return;
      }
    }

    // Clear hover timer when not over a valid target
    if (dragHoverTimer) {
      clearTimeout(dragHoverTimer);
      dragHoverTimer = null;
    }

    // Hovering over sidebar background - will pin folders
    e.dataTransfer.dropEffect = "link";
    sidebar.classList.add("drag-over");
  });

  sidebar.addEventListener("dragleave", (e) => {
    const sidebarItem = e.target.closest(".sidebar-item, .nav-item");
    if (sidebarItem) {
      sidebarItem.classList.remove("drop-target");
    }
    if (!sidebar.contains(e.relatedTarget)) {
      sidebar.classList.remove("drag-over");
      sidebar.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
      // Clear hover timer when leaving sidebar
      if (dragHoverTimer) {
        clearTimeout(dragHoverTimer);
        dragHoverTimer = null;
      }
    }
  });

  sidebar.addEventListener("drop", async (e) => {
    // Ignore if reordering quick access items (handled by item's own drop handler)
    if (draggedQaId) return;

    e.preventDefault();
    e.stopPropagation();
    sidebar.classList.remove("drag-over");
    sidebar.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));

    // Clear hover timer
    if (dragHoverTimer) {
      clearTimeout(dragHoverTimer);
      dragHoverTimer = null;
    }

    // Collect paths to process (internal drag or external files)
    let pathsToProcess = [];
    if (draggedItems.length > 0) {
      pathsToProcess = [...draggedItems];
    } else if (e.dataTransfer.files.length > 0) {
      pathsToProcess = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
    }

    if (pathsToProcess.length === 0) return;

    // Check if dropped on a sidebar item
    const sidebarItem = e.target.closest(".sidebar-item, .nav-item");
    if (sidebarItem) {
      const pinnedPath = sidebarItem.dataset.pinnedPath;
      const builtinKey = sidebarItem.dataset.builtinKey;
      const tagColor = sidebarItem.dataset.tagColor;

      let targetPath = null;

      if (pinnedPath) {
        targetPath = pinnedPath;
      } else if (builtinKey && commonDirs && commonDirs[builtinKey]) {
        targetPath = commonDirs[builtinKey];
      }

      if (targetPath) {
        const isCopy = e.ctrlKey;
        await handleFileDrop(pathsToProcess, targetPath, isCopy);
        return;
      }

      if (tagColor) {
        let taggedCount = 0;
        for (const itemPath of pathsToProcess) {
          if (!fileTags[itemPath]) fileTags[itemPath] = [];
          if (!fileTags[itemPath].includes(tagColor)) {
            fileTags[itemPath].push(tagColor);
            taggedCount++;
          }
        }

        if (taggedCount > 0) {
          try { localStorage.setItem("fileTags", JSON.stringify(fileTags)); } catch {}
          showNotification(`Tagged ${taggedCount} item(s) as ${tagColor}`);
          
          // Refresh view to show new tags
          if (currentPath === `tag://${tagColor}`) navigateTo(currentPath);
          else renderFiles();
        }
        return;
      }
    }

    // Dropped on sidebar background - pin folders to quick access
    let pinCount = 0;
    for (const itemPath of pathsToProcess) {
      // First try to find item in current view
      const item = currentItems.find((i) => i.path === itemPath);
      if (item && item.isDirectory) {
        addPin(item.path, item.name);
        pinCount++;
      } else if (!item) {
        // Item not in current view (external drop or different directory)
        // Check if it's a directory via the API
        try {
          const info = await window.api.getItemInfo(itemPath);
          if (info.success && info.info.isDirectory) {
            const label = itemPath.split(/[/\\]/).filter(Boolean).pop() || itemPath;
            addPin(itemPath, label);
            pinCount++;
          }
        } catch (err) {
          // Skip items we can't access
        }
      }
    }

    if (pinCount > 0) {
      renderPinnedItems();
      showNotification(`Pinned ${pinCount} folder(s) to Quick Access`);
    }
  });
}

function normalizePathForCompare(p) {
  if (!p) return "";
  let n = String(p);
  // On Windows, normalize backslashes to forward slashes for consistent comparison
  if (window.fileManager && window.fileManager.platform === "win32") {
    n = n.replace(/\\/g, "/");
  }
  // remove trailing separators for stable comparisons
  n = n.replace(/[/\\]+$/, "");
  return n === "" ? "/" : n;
}

function loadQuickAccessItems() {
  try {
    const raw = localStorage.getItem(QUICK_ACCESS_STORAGE_KEY);
    if (!raw) {
      quickAccessItems = [...DEFAULT_BUILTINS];
      saveQuickAccessItems();
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      quickAccessItems = [...DEFAULT_BUILTINS];
      saveQuickAccessItems();
      return;
    }

    quickAccessItems = parsed
      .filter(
        (x) => x && typeof x.id === "string" && typeof x.type === "string",
      )
      .map((x) => {
        if (x.type === "builtin") {
          return {
            id: x.id,
            type: "builtin",
            key: String(x.key || ""),
            label: String(x.label || x.key || ""),
          };
        }

        // pin
        return {
          id: x.id,
          type: "pin",
          path: normalizePathForCompare(String(x.path || "")),
          label:
            typeof x.label === "string" && x.label.trim()
              ? x.label.trim()
              : String(x.path || "")
                  .split(/[/\\]/)
                  .filter(Boolean)
                  .pop() || String(x.path || ""),
        };
      })
      .filter((x) => (x.type === "builtin" ? Boolean(x.key) : Boolean(x.path)));

    // Ensure we always have at least something
    if (quickAccessItems.length === 0) {
      quickAccessItems = [...DEFAULT_BUILTINS];
      saveQuickAccessItems();
    }
  } catch {
    quickAccessItems = [...DEFAULT_BUILTINS];
    saveQuickAccessItems();
  }
}

function saveQuickAccessItems() {
  try {
    localStorage.setItem(
      QUICK_ACCESS_STORAGE_KEY,
      JSON.stringify(quickAccessItems),
    );
  } catch {
    // ignore
  }
}

function resolveQuickAccessPath(item) {
  if (!item) return null;

  if (item.type === "pin") return item.path || null;

  // builtin
  if (!commonDirs) return null;
  return commonDirs[item.key] || null;
}

function isQuickAccessExactActive(item) {
  const target = normalizePathForCompare(resolveQuickAccessPath(item));
  const cur = normalizePathForCompare(currentPath);
  return Boolean(target) && cur === target;
}

function isPinnedExact(pathToCheck) {
  const needle = normalizePathForCompare(pathToCheck);
  return quickAccessItems.some(
    (x) => x.type === "pin" && normalizePathForCompare(x.path) === needle,
  );
}

function addPin(pathToPin, label) {
  const p = normalizePathForCompare(pathToPin);
  if (!p) return;
  if (isPinnedExact(p)) return;

  const niceLabel =
    (label && String(label).trim()) ||
    p.split(/[/\\]/).filter(Boolean).pop() ||
    p;

  // If the label matches a known built-in, repin as built-in (keeps built-in icon)
  const inferredKey = inferBuiltinKeyFromName(niceLabel);
  if (
    inferredKey &&
    BUILTIN_REGISTRY[inferredKey] &&
    !hasBuiltin(inferredKey)
  ) {
    repinBuiltin(inferredKey);
    return;
  }

  quickAccessItems.unshift({
    id: `pin:${p}`,
    type: "pin",
    path: p,
    label: niceLabel,
  });

  saveQuickAccessItems();
  renderPinnedItems();
  syncQuickAccessHighlight();
}

function hasBuiltin(key) {
  return quickAccessItems.some((x) => x.type === "builtin" && x.key === key);
}

function repinBuiltin(keyOrName) {
  // Accept either an explicit builtin key or a human name (folder/label)
  const inferred = BUILTIN_REGISTRY[keyOrName]
    ? keyOrName
    : inferBuiltinKeyFromName(keyOrName);

  if (!inferred) return;

  const b = BUILTIN_REGISTRY[inferred];
  if (!b) return;

  if (hasBuiltin(b.key)) return;

  // Insert near the top; user can move it afterward
  quickAccessItems.unshift({
    id: b.id,
    type: "builtin",
    key: b.key,
    label: b.label,
  });

  saveQuickAccessItems();
  renderPinnedItems();
  syncQuickAccessHighlight();
}

function removeQuickAccessById(id) {
  quickAccessItems = quickAccessItems.filter((x) => x.id !== id);
  saveQuickAccessItems();
  renderPinnedItems();
  syncQuickAccessHighlight();
}

function moveQuickAccess(id, direction) {
  const idx = quickAccessItems.findIndex((x) => x.id === id);
  if (idx < 0) return;

  const next = idx + direction;
  if (next < 0 || next >= quickAccessItems.length) return;

  const copy = [...quickAccessItems];
  const [item] = copy.splice(idx, 1);
  copy.splice(next, 0, item);
  quickAccessItems = copy;

  saveQuickAccessItems();
  renderPinnedItems();
  syncQuickAccessHighlight();
}

function renderPinnedItems() {
  if (!pinnedListEl) return;

  pinnedListEl.innerHTML = "";

  // Built-in specific icons + normal folder icon for pins
  const ICONS = {
    folder: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/></svg>`,
    desktop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    documents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    downloads: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    pictures: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>`,
    music: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    videos: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23,7 16,12 23,17 23,7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    config: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
    root: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h16"/><path d="M12 4v16"/></svg>`,
  };

  const iconForQuickAccess = (qa) => {
    if (qa.type === "pin") return ICONS.folder;
    const key = String(qa.key || "");
    return ICONS[key] || ICONS.folder;
  };

  for (const qa of quickAccessItems) {
    const targetPath = resolveQuickAccessPath(qa);
    const label = qa.label || (qa.type === "builtin" ? qa.key : qa.path);

    const row = document.createElement("div");
    row.className = "sidebar-item nav-item pinned-item";
    row.dataset.qaId = qa.id;
    row.draggable = true;

    // used for exact highlight checks
    if (qa.type === "pin") row.dataset.pinnedPath = qa.path;
    if (qa.type === "builtin") row.dataset.builtinKey = qa.key;

    row.innerHTML = `
      ${iconForQuickAccess(qa)}
      <span>${escapeHtmlAttr(label)}</span>
    `;

    // Drag to reorder
    row.addEventListener("dragstart", (e) => {
      // Only start reorder drag if not dragging files
      if (draggedItems.length > 0) return;
      draggedQaId = qa.id;
      row.classList.add("quick-access-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", qa.id);
    });

    row.addEventListener("dragend", () => {
      draggedQaId = null;
      row.classList.remove("quick-access-dragging");
      // Remove all insert indicators
      pinnedListEl.querySelectorAll(".quick-access-insert-line").forEach((el) => el.remove());
      pinnedListEl.querySelectorAll(".quick-access-drop-target").forEach((el) => el.classList.remove("quick-access-drop-target"));
    });

    row.addEventListener("dragover", (e) => {
      // Handle reordering quick access items
      if (draggedQaId && draggedQaId !== qa.id) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";

        // Remove previous indicators
        pinnedListEl.querySelectorAll(".quick-access-insert-line").forEach((el) => el.remove());
        pinnedListEl.querySelectorAll(".quick-access-drop-target").forEach((el) => el.classList.remove("quick-access-drop-target"));

        // Show insert indicator
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midY;

        const line = document.createElement("div");
        line.className = "quick-access-insert-line";
        line.style.top = insertBefore ? "-1px" : `${rect.height - 1}px`;
        row.style.position = "relative";
        row.appendChild(line);
      }
    });

    row.addEventListener("dragleave", () => {
      row.querySelectorAll(".quick-access-insert-line").forEach((el) => el.remove());
      row.classList.remove("quick-access-drop-target");
    });

    row.addEventListener("drop", (e) => {
      if (draggedQaId && draggedQaId !== qa.id) {
        e.preventDefault();
        e.stopPropagation();

        // Calculate insert position
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midY;

        // Reorder the array
        const fromIdx = quickAccessItems.findIndex((x) => x.id === draggedQaId);
        const toIdx = quickAccessItems.findIndex((x) => x.id === qa.id);

        if (fromIdx !== -1 && toIdx !== -1) {
          const [item] = quickAccessItems.splice(fromIdx, 1);
          const newIdx = insertBefore ? toIdx : toIdx + 1;
          // Adjust for removal
          const adjustedIdx = fromIdx < toIdx ? newIdx - 1 : newIdx;
          quickAccessItems.splice(adjustedIdx, 0, item);
          saveQuickAccessItems();
          renderPinnedItems();
        }
      }
    });

    row.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!targetPath) return;
      await navigateTo(targetPath);
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextMenuMode = "quickAccess";
      contextPinTargetPath = targetPath;
      contextPinTargetLabel = label;
      // reuse pin target id for move/unpin
      contextQuickAccessId = qa.id;
      renderContextMenu();
      showContextMenu(e.clientX, e.clientY);
    });

    // exact highlight
    if (isQuickAccessExactActive(qa)) row.classList.add("active");

    pinnedListEl.appendChild(row);
  }
}

async function renderDisks() {
  if (!drivesListEl) return;
  drivesListEl.innerHTML = "";

  let drives = [];
  try {
    drives = await window.fileManager.getDrives();
  } catch {
    drives = [];
  }

  // Remove "Home" entry from disks list (as requested)
  // (we already have Home via quick access)
  const filtered = drives.filter((d) => {
    const name = String(d?.name || "").toLowerCase();
    const p = String(d?.path || "");
    if (name === "home") return false;
    if (
      p &&
      commonDirs?.home &&
      normalizePathForCompare(p) === normalizePathForCompare(commonDirs.home)
    ) {
      return false;
    }
    return true;
  });

  for (const d of filtered) {
    const row = document.createElement("div");
    row.className = "sidebar-item nav-item drive-item";
    if (!d.mounted) {
      row.classList.add("unmounted");
    }
    if (d.readonly) {
      row.classList.add("readonly");
    }
    row.dataset.drivePath = d.path;
    if (d.device) row.dataset.device = d.device;
    row.dataset.mounted = d.mounted ? "true" : "false";
    row.dataset.readonly = d.readonly ? "true" : "false";

    // Different icon for unmounted vs mounted, with lock indicator for readonly
    const lockIcon = d.readonly && d.mounted
      ? `<svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0110 0v4"></path>
        </svg>`
      : "";

    const driveIcon = d.mounted
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <path d="M3 9h18"></path>
        </svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4 2"></rect>
          <path d="M3 9h18" stroke-dasharray="4 2"></path>
        </svg>`;

    let barHtml = "";
    if (d.space && d.space.total > 0) {
      const used = d.space.total - d.space.free;
      const percent = Math.min(100, Math.max(0, (used / d.space.total) * 100));
      
      let usageClass = "";
      if (percent > 90) usageClass = "critical";

      barHtml = `
        <div class="drive-usage-bar-container" title="Free: ${formatSize(d.space.free)} / Total: ${formatSize(d.space.total)}">
          <div class="drive-usage-bar-fill ${usageClass}" style="width: ${percent}%"></div>
        </div>`;
    }

    const showEject = d.mounted && d.path !== "/" && d.device;
    const ejectIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 19H3v-2h18v2zm-9-14l-7 10h14l-7-10z"/></svg>`;

    row.innerHTML = `
      <span class="drive-icon-wrapper">${driveIcon}${lockIcon}</span>
      <div class="drive-info"><span class="drive-label">${escapeHtmlAttr(d.name || d.path)}</span>${barHtml}</div>
      ${showEject ? `<button class="drive-eject-btn" title="Unmount">${ejectIcon}</button>` : ""}
    `;

    // Eject button handler
    if (showEject) {
      const btn = row.querySelector(".drive-eject-btn");
      if (btn) {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const result = await window.fileManager.unmountDevice(d.device);
            if (result.success) {
              showNotification(`Unmounted ${d.name || d.device}`);
              await renderDisks();
              if (currentPath.startsWith(d.path)) {
                await navigateTo(await window.fileManager.getHomeDirectory());
              }
            } else {
              showNotification(result.error || "Could not unmount", "error");
            }
          } catch (err) {
            showNotification("Unmount failed: " + err.message, "error");
          }
        });
      }
    }

    // Click to navigate or mount
    row.addEventListener("click", async (e) => {
      e.preventDefault();
      if (d.mounted) {
        await navigateTo(d.path);
      } else {
        // Try to mount via udisksctl (common on Linux)
        try {
          const result = await window.fileManager.mountDevice(d.device);
          if (result.success && result.mountpoint) {
            showNotification(`Mounted ${d.name || d.device}`);
            await renderDisks(); // Refresh disk list
            await navigateTo(result.mountpoint);
          } else {
            showNotification(result.error || "Could not mount device", "error");
          }
        } catch (err) {
          showNotification("Mount failed: " + err.message, "error");
        }
      }
    });

    // Context menu for drives
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDriveContextMenu(e, d);
    });

    // Drag and drop support for mounted writable drives
    if (d.mounted && !d.readonly) {
      row.addEventListener("dragover", (e) => {
        if (draggedItems.length === 0 && !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation(); // Prevent sidebar handler from interfering
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        row.classList.add("drop-target");

        // Hover to open after delay
        if (!dragHoverTimer) {
          dragHoverTimer = setTimeout(async () => {
            dragHoverTimer = null;
            if (row.classList.contains("drop-target")) {
              await navigateTo(d.path);
            }
          }, DRAG_HOVER_DELAY);
        }
      });

      row.addEventListener("dragleave", (e) => {
        e.stopPropagation();
        row.classList.remove("drop-target");
        if (dragHoverTimer) {
          clearTimeout(dragHoverTimer);
          dragHoverTimer = null;
        }
      });

      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation(); // Prevent sidebar handler
        row.classList.remove("drop-target");
        if (dragHoverTimer) {
          clearTimeout(dragHoverTimer);
          dragHoverTimer = null;
        }

        let pathsToProcess = [];
        if (draggedItems.length > 0) {
          pathsToProcess = [...draggedItems];
        } else if (e.dataTransfer.files.length > 0) {
          pathsToProcess = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
        }

        if (pathsToProcess.length > 0) {
          const isCopy = e.ctrlKey;
          await handleFileDrop(pathsToProcess, d.path, isCopy);
        }
      });
    }

    drivesListEl.appendChild(row);
  }
}

// Show context menu for drives
function showDriveContextMenu(e, drive) {
  const items = [];

  const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
  const ICON_MOUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
  const ICON_UNMOUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

  if (drive.mounted) {
    items.push({
      label: "Open",
      icon: ICON_OPEN,
      onClick: async () => {
        await navigateTo(drive.path);
      },
    });

    // Don't allow unmounting root
    if (drive.path !== "/" && drive.device) {
      items.push({ type: "separator" });
      items.push({
        label: "Unmount",
        icon: ICON_UNMOUNT,
        onClick: async () => {
          try {
            const result = await window.fileManager.unmountDevice(drive.device);
            if (result.success) {
              showNotification(`Unmounted ${drive.name || drive.device}`);
              await renderDisks();
              // If we were viewing this drive, go home
              if (currentPath.startsWith(drive.path)) {
                await navigateTo(await window.fileManager.getHomeDirectory());
              }
            } else {
              showNotification(result.error || "Could not unmount", "error");
            }
          } catch (err) {
            showNotification("Unmount failed: " + err.message, "error");
          }
        },
      });
    }
  } else {
    items.push({
      label: "Mount",
      icon: ICON_MOUNT,
      onClick: async () => {
        try {
          const result = await window.fileManager.mountDevice(drive.device);
          if (result.success && result.mountpoint) {
            showNotification(`Mounted ${drive.name || drive.device}`);
            await renderDisks();
            await navigateTo(result.mountpoint);
          } else {
            showNotification(result.error || "Could not mount", "error");
          }
        } catch (err) {
          showNotification("Mount failed: " + err.message, "error");
        }
      },
    });
  }

  // Render and show menu
  renderMenuItems(contextMenuPanel, items);
  showContextMenu(e.clientX, e.clientY);
}

function renderTagsSidebar() {
  if (!tagsListEl) return;
  tagsListEl.innerHTML = "";

  TAG_COLORS.forEach((color) => {
    const row = document.createElement("div");
    row.className = "sidebar-item nav-item tag-item";
    row.dataset.tagColor = color;
    
    const dot = document.createElement("div");
    dot.className = "sidebar-tag-dot";
    dot.style.backgroundColor = TAG_HEX[color];

    const label = document.createElement("span");
    label.textContent = color.charAt(0).toUpperCase() + color.slice(1);

    row.appendChild(dot);
    row.appendChild(label);

    row.addEventListener("click", () => {
      navigateTo(`tag://${color}`);
    });

    tagsListEl.appendChild(row);
  });
}

async function ensureCommonDirsLoaded() {
  if (commonDirs && Object.keys(commonDirs).length > 0) return;
  commonDirs = await window.fileManager.getCommonDirectories();
}

// Highlight quick access only when currentPath is within the corresponding target dir.
// If you navigate elsewhere, all quick access items are unhighlighted.
async function syncQuickAccessHighlight() {
  const items = Array.from(document.querySelectorAll(".nav-item"));
  if (items.length === 0) return;

  try {
    await ensureCommonDirsLoaded();
  } catch {
    // If we can't load common dirs, just clear highlight.
    items.forEach((i) => i.classList.remove("active"));
    return;
  }

  const cur = normalizePathForCompare(currentPath);
  let anyMatched = false;

  for (const item of items) {
    // Pinned items highlight (exact match)
    if (item.classList.contains("pinned-item")) {
      item.classList.remove("active");

      const qaId = item.dataset.qaId;
      const qa = quickAccessItems.find((q) => q.id === qaId);
      const targetPath = resolveQuickAccessPath(qa);

      if (targetPath && normalizePathForCompare(targetPath) === cur) {
        item.classList.add("active");
        anyMatched = true;
      }
      continue;
    }

    // Disks items highlight (exact match)
    if (item.classList.contains("drive-item")) {
      item.classList.remove("active");
      const p = normalizePathForCompare(item.dataset.drivePath);
      if (p && cur === p) {
        item.classList.add("active");
        anyMatched = true;
      }
      continue;
    }
  }

  if (!anyMatched) {
    items.forEach((i) => i.classList.remove("active"));
  }
  
  // Also sync tags highlight (which might clear tag selection if we are in a normal folder)
  syncTagsHighlight();
}

function syncTagsHighlight() {
  if (!tagsListEl) return;
  const items = tagsListEl.querySelectorAll(".tag-item");
  const isTagView = currentPath.startsWith("tag://");
  const currentColor = isTagView ? currentPath.replace("tag://", "") : null;

  items.forEach(item => {
    if (isTagView && item.dataset.tagColor === currentColor) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// Navigate to path
async function navigateTo(path) {
  // Handle Tag Views
  if (path.startsWith("tag://")) {
    const color = path.replace("tag://", "");
    currentPath = path;
    
    // Find all files with this tag
    const paths = Object.entries(fileTags)
      .filter(([p, tags]) => tags.includes(color))
      .map(([p]) => p);
      
    // Fetch info for each tagged file
    const items = [];
    for (const p of paths) {
      try {
        const res = await window.fileManager.getItemInfo(p);
        if (res.success) {
          const info = res.info;
          // Ensure extension is present for icon rendering
          if (!info.extension && info.isFile) {
             const extMatch = info.name.match(/\.([^.]+)$/);
             info.extension = extMatch ? "." + extMatch[1] : "";
          }
          items.push(info);
        }
      } catch (e) {
        // File might have been deleted externally
      }
    }
    
    currentItems = items;
    finishNavigation();
    // Clear quick access highlights since we are in a tag view
    document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
    syncTagsHighlight();
    return;
  }

  try {
    const result = await window.fileManager.getDirectoryContents(path);

    if (result.success) {
      currentPath = result.path;
      currentItems = result.contents;

      // Handle archive mode visual indicator
      const appContainer = document.querySelector(".app-container");
      if (result.isArchive) {
        appContainer.classList.add("archive-mode");
      } else {
        appContainer.classList.remove("archive-mode");
      }

      // Apply smart view settings for this folder
      applyViewSettings(currentPath);
      collapsedGroups.clear();

      // Update current tab's path and render tabs
      if (activeTabIndex !== -1 && tabs[activeTabIndex]) {
        tabs[activeTabIndex].path = currentPath;
      }
      renderTabs();

      finishNavigation();
      
      // Post-navigation logic for normal folders
      isInTrash = Boolean(commonDirs && commonDirs.trash) &&
        normalizePathForCompare(currentPath) === normalizePathForCompare(commonDirs.trash);
      updateToolbarForTrash();
      syncQuickAccessHighlight();
      scheduleVisibleFolderSizes();
    } else {
      showNotification("Error: " + result.error, "error");
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

// Expose for HTML onclick handlers
window.activateTab = activateTab;
window.closeTab = closeTab;
window.createNewTab = createNewTab;

function finishNavigation() {
  // Clear pending folder size calculations from previous directory
  folderSizeQueue.length = 0;

  // Clear loaded thumbnails to free memory
  clearThumbnailObserver();
  setupThumbnailObserver();

  // Reset virtual scroll state
  if (scrollLoadObserver) {
    scrollLoadObserver.disconnect();
  }
  filteredItems = [];
  renderedItemCount = 0;
  isLoadingMore = false;

  // Update history
  if (historyIndex === -1 || history[historyIndex] !== currentPath) {
    history = history.slice(0, historyIndex + 1);
    history.push(currentPath);
    historyIndex = history.length - 1;

    // Trim history to limit memory usage
    if (history.length > MAX_HISTORY_LENGTH) {
      const overflow = history.length - MAX_HISTORY_LENGTH;
      history = history.slice(overflow);
      historyIndex -= overflow;
    }
  }

  updateUI();
  renderFiles();
  selectedItems.clear();
  updateStatusBar();
}

// ---- View Settings Logic ----

function applyViewSettings(path) {
  const key = normalizePathForCompare(path);
  const defaultColumns = { size: true, modified: true, added: true };

  if (viewSettingsCache[key]) {
    // Use saved settings
    const s = viewSettingsCache[key];
    sortBy = s.sortBy || "name";
    sortAscending = typeof s.sortAscending === "boolean" ? s.sortAscending : true;
    groupBy = s.groupBy || "none";
    viewMode = s.viewMode || "detailed";
    visibleColumns = s.visibleColumns || defaultColumns;
  } else {
    // Smart defaults
    if (commonDirs && commonDirs.downloads && normalizePathForCompare(commonDirs.downloads) === key) {
      // Downloads: Date Descending, Group by Date
      sortBy = "date";
      sortAscending = false;
      groupBy = "dateModified";
      viewMode = "detailed";
      visibleColumns = defaultColumns;
    } else {
      // Default: Name Ascending, No Grouping
      sortBy = "name";
      sortAscending = true;
      groupBy = "none";
      viewMode = "detailed";
      visibleColumns = defaultColumns;
    }
  }
  applyColumnVisibility();
}

function applyColumnVisibility() {
  const fileListContainer = document.querySelector(".file-list-container");
  if (!fileListContainer) return;

  fileListContainer.classList.toggle("hide-size", !visibleColumns.size);
  fileListContainer.classList.toggle("hide-modified", !visibleColumns.modified);
  fileListContainer.classList.toggle("hide-added", !visibleColumns.added);
}

function updateThumbnailSizeCSS() {
  document.documentElement.style.setProperty('--thumbnail-size', `${thumbnailSize}px`);
}

function saveCurrentViewSettings() {
  const key = normalizePathForCompare(currentPath);
  viewSettingsCache[key] = { sortBy, sortAscending, groupBy, viewMode, visibleColumns };
  try {
    // Trim cache to limit memory/storage use
    trimObjectCache(viewSettingsCache, MAX_VIEW_SETTINGS_CACHE_ENTRIES);
    localStorage.setItem("folderViewSettings", JSON.stringify(viewSettingsCache));
  } catch {
    // ignore
  }
}

let activeMenuType = null; // "view", "sort", "group"

function toggleViewMenu(type, btn) {
  if (!viewMenu) return;

  // Close settings menu if open
  if (settingsMenu && settingsMenu.style.display === "block") {
    settingsMenu.style.display = "none";
  }

  if (viewMenu.style.display === "block" && activeMenuType === type) {
    viewMenu.style.display = "none";
    activeMenuType = null;
    return;
  }

  activeMenuType = type;
  renderViewMenu(type);
  viewMenu.style.display = "block";

  // Position menu above the button
  if (btn) {
    const rect = btn.getBoundingClientRect();
    
    // Constrain height to available space above button (with margin)
    const availableHeight = rect.top - 16;
    viewMenu.style.maxHeight = `${Math.max(100, availableHeight)}px`;
    viewMenu.style.overflowY = "auto";

    const menuWidth = viewMenu.offsetWidth;

    let left = rect.left;
    // Prevent overflow
    if (left + menuWidth > window.innerWidth) {
      left = window.innerWidth - menuWidth - 8;
    }
    if (left < 8) left = 8;

    viewMenu.style.left = `${left}px`;
    viewMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    viewMenu.style.top = "auto";
  }
}

function renderViewMenu(type) {
  if (!viewMenu) return;
  viewMenu.innerHTML = "";

  const createOption = (label, isActive, onClick) => {
    const div = document.createElement("div");
    div.className = `context-menu-item`;
    div.innerHTML = `
      <span style="flex:1">${escapeHtml(label)}</span>
      ${isActive 
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-hover)"><polyline points="20 6 9 17 4 12"/></svg>` 
        : `<div style="width:16px"></div>`}
    `;
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      viewMenu.style.display = "none";
    });
    return div;
  };

  const createHeader = (text) => {
    const div = document.createElement("div");
    div.className = "context-menu-header";
    div.textContent = text;
    return div;
  };

  const createSep = () => {
    const div = document.createElement("div");
    div.className = "context-menu-separator";
    return div;
  };

  const updateSort = (newSort) => {
    if (sortBy === newSort) {
      sortAscending = !sortAscending;
    } else {
      sortBy = newSort;
      sortAscending = newSort === "name";
    }
    saveCurrentViewSettings();
    renderFiles();
  };

  const updateGroup = (newGroup) => {
    groupBy = newGroup;
    collapsedGroups.clear();
    saveCurrentViewSettings();
    renderFiles();
  };

  const updateView = (newView) => {
    viewMode = newView;
    saveCurrentViewSettings();
    renderFiles();
  };

  const toggleColumn = (col) => {
    visibleColumns[col] = !visibleColumns[col];
    applyColumnVisibility();
    saveCurrentViewSettings();
  };

  if (type === "view") {
    viewMenu.appendChild(createHeader("View Mode"));
    viewMenu.appendChild(createOption("Detailed", viewMode === "detailed", () => updateView("detailed")));
    viewMenu.appendChild(createOption("List", viewMode === "list", () => updateView("list")));
    viewMenu.appendChild(createOption("Grid", viewMode === "grid", () => updateView("grid")));
    viewMenu.appendChild(createOption("Thumbnail", viewMode === "thumbnail", () => updateView("thumbnail")));

    // Column visibility (only relevant for detailed view)
    if (viewMode === "detailed") {
      viewMenu.appendChild(createSep());
      viewMenu.appendChild(createHeader("Columns"));
      viewMenu.appendChild(createOption("Size", visibleColumns.size, () => toggleColumn("size")));
      viewMenu.appendChild(createOption("Date Modified", visibleColumns.modified, () => toggleColumn("modified")));
      viewMenu.appendChild(createOption("Date Added", visibleColumns.added, () => toggleColumn("added")));
    }

    // Thumbnail Size Slider (only in thumbnail view)
    if (viewMode === "thumbnail") {
      const div = document.createElement("div");
      div.className = "context-menu-item";
      div.style.flexDirection = "column";
      div.style.alignItems = "stretch";
      div.style.cursor = "default";
      div.style.paddingBottom = "12px";
      
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">
          <span>Thumbnail Size</span>
          <span id="thumb-size-display">${thumbnailSize}px</span>
        </div>
        <input type="range" min="80" max="300" step="10" value="${thumbnailSize}" style="width:100%; cursor:pointer;">
      `;
      
      div.addEventListener("click", (e) => e.stopPropagation());
      const range = div.querySelector("input");
      const display = div.querySelector("#thumb-size-display");
      range.addEventListener("input", (e) => {
        thumbnailSize = parseInt(e.target.value, 10);
        display.textContent = `${thumbnailSize}px`;
        updateThumbnailSizeCSS();
        try { localStorage.setItem("thumbnailSize", thumbnailSize); } catch {}
      });
      viewMenu.appendChild(div);
    }
  } else if (type === "sort") {
    viewMenu.appendChild(createHeader("Sort By"));
    viewMenu.appendChild(createOption("Name", sortBy === "name", () => updateSort("name")));
    viewMenu.appendChild(createOption("Date Modified", sortBy === "date", () => updateSort("date")));
    viewMenu.appendChild(createOption("Date Added", sortBy === "added", () => updateSort("added")));
    viewMenu.appendChild(createOption("Size", sortBy === "size", () => updateSort("size")));
    viewMenu.appendChild(createOption("Type", sortBy === "type", () => updateSort("type")));

    viewMenu.appendChild(createSep());

    viewMenu.appendChild(createHeader("Order"));
    viewMenu.appendChild(createOption("Ascending", sortAscending, () => {
      sortAscending = true;
      saveCurrentViewSettings();
      renderFiles();
    }));
    viewMenu.appendChild(createOption("Descending", !sortAscending, () => {
      sortAscending = false;
      saveCurrentViewSettings();
      renderFiles();
    }));
  } else if (type === "group") {
    viewMenu.appendChild(createHeader("Group By"));
    viewMenu.appendChild(createOption("None", groupBy === "none", () => updateGroup("none")));
    viewMenu.appendChild(createOption("Type", groupBy === "type", () => updateGroup("type")));
    viewMenu.appendChild(createOption("Date Modified", groupBy === "dateModified", () => updateGroup("dateModified")));
    viewMenu.appendChild(createOption("Date Added", groupBy === "dateAdded", () => updateGroup("dateAdded")));
    viewMenu.appendChild(createOption("Size", groupBy === "size", () => updateGroup("size")));
  }
}

function toggleSettingsMenu() {
  if (!settingsMenu) return;

  // Close view menu if open
  if (viewMenu && viewMenu.style.display === "block") {
    viewMenu.style.display = "none";
  }

  if (settingsMenu.style.display === "block") {
    settingsMenu.style.display = "none";
    return;
  }

  renderSettingsMenu();
  settingsMenu.style.display = "block";

  // Position menu above the button
  if (settingsBtn) {
    const rect = settingsBtn.getBoundingClientRect();
    
    // Constrain height to available space above button (with margin)
    const availableHeight = rect.top - 16;
    settingsMenu.style.maxHeight = `${Math.max(100, availableHeight)}px`;
    settingsMenu.style.overflowY = "auto";

    const menuWidth = settingsMenu.offsetWidth;

    let left = rect.left;
    // Prevent overflow
    if (left + menuWidth > window.innerWidth) {
      left = window.innerWidth - menuWidth - 8;
    }
    if (left < 8) left = 8;

    settingsMenu.style.left = `${left}px`;
    settingsMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    settingsMenu.style.top = "auto";
  }
}

function renderSettingsMenu() {
  if (!settingsMenu) return;
  settingsMenu.innerHTML = "";

  const createOption = (label, isActive, onClick) => {
    const div = document.createElement("div");
    div.className = `context-menu-item`;
    div.innerHTML = `
      <span style="flex:1">${escapeHtml(label)}</span>
      ${isActive 
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-hover)"><polyline points="20 6 9 17 4 12"/></svg>` 
        : `<div style="width:16px"></div>`}
    `;
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      // Don't close immediately for toggles, or do? Let's close for now to be standard
      settingsMenu.style.display = "none";
    });
    return div;
  };

  const createHeader = (text) => {
    const div = document.createElement("div");
    div.className = "context-menu-header";
    div.textContent = text;
    return div;
  };

  const createSep = () => {
    const div = document.createElement("div");
    div.className = "context-menu-separator";
    return div;
  };

  const appearanceHeader = createHeader("Appearance");
  appearanceHeader.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align: -3px; margin-right: 8px;">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.38 0 2.69-.28 3.89-.77l-1.4-1.4c-.63.3-1.31.47-2.02.47-4.42 0-8-3.58-8-8s3.58-8 8-8c.71 0 1.39.17 2.02.47l1.4-1.4C14.69 2.28 13.38 2 12 2z"/><path d="M18 6a2 2 0 0 0-2-2c-1.11 0-2 .9-2 2a2 2 0 0 0 2 2c1.11 0 2-.9 2-2z"/><path d="M20 12a2 2 0 0 0-2-2c-1.11 0-2 .9-2 2a2 2 0 0 0 2 2c1.11 0 2-.9 2-2z"/><path d="M18 18a2 2 0 0 0-2-2c-1.11 0-2 .9-2 2a2 2 0 0 0 2 2c1.11 0 2-.9 2-2z"/><path d="M14 12a2 2 0 0 0-2-2c-1.11 0-2 .9-2 2a2 2 0 0 0 2 2c1.11 0 2-.9 2-2z"/>
    </svg>
    <span>Appearance</span>
  `;
  settingsMenu.appendChild(appearanceHeader);
  settingsMenu.appendChild(createOption("Show Preview Pane", showPreviewPane, () => {
    showPreviewPane = !showPreviewPane;
    try { localStorage.setItem("showPreviewPane", String(showPreviewPane)); } catch {}
    updatePreviewPanelVisibility();
  }));
  settingsMenu.appendChild(createOption("Show Hidden Files", showHidden, () => {
    showHidden = !showHidden;
    try { localStorage.setItem("showHidden", String(showHidden)); } catch {}
    renderFiles();
    updateStatusBar();
  }));
  settingsMenu.appendChild(createOption("Calculate Folder Sizes", calculateFolderSizes, () => {
    calculateFolderSizes = !calculateFolderSizes;
    try { localStorage.setItem("calculateFolderSizes", String(calculateFolderSizes)); } catch {}
    renderFiles();
  }));

  settingsMenu.appendChild(createSep());

  settingsMenu.appendChild(createHeader("Navigation"));
  settingsMenu.appendChild(createOption("Open via System Dialog...", false, () => {
    openLocationViaSystemPicker();
  }));
}

// Update UI elements
function updateUI() {
  updateBreadcrumb();
  updateNavigationButtons();
  if (currentPathEl) {
    currentPathEl.textContent = currentPath;
  }
}

// Update breadcrumb
function updateBreadcrumb() {
  if (!pathSegments) return;

  pathSegments.innerHTML = "";

  const isWindows = window.fileManager.platform === "win32";
  const sep = isWindows ? "\\" : "/";
  const parts = currentPath.split(sep).filter((p) => p);

  // Handle Tag View Breadcrumb
  if (currentPath.startsWith("tag://")) {
    const color = currentPath.replace("tag://", "");
    const rootBtn = document.createElement("button");
    rootBtn.className = "breadcrumb-item";
    rootBtn.textContent = "Tags";
    pathSegments.appendChild(rootBtn);

    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "›";
    pathSegments.appendChild(separator);

    const tagBtn = document.createElement("button");
    tagBtn.className = "breadcrumb-item";
    tagBtn.textContent = color.charAt(0).toUpperCase() + color.slice(1);
    pathSegments.appendChild(tagBtn);
    return;
  }

  // Root
  const rootBtn = document.createElement("button");
  rootBtn.className = "breadcrumb-item";
  rootBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
  rootBtn.addEventListener("click", () => {
    navigateTo(isWindows ? parts[0] + sep : "/");
  });
  pathSegments.appendChild(rootBtn);

  let accumulated = isWindows ? "" : "/";

  parts.forEach((part, index) => {
    if (isWindows && index === 0) {
      accumulated = part + sep;
    } else {
      accumulated = accumulated + (accumulated.endsWith(sep) ? "" : sep) + part;
    }

    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "›";
    pathSegments.appendChild(separator);

    const partBtn = document.createElement("button");
    partBtn.className = "breadcrumb-item";
    partBtn.textContent = part;
    const targetPath = accumulated;
    partBtn.addEventListener("click", () => navigateTo(targetPath));
    pathSegments.appendChild(partBtn);
  });
}

// Update navigation buttons
function updateNavigationButtons() {
  const backBtn = document.getElementById("back-btn");
  const forwardBtn = document.getElementById("forward-btn");

  if (backBtn) backBtn.disabled = historyIndex <= 0;
  if (forwardBtn) forwardBtn.disabled = historyIndex >= history.length - 1;
}

// Get file type info
function getFileType(item) {
  if (item.isDirectory) return fileTypes.folder;

  const ext = (item.extension || "").replace(".", "").toLowerCase();

  for (const [type, info] of Object.entries(fileTypes)) {
    if (info.extensions && info.extensions.includes(ext)) {
      return info;
    }
  }

  return fileTypes.default;
}

// Format file size
function formatSize(bytes) {
  if (bytes === 0 || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

// Subtle inline spinner for folder sizes while computing
function folderSizeSpinnerHtml() {
  return `
    <span class="size-spinner" aria-label="Calculating size" title="Calculating…"></span>
  `.trim();
}

// Format date
function formatDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  const now = new Date();

  // Compare calendar dates, not time differences
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - dateDay) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return (
      "Today, " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "long" });
  } else {
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
}

// Render files (list view only)
function renderFiles() {
  if (!fileList) return;

  fileList.innerHTML = "";
  fileList.className = `file-list ${viewMode}-view`;

  // Toggle header visibility based on view mode
  const header = document.querySelector(".file-list-header");
  if (header) {
    header.style.display = viewMode === "detailed" ? "grid" : "none";
  }

  const fragment = document.createDocumentFragment();
  let items = [...currentItems];

  // Filter hidden files
  if (!showHidden) {
    items = items.filter((item) => !item.name.startsWith("."));
  }

  // Picker Mode Filtering
  if (pickerMode === "directory") {
    items = items.filter(i => i.isDirectory);
  }

  // Filter by search
  const searchTerm = searchInput ? searchInput.value.toLowerCase() : "";
  if (searchTerm) {
    items = items.filter((item) =>
      item.name.toLowerCase().includes(searchTerm),
    );
  }

  // Sort items
  items.sort((a, b) => {
    // Folders first
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    let comparison = 0;
    switch (sortBy) {
      case "name":
        comparison = a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        });
        break;
      case "size": {
        const sizeA = a.isDirectory
          ? (folderSizeCache.get(a.path)?.size ?? 0)
          : (a.size ?? 0);

        const sizeB = b.isDirectory
          ? (folderSizeCache.get(b.path)?.size ?? 0)
          : (b.size ?? 0);

        comparison = sizeA - sizeB;
        break;
      }
      case "date":
        comparison = new Date(a.modified || 0) - new Date(b.modified || 0);
        break;
      case "added":
        comparison = new Date(a.created || 0) - new Date(b.created || 0);
        break;
      case "type":
        const extA = (a.extension || "").toLowerCase();
        const extB = (b.extension || "").toLowerCase();
        comparison = extA.localeCompare(extB);
        break;
    }

    return sortAscending ? comparison : -comparison;
  });

  // Group items if groupBy is set
  const groups = new Map();
  if (groupBy !== "none") {
    items.forEach((item) => {
      let groupKey;
      switch (groupBy) {
        case "type":
          if (item.isDirectory) {
            groupKey = "Folders";
          } else {
            const ext = (item.extension || "").toLowerCase();
            groupKey = ext ? ext.slice(1).toUpperCase() + " Files" : "Other Files";
          }
          break;
        case "dateModified":
        case "dateAdded": {
          const dateValue = groupBy === "dateAdded" ? item.created : item.modified;
          if (dateValue) {
            const d = new Date(dateValue);
            const now = new Date();
            // Compare calendar dates
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const diffDays = Math.round((today - dateDay) / (1000 * 60 * 60 * 24));
            if (diffDays === 0) groupKey = "Today";
            else if (diffDays === 1) groupKey = "Yesterday";
            else if (diffDays < 7) groupKey = "This Week";
            else if (diffDays < 30) groupKey = "This Month";
            else if (diffDays < 365) groupKey = "This Year";
            else groupKey = "Older";
          } else {
            groupKey = "Unknown";
          }
          break;
        }
        case "size":
          const size = item.isDirectory ? 0 : (item.size || 0);
          if (item.isDirectory) groupKey = "Folders";
          else if (size === 0) groupKey = "Empty";
          else if (size < 1024) groupKey = "Tiny (< 1 KB)";
          else if (size < 1024 * 1024) groupKey = "Small (< 1 MB)";
          else if (size < 100 * 1024 * 1024) groupKey = "Medium (< 100 MB)";
          else if (size < 1024 * 1024 * 1024) groupKey = "Large (< 1 GB)";
          else groupKey = "Huge (> 1 GB)";
          break;
        default:
          groupKey = "All";
      }
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(item);
    });
  }

  if (items.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="80" height="80">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
        <p class="empty-state-text">${searchTerm ? "No matching items" : "This folder is empty"}</p>
      </div>
    `;
    return;
  }

  // Helper to render a single item
  const renderItem = (item) => {
    const fileType = getFileType(item);
    const element = document.createElement("div");
    element.className = `file-item ${selectedItems.has(item.path) ? "selected" : ""}`;
    element.dataset.path = item.path;
    element.dataset.name = item.name;
    element.dataset.isDirectory = item.isDirectory;

    // For folders, we lazy-load the real size and cache it.
    // We render a subtle spinner until computed.
    let folderSizeCell = "—";
    if (item.isDirectory) {
      if (calculateFolderSizes) {
        const cached = folderSizeCache.get(item.path);
        const fresh =
          cached && Date.now() - cached.ts < FOLDER_SIZE_CACHE_TTL_MS
            ? cached
            : null;
        folderSizeCell = fresh ? formatSize(fresh.size) : folderSizeSpinnerHtml();
      }
    }

    // Tags
    const itemTags = fileTags[item.path] || [];
    const tagsHtml = itemTags.length > 0 
      ? `<span class="file-tags">${itemTags.map(c => `<span class="tag-dot" style="background-color:${TAG_HEX[c]}"></span>`).join("")}</span>` 
      : "";

    let iconContent = fileType.icon;
    let shouldObserveThumbnail = false;
    // In thumbnail view, try to show actual image for image files
    if (viewMode === "thumbnail" && fileType === fileTypes.image) {
      // Use IntersectionObserver for memory-efficient lazy loading
      // Initially render the fallback icon, load image when visible
      const safeIcon = fileType.icon.replace(/"/g, "'").replace(/'/g, "&#39;");
      iconContent = fileType.icon; // Start with icon, load image via observer
      shouldObserveThumbnail = true;
    }

    element.innerHTML = `
      <div class="file-icon" style="color: ${fileType.color}"${shouldObserveThumbnail ? ` data-thumb-path="${escapeHtmlAttr(item.path)}" data-fallback-icon="${escapeHtmlAttr(fileType.icon)}"` : ''}>
        ${iconContent}
      </div>
      <div class="file-name">${escapeHtml(item.name)}${tagsHtml}</div>
      <div class="file-size" data-role="size" data-path="${escapeHtml(item.path)}">${item.isDirectory ? folderSizeCell : formatSize(item.size)}</div>
      <div class="file-date">${formatDate(item.modified)}</div>
      <div class="file-added">${formatDate(item.created)}</div>
    `;

    // Register thumbnail for lazy loading via IntersectionObserver
    if (shouldObserveThumbnail) {
      const iconEl = element.querySelector('.file-icon');
      if (iconEl) {
        observeThumbnail(iconEl);
      }
    }

    // Make draggable
    element.draggable = true;

    // Drag start - collect items to drag
    element.addEventListener("dragstart", (e) => {
      isDragging = true;
      // If dragging a selected item, drag all selected; otherwise just this one
      if (selectedItems.has(item.path)) {
        draggedItems = Array.from(selectedItems);
      } else {
        draggedItems = [item.path];
      }
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", draggedItems.join("\n"));
      e.dataTransfer.setData("application/x-file-manager-paths", JSON.stringify(draggedItems));
      element.classList.add("dragging");
    });

    element.addEventListener("dragend", () => {
      isDragging = false;
      draggedItems = [];
      element.classList.remove("dragging");
      // Remove all drop target highlights
      document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
      // Clear auto-scroll
      clearInterval(dragScrollInterval);
      dragScrollInterval = null;
    });

    // Folders can accept drops
    if (item.isDirectory) {
      let folderHoverTimer = null;

      element.addEventListener("dragover", (e) => {
        // Don't allow dropping onto itself or its children
        if (draggedItems.includes(item.path)) return;
        if (draggedItems.some((p) => item.path.startsWith(p + "/"))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        element.classList.add("drop-target");

        // Hover to open folder after delay
        if (!folderHoverTimer) {
          folderHoverTimer = setTimeout(async () => {
            folderHoverTimer = null;
            if (element.classList.contains("drop-target")) {
              await navigateTo(item.path);
            }
          }, DRAG_HOVER_DELAY);
        }
      });

      element.addEventListener("dragleave", () => {
        element.classList.remove("drop-target");
        if (folderHoverTimer) {
          clearTimeout(folderHoverTimer);
          folderHoverTimer = null;
        }
      });

      element.addEventListener("drop", async (e) => {
        e.preventDefault();
        element.classList.remove("drop-target");
        if (folderHoverTimer) {
          clearTimeout(folderHoverTimer);
          folderHoverTimer = null;
        }

        // Handle internal drag
        if (draggedItems.length > 0) {
          const isCopy = e.ctrlKey;
          await handleFileDrop(draggedItems, item.path, isCopy);
          return;
        }

        // Handle external file drop
        if (e.dataTransfer.files.length > 0) {
          const externalPaths = Array.from(e.dataTransfer.files).map((f) => f.path);
          await handleFileDrop(externalPaths, item.path, true);
        }
      });
    }

    // Click to select
    element.addEventListener("click", (e) => handleItemClick(e, item));

    // Double click to open
    element.addEventListener("dblclick", () => openItem(item));

    return element;
  };

  // Render items - either grouped or flat
  if (groupBy !== "none" && groups.size > 0) {
    // Sort groups based on groupBy type
    const sortedGroups = Array.from(groups.entries());
    
    if (groupBy === "size") {
      // Define order for size groups
      const sizeGroupOrder = [
        "Folders",
        "Empty",
        "Tiny (< 1 KB)",
        "Small (< 1 MB)",
        "Medium (< 100 MB)",
        "Large (< 1 GB)",
        "Huge (> 1 GB)"
      ];
      
      sortedGroups.sort((a, b) => {
        const indexA = sizeGroupOrder.indexOf(a[0]);
        const indexB = sizeGroupOrder.indexOf(b[0]);
        // If not found in order array, put at end
        if (indexA === -1 && indexB === -1) return a[0].localeCompare(b[0]);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    } else if (groupBy === "dateModified" || groupBy === "dateAdded") {
      // Define order for date groups
      const dateGroupOrder = [
        "Today",
        "Yesterday",
        "This Week",
        "This Month",
        "This Year",
        "Older",
        "Unknown"
      ];

      sortedGroups.sort((a, b) => {
        const indexA = dateGroupOrder.indexOf(a[0]);
        const indexB = dateGroupOrder.indexOf(b[0]);
        if (indexA === -1 && indexB === -1) return a[0].localeCompare(b[0]);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    } else {
      // For type grouping, sort alphabetically but put "Folders" first
      sortedGroups.sort((a, b) => {
        if (a[0] === "Folders") return -1;
        if (b[0] === "Folders") return 1;
        return a[0].localeCompare(b[0]);
      });
    }
    
    // Render with group headers
    for (const [groupName, groupItems] of sortedGroups) {
      // Items are already sorted from the main sort above, just use that order
      const sortedGroupItems = groupItems;
      
      // Add group header
      const isCollapsed = collapsedGroups.has(groupName);
      const header = document.createElement("div");
      header.className = "group-header";
      
      const chevron = `<svg class="group-chevron ${isCollapsed ? "" : "expanded"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
      
      header.innerHTML = `${chevron}<span class="group-name">${escapeHtml(groupName)}</span><span class="group-count">${sortedGroupItems.length}</span>`;
      header.addEventListener("click", (e) => {
        // If clicking chevron, toggle collapse
        if (e.target.closest(".group-chevron")) {
          if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
          else collapsedGroups.add(groupName);
          renderFiles();
          return;
        }

        // Otherwise select all items in group
        const paths = sortedGroupItems.map(i => i.path);
        if (e.ctrlKey || e.metaKey) {
          // Toggle selection if Ctrl/Meta is held
          const allSelected = paths.every(p => selectedItems.has(p));
          if (allSelected) paths.forEach(p => selectedItems.delete(p));
          else paths.forEach(p => selectedItems.add(p));
        } else {
          // Exclusive select
          selectedItems.clear();
          paths.forEach(p => selectedItems.add(p));
        }
        updateSelectionUI();
      });
      fragment.appendChild(header);

      // Add items in group
      if (!isCollapsed) {
        sortedGroupItems.forEach((item) => {
          fragment.appendChild(renderItem(item));
        });
      }
    }
    fileList.appendChild(fragment);
  } else {
    // Render flat list - use chunked rendering for large directories
    if (items.length > MAX_ITEMS_BEFORE_VIRTUAL_SCROLL) {
      // Store items and renderItem function for chunked loading
      filteredItems = items;
      renderItemForVirtualScroll = renderItem;
      renderedItemCount = 0;

      // Setup scroll load observer if not already done
      setupScrollLoadObserver();

      // Render initial chunk
      const initialCount = Math.min(ITEMS_PER_CHUNK, items.length);
      for (let i = 0; i < initialCount; i++) {
        fragment.appendChild(renderItem(items[i]));
      }
      renderedItemCount = initialCount;

      // Add sentinel for loading more
      if (renderedItemCount < items.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'load-more-sentinel';
        sentinel.style.height = '1px';
        fragment.appendChild(sentinel);
      }

      fileList.appendChild(fragment);

      // Start observing the sentinel
      const sentinel = fileList.querySelector('.load-more-sentinel');
      if (sentinel && scrollLoadObserver) {
        scrollLoadObserver.observe(sentinel);
      }
    } else {
      // Render all items for small directories
      items.forEach((item) => {
        fragment.appendChild(renderItem(item));
      });
      fileList.appendChild(fragment);
    }
  }

  // After rendering, schedule size computation for currently visible folders
  scheduleVisibleFolderSizes();
}

// Escape HTML
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Handle item click
function handleItemClick(e, item) {
  // Picker Mode Constraints
  if (pickerMode === "open" && item.isDirectory) return; // Folders not selectable in open mode
  if (pickerMode === "save") return; // Selection ignored in save mode
  
  // In directory mode, files are hidden by renderFiles, so we only see folders, 
  // which are selectable.

  if (e.ctrlKey || e.metaKey) {
    // Toggle selection
    if (selectedItems.has(item.path)) {
      selectedItems.delete(item.path);
    } else {
      selectedItems.add(item.path);
    }
  } else if (e.shiftKey && selectedItems.size > 0) {
    // Range selection
    const allItems = Array.from(fileList.children).filter((el) =>
      el.classList.contains("file-item"),
    );
    const lastSelected = Array.from(selectedItems).pop();
    const lastIndex = allItems.findIndex(
      (el) => el.dataset.path === lastSelected,
    );
    const currentIndex = allItems.findIndex(
      (el) => el.dataset.path === item.path,
    );

    const [start, end] = [
      Math.min(lastIndex, currentIndex),
      Math.max(lastIndex, currentIndex),
    ];

    for (let i = start; i <= end; i++) {
      if (allItems[i]) {
        selectedItems.add(allItems[i].dataset.path);
      }
    }
  } else {
    // Single selection
    selectedItems.clear();
    selectedItems.add(item.path);
  }

  updateSelectionUI();
}

// Update selection UI
function updateSelectionUI() {
  document.querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("selected", selectedItems.has(el.dataset.path));
  });
  updateStatusBar();
  updatePreviewPanelContent();
}

// Tag management
function toggleFileTag(path, color) {
  if (!fileTags[path]) fileTags[path] = [];
  const idx = fileTags[path].indexOf(color);
  if (idx > -1) {
    fileTags[path].splice(idx, 1);
    if (fileTags[path].length === 0) delete fileTags[path];
  } else {
    fileTags[path].push(color);
  }
  localStorage.setItem("fileTags", JSON.stringify(fileTags));
  renderFiles();

  // If we are currently viewing this tag, refresh the view to show/hide the item
  if (currentPath === `tag://${color}`) {
    navigateTo(currentPath);
  }
}

function selectSingleItemByPath(itemPath) {
  if (!itemPath) return;
  selectedItems.clear();
  selectedItems.add(itemPath);
  updateSelectionUI();
}

function scrollItemIntoView(itemPath) {
  if (!fileList || !itemPath) return;
  const row = fileList.querySelector(
    `.file-item[data-path="${cssEscape(itemPath)}"]`,
  );
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function renamePath(oldPath, currentNameForDefault) {
  if (!oldPath) return;
  const raw = await showTextInputModal(
    "Rename",
    "Enter new name:",
    currentNameForDefault || "",
  );
  if (raw === null) return;

  const validated = validateNewItemName(raw);
  if (!validated.ok) {
    showNotification(validated.reason, "error");
    return;
  }

  try {
    const result = await window.fileManager.renameItem(oldPath, validated.name);
    if (result && result.success) {
      showNotification(`Renamed to ${validated.name}`);
      await navigateTo(currentPath);

      const newPath =
        result.newPath ||
        (await window.fileManager.joinPaths(currentPath, validated.name));
      selectSingleItemByPath(newPath);
      scrollItemIntoView(newPath);
    } else {
      showNotification("Error: " + (result?.error || "Rename failed"), "error");
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

// Open item
async function openItem(item) {
  const archiveExts = [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".iso", ".txz", ".tbz2"];
  const ext = (item.extension || "").toLowerCase();
  if (item.isDirectory || archiveExts.includes(ext)) {
    await navigateTo(item.path);
  } else {
    await window.fileManager.openFile(item.path);
  }
}

// Navigation functions
async function goBack() {
  if (historyIndex > 0) {
    historyIndex--;
    const path = history[historyIndex];
    const result = await window.fileManager.getDirectoryContents(path);
    if (result.success) {
      currentPath = result.path;
      currentItems = result.contents;
      updateUI();
      renderFiles();
      selectedItems.clear();
      updateStatusBar();
    }
  }
}

async function goForward() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    const path = history[historyIndex];
    const result = await window.fileManager.getDirectoryContents(path);
    if (result.success) {
      currentPath = result.path;
      currentItems = result.contents;
      updateUI();
      renderFiles();
      selectedItems.clear();
      updateStatusBar();
    }
  }
}

async function goUp() {
  const parent = await window.fileManager.getParentDirectory(currentPath);
  if (parent !== currentPath) {
    await navigateTo(parent);
  }
}

function refresh() {
  // Clear folder size cache for current items to force recalculation
  if (currentItems) {
    for (const item of currentItems) {
      if (item.isDirectory) {
        folderSizeCache.delete(item.path);
      }
    }
  }
  navigateTo(currentPath);
}

// Update status bar
function updateStatusBar() {
  if (itemCountEl) {
    const visibleCount = showHidden
      ? currentItems.length
      : currentItems.filter((item) => !item.name.startsWith(".")).length;
    itemCountEl.textContent = `${visibleCount} items`;
  }
  if (selectedCountEl) {
    selectedCountEl.textContent =
      selectedItems.size > 0 ? `${selectedItems.size} selected` : "";
  }
}

// Show notification
function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = "0";
    notification.style.transition = "opacity 0.3s";
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Context menu
function showContextMenu(x, y) {
  if (!contextMenu) return;

  contextMenu.classList.add("visible");

  // Ensure submenu is closed on open
  closeContextSubmenu();

  // Adjust position (based on main panel width)
  const rect = contextMenu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - 10;
  }
  if (y + rect.height > window.innerHeight) {
    y = window.innerHeight - rect.height - 10;
  }

  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.remove("visible");
  }
  closeContextSubmenu();
}

// ---- Dynamic context menu rendering ----

function closeContextSubmenu() {
  contextSubmenuOpen = false;
  if (contextSubmenu) {
    contextSubmenu.style.display = "none";
    contextSubmenu.innerHTML = "";
  }
}

function renderMenuItems(container, items) {
  if (!container) return;
  container.innerHTML = "";

  for (const it of items) {
    if (it.type === "separator") {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      container.appendChild(sep);
      continue;
    }

    if (it.type === "custom" && it.element) {
      container.appendChild(it.element);
      continue;
    }

    const row = document.createElement("div");
    row.className = "context-menu-item";

    if (it.danger) row.classList.add("danger");
    if (it.disabled) row.classList.add("disabled");
    if (it.submenu) row.classList.add("has-submenu");

    row.innerHTML = `
      ${it.icon || ""}
      <span>${escapeHtmlAttr(it.label)}</span>
    `;

    if (it.disabled) {
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    } else if (it.submenu) {
      row.addEventListener("mouseenter", () => {
        openContextSubmenu(it.submenu);
      });
      row.addEventListener("click", (e) => {
        // Clicking the "New ▸" row does not trigger an action; it opens submenu
        e.preventDefault();
        e.stopPropagation();
        openContextSubmenu(it.submenu);
      });
    } else if (typeof it.onClick === "function") {
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideContextMenu();
        it.onClick();
      });
    }

    container.appendChild(row);
  }
}

function openContextSubmenu(subItems) {
  if (!contextSubmenu) return;
  contextSubmenuOpen = true;
  contextSubmenu.style.display = "block";
  renderMenuItems(contextSubmenu, subItems);

  // Clamp submenu within viewport horizontally if needed
  const mainRect = contextMenu.getBoundingClientRect();
  const subRect = contextSubmenu.getBoundingClientRect();
  const desiredLeft = mainRect.width - 8;
  contextSubmenu.style.left = `${desiredLeft}px`;

  // If it would go off-screen, open to the left
  const absoluteLeft = mainRect.left + desiredLeft + subRect.width;
  if (absoluteLeft > window.innerWidth - 10) {
    contextSubmenu.style.left = `${-subRect.width + 8}px`;
  }
}

function renderContextMenu() {
  if (!contextMenuPanel) return;

  // Icons (simple inline SVGs matching existing style)
  const ICON_PASTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
  const ICON_FOLDER = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  const ICON_FILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`;
  const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
  const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
  const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
  const ICON_CUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`;
  const ICON_RENAME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4l6 6-3 3v5l-2 2-2-2v-5l-3-3 4-6z"/><path d="M5 21l7-7"/></svg>`;
  const ICON_UNPIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4l6 6-3 3v5l-2 2-2-2v-5l-3-3 4-6z"/><path d="M5 21l7-7"/><path d="M3 3l18 18"/></svg>`;
  const ICON_MOVE_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;
  const ICON_MOVE_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>`;
  const ICON_TERMINAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
  const ICON_EXTRACT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21,8 21,21 3,21 3,8"/><rect x="1" y="3" width="22" height="5"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/></svg>`;
  const ICON_COMPRESS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21,8 21,21 3,21 3,8"/><rect x="1" y="3" width="22" height="5"/><path d="M12 17v-6"/><path d="M9 14l3-3 3 3"/></svg>`;

  // Helper to render tags row
  const renderTagsRow = (targetPath) => {
    const currentTags = fileTags[targetPath] || [];
    const row = document.createElement("div");
    row.className = "context-menu-tags";
    
    TAG_COLORS.forEach(color => {
      const dot = document.createElement("div");
      dot.className = `context-tag-option ${currentTags.includes(color) ? "active" : ""}`;
      dot.style.backgroundColor = TAG_HEX[color];
      dot.title = color.charAt(0).toUpperCase() + color.slice(1);
      
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        // Apply to all selected items if multiple
        if (selectedItems.size > 1 && selectedItems.has(targetPath)) {
          selectedItems.forEach(p => toggleFileTag(p, color));
        } else {
          toggleFileTag(targetPath, color);
        }
        hideContextMenu();
      });
      row.appendChild(dot);
    });
    return row;
  };

  // Background menu
  if (contextMenuMode === "background") {
    if (isInTrash) {
      renderMenuItems(contextMenuPanel, [
        {
          label: "Empty Trash",
          icon: ICON_TRASH,
          danger: true,
          onClick: () => emptyTrash(),
        },
      ]);
      return;
    }

    const canPaste = clipboardItems && clipboardItems.length > 0;

    const newSubmenu = [
      {
        label: "Folder",
        icon: ICON_FOLDER,
        onClick: () => createNewFolder(),
      },
      {
        label: "File",
        icon: ICON_FILE,
        onClick: () => createNewFile(),
      },
    ];

    const items = [
      {
        label: "Paste",
        icon: ICON_PASTE,
        disabled: !canPaste,
        onClick: () => paste(),
      },
      { type: "separator" },
      {
        label: "New",
        icon: "",
        submenu: newSubmenu,
      },
    ];

    // Pin current folder from background (adds a PIN item into quickAccessItems)
    if (contextPinTargetPath) {
      items.push({ type: "separator" });
      items.push({
        label: isPinnedExact(contextPinTargetPath) ? "Unpin" : "Pin",
        icon: isPinnedExact(contextPinTargetPath) ? ICON_UNPIN : ICON_PIN,
        onClick: async () => {
          if (isPinnedExact(contextPinTargetPath)) {
            removeQuickAccessById(
              `pin:${normalizePathForCompare(contextPinTargetPath)}`,
            );
          } else {
            const label = await showTextInputModal(
              "Pin folder",
              "Label:",
              contextPinTargetPath.split(/[/\\]/).filter(Boolean).pop() ||
                contextPinTargetPath,
              "Pin",
            );
            if (label === null) return;
            addPin(contextPinTargetPath, String(label).trim());
          }
        },
      });
    }

    renderMenuItems(contextMenuPanel, items);
    return;
  }

  // Quick access item menu (pins AND built-ins): allow Unpin + Move Up/Down
  if (contextMenuMode === "quickAccess") {
    const qaId = contextQuickAccessId;

    renderMenuItems(contextMenuPanel, [
      {
        label: "Move Up",
        icon: ICON_MOVE_UP,
        disabled: quickAccessItems.findIndex((x) => x.id === qaId) <= 0,
        onClick: () => moveQuickAccess(qaId, -1),
      },
      {
        label: "Move Down",
        icon: ICON_MOVE_DOWN,
        disabled:
          quickAccessItems.findIndex((x) => x.id === qaId) >=
          quickAccessItems.length - 1,
        onClick: () => moveQuickAccess(qaId, +1),
      },
      { type: "separator" },
      {
        label: "Unpin",
        icon: ICON_UNPIN,
        danger: true,
        onClick: () => removeQuickAccessById(qaId),
      },
    ]);
    return;
  }

  // Item menu (existing actions)
  const itemMenu = [
    { label: "Open", icon: ICON_OPEN, onClick: () => openSelected() },
    { type: "separator" },
    { label: "Copy", icon: ICON_COPY, onClick: () => copySelected() },
    { label: "Cut", icon: ICON_CUT, onClick: () => cutSelected() },
    {
      label: "Paste",
      icon: ICON_PASTE,
      disabled: !(clipboardItems && clipboardItems.length > 0),
      onClick: () => paste(),
    },
    { type: "separator" },
  ];

  // Tags row
  if (selectedItems.size > 0) {
    itemMenu.push({
      type: "custom",
      element: renderTagsRow(Array.from(selectedItems)[0]),
    });
    itemMenu.push({ type: "separator" });
  }

  // Open in Terminal (if single folder selected)
  if (selectedItems.size === 1) {
    const p = Array.from(selectedItems)[0];
    const it = currentItems.find((x) => x.path === p);
    if (it && it.isDirectory) {
      itemMenu.push({ label: "Open in Terminal", icon: ICON_TERMINAL, onClick: () => window.fileManager.openTerminal(p) });
      itemMenu.push({ type: "separator" });
    }
  }

  // Pin selected folder (exactly one folder)
  if (contextPinTargetPath) {
    const pinId = `pin:${normalizePathForCompare(contextPinTargetPath)}`;
    itemMenu.push({
      label: isPinnedExact(contextPinTargetPath) ? "Unpin" : "Pin",
      icon: isPinnedExact(contextPinTargetPath) ? ICON_UNPIN : ICON_PIN,
      onClick: async () => {
        if (isPinnedExact(contextPinTargetPath)) {
          removeQuickAccessById(pinId);
        } else {
          const label = await showTextInputModal(
            "Pin folder",
            "Label:",
            contextPinTargetLabel || "Pinned",
            "Pin",
          );
          if (label === null) return;
          addPin(contextPinTargetPath, String(label).trim());
        }
      },
    });
    itemMenu.push({ type: "separator" });
  }

  // Archive operations
  const archiveExts = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tar.gz", "tar.bz2", "tar.xz", "tgz"];
  const selectedPaths = Array.from(selectedItems);

  // Check if any selected item is an archive (for Extract)
  const hasArchive = selectedPaths.some(p => {
    const lower = p.toLowerCase();
    return archiveExts.some(ext => lower.endsWith(`.${ext}`));
  });

  if (hasArchive) {
    itemMenu.push({
      label: "Extract Here",
      icon: ICON_EXTRACT,
      onClick: () => extractSelected(),
    });
  }

  // Always show Compress option when items are selected
  if (selectedPaths.length > 0) {
    itemMenu.push({
      label: "Compress",
      icon: ICON_COMPRESS,
      onClick: () => compressSelected(),
    });
    itemMenu.push({ type: "separator" });
  }

  itemMenu.push({
    label: "Rename",
    icon: ICON_RENAME,
    onClick: () => renameSelected(),
  });
  itemMenu.push({
    label: "Delete",
    icon: ICON_TRASH,
    danger: true,
    onClick: () => deleteSelected(),
  });

  renderMenuItems(contextMenuPanel, itemMenu);
}

// Progress Bar Logic with "Fake" Ticker for responsiveness
let progressInterval = null;
let realProgress = 0;
let fakeProgress = 0;

function startProgress() {
  if (progressInterval) clearInterval(progressInterval);
  realProgress = 0;
  fakeProgress = 0;
  
  if (progressBarContainer && progressBarFill) {
    progressBarContainer.style.display = "block";
    progressBarFill.style.width = "0%";
  }

  // Fake progress ticker: moves up to 25% quickly, then slows down, caps at 95%
  // This ensures the user sees activity even during scanning or fast operations
  progressInterval = setInterval(() => {
    if (fakeProgress < 25) fakeProgress += 2;
    else if (fakeProgress < 60) fakeProgress += 0.5;
    else if (fakeProgress < 95) fakeProgress += 0.1;
    updateProgressDisplay();
  }, 100);
}

function updateProgressDisplay() {
  if (!progressBarContainer || !progressBarFill) return;
  const display = Math.max(realProgress, fakeProgress);
  progressBarFill.style.width = `${Math.min(100, display)}%`;
}

function setProgress(percent) {
  realProgress = percent;
  updateProgressDisplay();
}

// File operations
function openSelected() {
  if (selectedItems.size === 0) return;

  const path = Array.from(selectedItems)[0];
  const item = currentItems.find((i) => i.path === path);
  if (item) {
    openItem(item);
  }
}

async function copySelected() {
  if (selectedItems.size === 0) return;

  clipboardItems = Array.from(selectedItems);
  clipboardOperation = "copy";

  // Also write the copied absolute paths to the OS clipboard
  try {
    await window.fileManager.clipboardCopyPaths(clipboardItems);
  } catch {
    // Non-fatal: internal clipboard still works for paste inside the app
  }

  showNotification(`Copied ${clipboardItems.length} item(s)`);
}

async function cutSelected() {
  if (selectedItems.size === 0) return;

  clipboardItems = Array.from(selectedItems);
  clipboardOperation = "cut";

  // Also write the cut absolute paths to the OS clipboard
  try {
    await window.fileManager.clipboardCopyPaths(clipboardItems);
  } catch {
    // Non-fatal
  }

  showNotification(`Cut ${clipboardItems.length} item(s)`);
}

async function paste() {
  if (clipboardItems.length === 0) return;

  startProgress();
  // Yield to allow the progress bar to render before starting operations
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const batchItems = [];

  try {
    for (const sourcePath of clipboardItems) {
      const parsed = await window.fileManager.parsePath(sourcePath);
      const destPath = await window.fileManager.joinPaths(
        currentPath,
        parsed.base,
      );
      batchItems.push({ source: sourcePath, dest: destPath });
    }

    const result = await window.fileManager.batchFileOperation(batchItems, clipboardOperation);

    if (result.success) {
      showNotification(
        `${clipboardOperation === "copy" ? "Copied" : "Moved"} ${clipboardItems.length} item(s)`,
      );
    } else {
      showNotification("Error: " + result.error, "error");
    }

    if (clipboardOperation === "cut") {
      clipboardItems = [];
      clipboardOperation = null;
    }

    refresh();
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }

  // End progress
  if (progressInterval) clearInterval(progressInterval);
  realProgress = 100;
  updateProgressDisplay();
  
  setTimeout(() => {
    if (progressBarContainer) progressBarContainer.style.display = "none";
    if (progressBarFill) progressBarFill.style.width = "0%";
    realProgress = 0; fakeProgress = 0;
  }, 1000);
}

// Handle file drop - move or copy files to target directory
async function handleFileDrop(sourcePaths, targetDir, isCopy = false) {
  if (sourcePaths.length === 0) return;

  const normTargetDir = normalizePathForCompare(targetDir);
  const isWindows = window.fileManager.platform === "win32";
  const sep = isWindows ? "\\" : "/";

  startProgress();

  const batchItems = [];
  let processedCount = 0;

  try {
    for (const sourcePath of sourcePaths) {
      const parsed = await window.fileManager.parsePath(sourcePath);
      const destPath = await window.fileManager.joinPaths(targetDir, parsed.base);
      const normSourcePath = normalizePathForCompare(sourcePath);
      const normDestPath = normalizePathForCompare(destPath);

      // Skip if source and dest are the same (dropping onto itself or same directory)
      if (normSourcePath === normDestPath) {
        processedCount++;
        setProgress((processedCount / sourcePaths.length) * 100);
        continue;
      }

      // Skip if dropping into its current parent (no-op move)
      // Use string manipulation to be sure, avoiding IPC overhead/ambiguity
      const cleanSource = sourcePath.replace(/[/\\]+$/, "");
      const lastSep = cleanSource.lastIndexOf(sep);
      if (lastSep >= 0) {
        // Handle root case (index 0) or normal parent
        const parent = lastSep === 0 ? "/" : cleanSource.substring(0, lastSep);
        if (normalizePathForCompare(parent) === normTargetDir) {
          processedCount++;
          setProgress((processedCount / sourcePaths.length) * 100);
          continue;
        }
      }

      // Prevent dropping a folder into itself (recursive)
      // Check if destPath starts with sourcePath (normalized to forward slashes)
      if (normDestPath.startsWith(normSourcePath + "/")) {
        processedCount++;
        setProgress((processedCount / sourcePaths.length) * 100);
        continue;
      }
      
      // Also check if targetDir IS the sourcePath (dropping into itself directly)
      if (normalizePathForCompare(targetDir) === normSourcePath) {
        processedCount++;
        setProgress((processedCount / sourcePaths.length) * 100);
        continue;
      }

      batchItems.push({ source: sourcePath, dest: destPath });
    }

    if (batchItems.length > 0) {
      const result = await window.fileManager.batchFileOperation(batchItems, isCopy ? "copy" : "move");
      if (result.success) {
        showNotification(
          `${isCopy ? "Copied" : "Moved"} ${batchItems.length} item(s)`,
        );
        refresh();
      } else {
        showNotification("Error: " + result.error, "error");
      }
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }

  // End progress
  if (progressInterval) clearInterval(progressInterval);

  if (batchItems.length === 0) {
    if (progressBarContainer) progressBarContainer.style.display = "none";
    if (progressBarFill) progressBarFill.style.width = "0%";
    realProgress = 0; fakeProgress = 0;
    return;
  }

  realProgress = 100;
  updateProgressDisplay();
  
  setTimeout(() => {
    if (progressBarContainer) progressBarContainer.style.display = "none";
    if (progressBarFill) progressBarFill.style.width = "0%";
    realProgress = 0; fakeProgress = 0;
  }, 1000);
}

async function openLocationViaSystemPicker() {
  const result = await window.fileManager.showOpenDialog({
    properties: ["openDirectory", "showHiddenFiles"],
    title: "Navigate to Folder"
  });
  
  if (result && !result.canceled && result.filePaths.length > 0) {
    await navigateTo(result.filePaths[0]);
  }
}

async function renameSelected() {
  if (selectedItems.size !== 1) return;

  const oldPath = Array.from(selectedItems)[0];
  const item = currentItems.find((i) => i.path === oldPath);
  if (!item) return;

  const raw = await showTextInputModal(
    "Rename",
    "Enter new name:",
    item.name,
    "Rename",
  );
  if (raw === null) return;

  const validated = validateNewItemName(raw);
  if (!validated.ok) {
    showNotification(validated.reason, "error");
    return;
  }

  if (validated.name === item.name) return;

  try {
    const result = await window.fileManager.renameItem(oldPath, validated.name);
    if (result && result.success) {
      showNotification(`Renamed to ${validated.name}`);
      await navigateTo(currentPath);

      const newPath =
        result.newPath ||
        (await window.fileManager.joinPaths(currentPath, validated.name));
      selectedItems.clear();
      selectedItems.add(newPath);
      updateSelectionUI();
    } else {
      showNotification("Error: " + (result?.error || "Rename failed"), "error");
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

async function deleteSelected() {
  if (selectedItems.size === 0) return;

  const count = selectedItems.size;

  // If we are already browsing Trash, "Move to Trash" is meaningless.
  // In that case, only allow permanent delete.
  const choice = isInTrash
    ? "permanent"
    : await showDeleteChoiceModal(
        "Delete items",
        `What do you want to do with ${count} item(s)?`,
      );

  if (!isInTrash && choice === "cancel") return;

  let sudoPassword = null;
  let sudoCancelled = false;

  try {
    for (const p of selectedItems) {
      if (choice === "permanent") {
        let result = await window.fileManager.deleteItem(p);

        // If permission denied, ask for sudo password and retry
        if (!result.success && (result.code === "EACCES" || result.code === "EPERM")) {
          if (!sudoPassword && !sudoCancelled) {
            const input = await showTextInputModal(
              "Permission Denied",
              `Privileges required to delete "${p.split(/[/\\]/).pop()}".\nEnter sudo password:`,
              "",
              "Delete",
              "password"
            );
            if (input !== null) {
              sudoPassword = input;
            } else {
              sudoCancelled = true;
            }
          }

          if (sudoPassword) {
            result = await window.fileManager.deleteItemSudo(p, sudoPassword);
            // If sudo failed (e.g. wrong password), clear it so we can try again for next item
            if (!result.success) {
              sudoPassword = null;
            }
          }
        }

        if (!result.success) {
          // If it still fails (or user cancelled password), report error
          showNotification(`Failed to delete: ${result.error}`, "error");
        }
      } else {
        await window.fileManager.trashItem(p);
      }
    }

    showNotification(
      choice === "permanent"
        ? `Permanently deleted ${count} item(s)`
        : `Moved ${count} item(s) to Trash`,
    );
    selectedItems.clear();
    refresh();
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

async function extractSelected() {
  if (selectedItems.size === 0) return;
  const archiveExts = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tar.gz", "tar.bz2", "tar.xz", "tgz"];

  for (const p of selectedItems) {
    const lower = p.toLowerCase();
    const isArchive = archiveExts.some(ext => lower.endsWith(`.${ext}`));
    if (!isArchive) continue;

    try {
      showNotification(`Extracting ${p.split(/[/\\]/).pop()}...`);
      const result = await window.fileManager.extractArchive(p, currentPath);
      if (result.success) {
        showNotification(`Extracted to ${result.outputDir || currentPath}`);
      } else {
        showNotification(`Extract failed: ${result.error}`, "error");
      }
    } catch (error) {
      showNotification(`Extract error: ${error.message}`, "error");
    }
  }
  refresh();
}

async function compressSelected() {
  if (selectedItems.size === 0) return;
  const paths = Array.from(selectedItems);

  // Generate default name from first item or "archive"
  let defaultName = paths.length === 1
    ? paths[0].split(/[/\\]/).pop()
    : "archive";
  defaultName = defaultName.replace(/\.[^/.]+$/, "") + ".zip";

  const archiveName = await showTextInputModal(
    "Compress",
    "Archive name:",
    defaultName,
    "Compress"
  );
  if (!archiveName) return;

  try {
    showNotification(`Compressing ${paths.length} item(s)...`);
    const outputPath = await window.fileManager.joinPaths(currentPath, archiveName);
    const result = await window.fileManager.compressItems(paths, outputPath);
    if (result.success) {
      showNotification(`Created ${archiveName}`);
      refresh();
    } else {
      showNotification(`Compress failed: ${result.error}`, "error");
    }
  } catch (error) {
    showNotification(`Compress error: ${error.message}`, "error");
  }
}

async function createNewFolder() {
  console.log("[action] createNewFolder start", { currentPath });
  const raw = await showTextInputModal(
    "New Folder",
    "Enter folder name:",
    "New Folder",
    "Create",
  );
  if (raw === null) {
    console.log("[action] createNewFolder cancelled");
    return;
  }

  const validated = validateNewItemName(raw);
  if (!validated.ok) {
    showNotification(validated.reason, "error");
    return;
  }

  try {
    const result = await window.fileManager.createFolder(
      currentPath,
      validated.name,
    );

    if (result.success) {
      const createdName = result.path
        ? result.path.split(/[/\\]/).pop()
        : validated.name;

      showNotification(`Created folder: ${createdName}`);
      await navigateTo(currentPath);

      // Auto-select + scroll + rename
      const createdPath =
        result.path ||
        (await window.fileManager.joinPaths(currentPath, createdName));
      selectSingleItemByPath(createdPath);
      scrollItemIntoView(createdPath);
    } else {
      showNotification("Error: " + result.error, "error");
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

async function createNewFile() {
  console.log("[action] createNewFile start", { currentPath });
  const raw = await showTextInputModal(
    "New File",
    "Enter file name:",
    "New File.txt",
    "Create",
  );
  if (raw === null) {
    console.log("[action] createNewFile cancelled");
    return;
  }

  const validated = validateNewItemName(raw);
  if (!validated.ok) {
    showNotification(validated.reason, "error");
    return;
  }

  try {
    const result = await window.fileManager.createFile(
      currentPath,
      validated.name,
    );

    if (result.success) {
      const createdName = result.path
        ? result.path.split(/[/\\]/).pop()
        : validated.name;

      showNotification(`Created file: ${createdName}`);
      await navigateTo(currentPath);

      // Auto-select + scroll + rename
      const createdPath =
        result.path ||
        (await window.fileManager.joinPaths(currentPath, createdName));
      selectSingleItemByPath(createdPath);
      scrollItemIntoView(createdPath);
    } else {
      showNotification("Error: " + result.error, "error");
    }
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

// Update toolbar buttons when browsing Trash:
// - New Folder/New File become "Empty Trash"
function updateToolbarForTrash() {
  // When in Trash, hide New Folder/New File and show a single wide "Empty Trash" button.
  if (!newFolderBtn || !newFileBtn || !emptyTrashBtn) return;

  if (isInTrash) {
    newFolderBtn.style.display = "none";
    newFileBtn.style.display = "none";
    emptyTrashBtn.style.display = "";
    emptyTrashBtn.title = "Empty Trash";
  } else {
    newFolderBtn.style.display = "";
    newFileBtn.style.display = "";
    emptyTrashBtn.style.display = "none";
    newFolderBtn.title = "New Folder";
    newFileBtn.title = "New File";
  }
}

// Permanently delete everything currently in Trash directory (best-effort).
async function emptyTrash() {
  if (!commonDirs || !commonDirs.trash) {
    showNotification("Trash folder is not available", "error");
    return;
  }

  // Must be in trash to empty it (safety)
  if (!isInTrash) return;

  const confirm = await showTextInputModal(
    "Empty Trash",
    "This will permanently delete all items in Trash. This cannot be undone.\n\nType DELETE to confirm:",
    "",
    "Empty Trash",
  );

  if (confirm === null) return;

  if (String(confirm).trim().toUpperCase() !== "DELETE") {
    showNotification("Empty Trash cancelled", "error");
    return;
  }

  try {
    // Ensure we have the latest listing
    const res = await window.fileManager.getDirectoryContents(commonDirs.trash);
    if (!res || !res.success) {
      showNotification("Failed to read Trash", "error");
      return;
    }

    // Permanently delete every item inside Trash
    for (const item of res.contents) {
      await window.fileManager.deleteItem(item.path);
    }

    showNotification("Trash emptied");
    await navigateTo(commonDirs.trash);
  } catch (error) {
    showNotification("Error: " + error.message, "error");
  }
}

// Keyboard shortcuts
function handleKeyboard(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case "a":
        e.preventDefault();
        currentItems.forEach((item) => selectedItems.add(item.path));
        updateSelectionUI();
        break;
      case "c":
        e.preventDefault();
        copySelected();
        break;
      case "x":
        e.preventDefault();
        cutSelected();
        break;
      case "v":
        e.preventDefault();
        paste();
        break;
      case "r":
        e.preventDefault();
        refresh();
        break;
      case "t":
        e.preventDefault();
        createNewTab();
        break;
      case "w":
        e.preventDefault();
        closeTab(activeTabIndex);
        break;
    }
  } else {
    switch (e.key) {
      case "Delete":
        deleteSelected();
        break;
      case "F2":
        renameSelected();
        break;
      case "Enter":
        openSelected();
        break;
      case "Backspace":
        goUp();
        break;
      case "Escape":
        selectedItems.clear();
        updateSelectionUI();
        break;
    }
  }
}

// Helper to persist folder size cache (debounced)
let saveCacheTimeout;
function saveFolderSizeCache() {
  clearTimeout(saveCacheTimeout);
  saveCacheTimeout = setTimeout(() => {
    try {
      // Trim cache before persisting to limit memory/storage use
      trimCache(folderSizeCache, MAX_FOLDER_SIZE_CACHE_ENTRIES);
      const obj = Object.fromEntries(folderSizeCache);
      localStorage.setItem("folderSizeCache", JSON.stringify(obj));
    } catch {}
  }, 2000);
}

// ---- Lazy folder sizes helpers ----

function scheduleVisibleFolderSizes() {
  if (!fileList) return;
  if (!calculateFolderSizes) return;

  const rows = Array.from(fileList.querySelectorAll(".file-item")).filter(
    (el) => el.dataset.isDirectory === "true",
  );

  for (const row of rows) {
    const folderPath = row.dataset.path;
    if (!folderPath) continue;

    // Check cache against current item's modification time
    const cached = folderSizeCache.get(folderPath);
    const item = currentItems.find(i => i.path === folderPath);
    // Use mtime from item if available, otherwise 0 (forces recalc if cache has mtime)
    const currentMtime = item && item.modified ? new Date(item.modified).getTime() : 0;

    const fresh = cached && cached.mtime === currentMtime ? cached : null;

    if (fresh) {
      const cell = row.querySelector('[data-role="size"]');
      if (cell) cell.textContent = formatSize(fresh.size);
      continue;
    }

    // Only queue if not already running
    if (!folderSizeInFlight.has(folderPath)) {
      enqueueFolderSize(folderPath);
    }
  }
}

function enqueueFolderSize(folderPath) {
  folderSizeQueue.push(folderPath);
  drainFolderSizeQueue();
}

function drainFolderSizeQueue() {
  while (
    folderSizeActive < FOLDER_SIZE_CONCURRENCY &&
    folderSizeQueue.length > 0
  ) {
    const folderPath = folderSizeQueue.shift();
    if (!folderPath) continue;

    // It may have become cached while waiting
    const cached = folderSizeCache.get(folderPath);
    // We need the item to check mtime again
    const item = currentItems.find(i => i.path === folderPath);
    const currentMtime = item && item.modified ? new Date(item.modified).getTime() : 0;
    const fresh = cached && cached.mtime === currentMtime ? cached : null;

    if (fresh) {
      updateFolderSizeCell(folderPath, fresh.size);
      continue;
    }

    if (folderSizeInFlight.has(folderPath)) continue;

    folderSizeActive++;

    const p = (async () => {
      try {
        const res = await window.fileManager.getItemInfo(folderPath);
        if (
          res &&
          res.success &&
          res.info &&
          typeof res.info.size === "number"
        ) {
          const mtime = res.info.modified ? new Date(res.info.modified).getTime() : 0;
          folderSizeCache.set(folderPath, {
            size: res.info.size,
            mtime: mtime,
          });
          saveFolderSizeCache();
          updateFolderSizeCell(folderPath, res.info.size);
          return res.info.size;
        }
        updateFolderSizeCell(folderPath, null);
        return null;
      } catch {
        updateFolderSizeCell(folderPath, null);
        return null;
      } finally {
        folderSizeActive--;
        folderSizeInFlight.delete(folderPath);
        drainFolderSizeQueue();
      }
    })();

    folderSizeInFlight.set(folderPath, p);
  }
}

function updateFolderSizeCell(folderPath, sizeOrNull) {
  if (!fileList) return;

  const row = fileList.querySelector(
    `.file-item[data-path="${cssEscape(folderPath)}"]`,
  );
  if (!row) return;

  const cell = row.querySelector('[data-role="size"]');
  if (!cell) return;

  if (typeof sizeOrNull === "number") {
    cell.textContent = formatSize(sizeOrNull);

    // If we're sorting by size, re-render so folder rows move into the correct order
    // as their sizes become available (lazy async computation).
    if (sortBy === "size") {
      queueMicrotask(() => renderFiles());
    }
  } else {
    // If we couldn't compute, show "—" instead of leaving a spinner forever
    cell.textContent = "—";
  }
}

// Minimal CSS escape for attribute selectors
function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

// Preview Panel Logic

function updatePreviewPanelVisibility() {
  if (!previewPanel) return;
  
  if (showPreviewPane) {
    previewPanel.classList.add("visible");
    updatePreviewPanelContent();
  } else {
    previewPanel.classList.remove("visible");
  }
}

function updatePreviewPanelContent() {
  if (!showPreviewPane) return;

  // Show preview if exactly one item is selected
  if (selectedItems.size === 1) {
    const selectedPath = Array.from(selectedItems)[0];
    const item = currentItems.find((i) => i.path === selectedPath);
    if (item) {
      renderPreviewItem(item);
      return;
    }
  }
  
  renderPreviewEmpty();
}

async function renderPreviewItem(item) {
  if (!previewPanel || !previewContent) return;

  // Show loading state
  previewContent.innerHTML = `
    <div class="preview-loading">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
        <path d="M12 2 A10 10 0 0 1 22 12" stroke-linecap="round"/>
      </svg>
      <p>Loading preview...</p>
    </div>
  `;

  try {
    const fileType = getFileType(item);
    const ext = (item.extension || "").toLowerCase();

    // Get file/folder info first
    const info = await window.fileManager.getItemInfo(item.path);
    const itemInfo = info.success ? info.info : null;

    // Folder preview
    if (item.isDirectory) {
      try {
        const folderContents = await window.fileManager.getDirectoryContents(item.path);
        if (folderContents.success) {
          const items = folderContents.contents || [];
          const fileCount = items.filter(i => !i.isDirectory).length;
          const folderCount = items.filter(i => i.isDirectory).length;
          const totalSize = itemInfo?.size || 0;

          previewContent.innerHTML = `
            <div class="preview-info">
              <div class="preview-info-item">
                <span class="preview-info-label">Name:</span>
                <span class="preview-info-value">${escapeHtml(item.name)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Size:</span>
                <span class="preview-info-value">${formatSize(totalSize)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Items:</span>
                <span class="preview-info-value">${items.length} (${folderCount} folders, ${fileCount} files)</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Modified:</span>
                <span class="preview-info-value">${formatDate(itemInfo?.modified || item.modified)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Path:</span>
                <span class="preview-info-value">${escapeHtml(item.path)}</span>
              </div>
            </div>
          `;
          return;
        }
      } catch (error) {
        // Fall through to show basic info
      }
    }

    // Image preview with details
    if (fileType === fileTypes.image) {
      const imageUrl = `file://${item.path.replace(/\\/g, "/")}`;
      const imageInfo = itemInfo || {};
      
      // Get image metadata
      let imageMetadata = null;
      try {
        const metadataResult = await window.fileManager.getImageMetadata(item.path);
        if (metadataResult.success) {
          imageMetadata = metadataResult.metadata;
        }
      } catch (error) {
        // Metadata fetch failed, continue without it
      }

      previewContent.innerHTML = `
        <img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(item.name)}" class="preview-image" style="margin-bottom: 16px;" onerror="this.parentElement.innerHTML='<div class=\\'preview-error\\'>Failed to load image</div>'">
        <div class="preview-info">
          <div class="preview-info-item">
            <span class="preview-info-label">Name:</span>
            <span class="preview-info-value">${escapeHtml(item.name)}</span>
          </div>
          ${imageMetadata ? `
          ${imageMetadata.width && imageMetadata.height ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Dimensions:</span>
            <span class="preview-info-value">${imageMetadata.width} × ${imageMetadata.height} px</span>
          </div>
          ` : ""}
          <div class="preview-info-item">
            <span class="preview-info-label">Format:</span>
            <span class="preview-info-value">${escapeHtml((imageMetadata.type || ext || "Unknown").toUpperCase())}</span>
          </div>
          ${imageMetadata.hasAlpha !== undefined ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Alpha Channel:</span>
            <span class="preview-info-value">${imageMetadata.hasAlpha ? "Yes" : "No"}</span>
          </div>
          ` : ""}
          ${imageMetadata.orientation ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Orientation:</span>
            <span class="preview-info-value">${imageMetadata.orientation}</span>
          </div>
          ` : ""}
          ` : ""}
          <div class="preview-info-item">
            <span class="preview-info-label">File Size:</span>
            <span class="preview-info-value">${formatSize(imageMetadata?.fileSize || imageInfo.size || item.size)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Modified:</span>
            <span class="preview-info-value">${formatDate(imageInfo.modified || item.modified)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Path:</span>
            <span class="preview-info-value">${escapeHtml(item.path)}</span>
          </div>
        </div>
      `;
      return;
    }

    // Video preview with details
    if (fileType === fileTypes.video) {
      const videoUrl = `file://${item.path.replace(/\\/g, "/")}`;
      const videoInfo = itemInfo || {};
      
      // Get video metadata
      let videoMetadata = null;
      try {
        const metadataResult = await window.fileManager.getVideoMetadata(item.path);
        if (metadataResult.success) {
          videoMetadata = metadataResult.metadata;
        }
      } catch (error) {
        // Metadata fetch failed, continue without it
      }

      const formatDuration = (seconds) => {
        if (!seconds) return "—";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        return `${m}:${s.toString().padStart(2, "0")}`;
      };

      const formatBitrate = (bps) => {
        if (!bps) return "—";
        if (bps < 1000) return `${bps} bps`;
        if (bps < 1000000) return `${(bps / 1000).toFixed(1)} kbps`;
        return `${(bps / 1000000).toFixed(2)} Mbps`;
      };

      previewContent.innerHTML = `
        <video src="${escapeHtmlAttr(videoUrl)}" controls class="preview-video" style="margin-bottom: 16px;" onerror="this.parentElement.innerHTML='<div class=\\'preview-error\\'>Failed to load video</div>'"></video>
        <div class="preview-info">
          <div class="preview-info-item">
            <span class="preview-info-label">Name:</span>
            <span class="preview-info-value">${escapeHtml(item.name)}</span>
          </div>
          ${videoMetadata ? `
          ${videoMetadata.videoWidth && videoMetadata.videoHeight ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Resolution:</span>
            <span class="preview-info-value">${videoMetadata.videoWidth} × ${videoMetadata.videoHeight} px</span>
          </div>
          ` : ""}
          ${videoMetadata.duration ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Duration:</span>
            <span class="preview-info-value">${formatDuration(videoMetadata.duration)}</span>
          </div>
          ` : ""}
          ${videoMetadata.videoFps ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Frame Rate:</span>
            <span class="preview-info-value">${videoMetadata.videoFps.toFixed(2)} fps</span>
          </div>
          ` : ""}
          ${videoMetadata.videoCodec ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Video Codec:</span>
            <span class="preview-info-value">${escapeHtml(videoMetadata.videoCodec.toUpperCase())}</span>
          </div>
          ` : ""}
          ${videoMetadata.audioCodec ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Audio Codec:</span>
            <span class="preview-info-value">${escapeHtml(videoMetadata.audioCodec.toUpperCase())}</span>
          </div>
          ` : ""}
          ${videoMetadata.audioChannels ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Audio Channels:</span>
            <span class="preview-info-value">${videoMetadata.audioChannels}</span>
          </div>
          ` : ""}
          ${videoMetadata.audioSampleRate ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Sample Rate:</span>
            <span class="preview-info-value">${(videoMetadata.audioSampleRate / 1000).toFixed(1)} kHz</span>
          </div>
          ` : ""}
          ${videoMetadata.bitrate ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Bitrate:</span>
            <span class="preview-info-value">${formatBitrate(videoMetadata.bitrate)}</span>
          </div>
          ` : ""}
          ${videoMetadata.note ? `
          <div class="preview-info-item">
            <span class="preview-info-label">Note:</span>
            <span class="preview-info-value" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(videoMetadata.note)}</span>
          </div>
          ` : ""}
          ` : ""}
          <div class="preview-info-item">
            <span class="preview-info-label">File Size:</span>
            <span class="preview-info-value">${formatSize(videoMetadata?.fileSize || videoInfo.size || item.size)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Modified:</span>
            <span class="preview-info-value">${formatDate(videoInfo.modified || item.modified)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Path:</span>
            <span class="preview-info-value">${escapeHtml(item.path)}</span>
          </div>
        </div>
      `;
      return;
    }

    // Text file preview
    const textExtensions = [
      ".txt", ".md", ".json", ".xml", ".html", ".css", ".js", ".ts",
      ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".rs", ".go", ".rb",
      ".php", ".sh", ".bat", ".yml", ".yaml", ".ini", ".conf", ".log",
      ".csv", ".tsv", ".sql", ".rtf", ".tex", ".latex"
    ];

    if (textExtensions.includes(ext)) {
      try {
        const result = await window.fileManager.readFilePreview(item.path);
        if (result.success) {
          const escapedContent = escapeHtml(result.content);
          previewContent.innerHTML = `
            <div class="preview-text" style="margin-bottom: 16px;">${escapedContent}</div>
            <div class="preview-info">
              <div class="preview-info-item">
                <span class="preview-info-label">Name:</span>
                <span class="preview-info-value">${escapeHtml(item.name)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Size:</span>
                <span class="preview-info-value">${formatSize(itemInfo?.size || item.size)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Type:</span>
                <span class="preview-info-value">${escapeHtml(ext || "Text")}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Modified:</span>
                <span class="preview-info-value">${formatDate(itemInfo?.modified || item.modified)}</span>
              </div>
              <div class="preview-info-item">
                <span class="preview-info-label">Path:</span>
                <span class="preview-info-value">${escapeHtml(item.path)}</span>
              </div>
            </div>
          `;
          return;
        } else {
          // Fall through to show info
        }
      } catch (error) {
        // Fall through to show info
      }
    }

    // File info preview for other file types
    if (itemInfo) {
      previewContent.innerHTML = `
        <div class="preview-info">
          <div class="preview-info-item">
            <span class="preview-info-label">Name:</span>
            <span class="preview-info-value">${escapeHtml(item.name)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Size:</span>
            <span class="preview-info-value">${formatSize(itemInfo.size)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Type:</span>
            <span class="preview-info-value">${escapeHtml(ext || "Unknown")}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Modified:</span>
            <span class="preview-info-value">${formatDate(itemInfo.modified)}</span>
          </div>
          <div class="preview-info-item">
            <span class="preview-info-label">Path:</span>
            <span class="preview-info-value">${escapeHtml(item.path)}</span>
          </div>
        </div>
      `;
    } else {
      previewContent.innerHTML = `
        <div class="preview-error">Cannot load file information</div>
      `;
    }
  } catch (error) {
    previewContent.innerHTML = `
      <div class="preview-error">Error: ${escapeHtml(error.message)}</div>
    `;
  }
}

function renderPreviewEmpty() {
  if (!previewContent) return;
  previewContent.innerHTML = `
    <div class="preview-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="64" height="64">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21,15 16,10 5,21"/>
        </svg>
        <p>Select a file to preview</p>
    </div>
  `;
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", init);
