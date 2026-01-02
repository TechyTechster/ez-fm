#!/usr/bin/env node
const dbus = require('dbus-next');
const { spawn } = require('child_process');
const path = require('path');

const APP_PATH = process.env.APP_PATH || path.dirname(require.main.filename);
const ELECTRON_BIN = process.env.ELECTRON_BIN || 'electron';
const SERVICE_NAME = 'org.freedesktop.impl.portal.myfm';
const OBJECT_PATH = '/org/freedesktop/portal/desktop';

function launchPicker(mode, multiple, currentName) {
  return new Promise((resolve) => {
    const args = ['--picker', `--mode=${mode}`];
    if (multiple) args.push('--multiple');
    if (currentName && mode === 'save') args.push(`--filename=${currentName}`);

    console.log(`[Portal] Launching: ${ELECTRON_BIN} ${APP_PATH} ${args.join(' ')}`);

    const child = spawn(
      ELECTRON_BIN,
      [
        APP_PATH,
        '--ozone-platform=wayland',
        '--enable-features=UseOzonePlatform',
        ...args,
      ],
      {
        cwd: APP_PATH,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':0',
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-1',
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000',
          ELECTRON_OZONE_PLATFORM_HINT: 'wayland'
        }
      }
    );

    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { console.error('[Electron Error]', data.toString()); });

    child.on('close', (code) => {
      console.log(`[Portal] Electron exited with code ${code}`);
      if (code === 0) {
        const paths = output.trim().split('\n').filter(Boolean);
        if (paths.length === 0) {
          resolve([1, {}]);
          return;
        }
        const uris = paths.map(p => 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p));
        console.log(`[Portal] Success: ${uris.length} item(s)`);
        resolve([0, { uris: new dbus.Variant('as', uris) }]);
      } else {
        resolve([1, {}]);
      }
    });

    child.on('error', () => resolve([2, {}]));
  });
}

const { Interface } = dbus.interface;

class FileChooserInterface extends Interface {
  constructor() {
    super('org.freedesktop.impl.portal.FileChooser');
  }

  OpenFile(handle, app_id, parent_window, title, options) {
    const isDirectory = options.directory?.value || false;
    const mode = isDirectory ? 'directory' : 'open';
    console.log(`[Portal] OpenFile called by ${app_id || 'unknown'} (mode: ${mode})`);
    return launchPicker(mode, options.multiple?.value || false, null);
  }

  SaveFile(handle, app_id, parent_window, title, options) {
    console.log(`[Portal] SaveFile called`);
    return launchPicker('save', false, options.current_name?.value || '');
  }

  SaveFiles(handle, app_id, parent_window, title, options) {
    console.log(`[Portal] SaveFiles called`);
    return launchPicker('save', false, options.current_name?.value || '');
  }
}

FileChooserInterface.configureMembers({
  methods: {
    OpenFile: {
      inSignature: 'osssa{sv}',
      outSignature: 'ua{sv}'
    },
    SaveFile: {
      inSignature: 'osssa{sv}',
      outSignature: 'ua{sv}'
    },
    SaveFiles: {
      inSignature: 'osssa{sv}',
      outSignature: 'ua{sv}'
    }
  }
});

async function main() {
  const bus = dbus.sessionBus();

  console.log('[Portal] Starting...');
  const nameRequest = await bus.requestName(SERVICE_NAME, 7);

  if (nameRequest !== 1 && nameRequest !== 4) {
    console.error('[Portal] Failed to acquire name');
    process.exit(1);
  }

  console.log(`[Portal] Acquired: ${SERVICE_NAME}`);

  const iface = new FileChooserInterface();
  bus.export(OBJECT_PATH, iface);

  console.log('[Portal] Ready and listening!');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(err => { console.error('[Portal] Error:', err.stack); process.exit(1); });
