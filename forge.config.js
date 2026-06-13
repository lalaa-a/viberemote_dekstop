const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

module.exports = {
  packagerConfig: {
    name: 'VibeRemote',
    executableName: 'VibeRemote',
    asar: true,
    // relay-deamon1 must be outside asar so Node can exec its scripts.
    // We mirror the Vite plugin's default ignore (only keep .vite/) and also
    // exclude relay-deamon1 since it is copied via extraResource below.
    // Using a function avoids the "you have set packagerConfig.ignore" warning
    // that strips the Vite plugin's own ignore logic.
    ignore: (filepath) => {
      if (!filepath) return false;                      // root — always include
      if (filepath === '/package.json') return false;   // Electron needs this
      if (filepath.startsWith('/.vite')) return false;  // Vite build output
      return true;                                       // exclude everything else
    },
    extraResource: ['relay-deamon1'],
  },
  hooks: {
    postPackage: async (_forgeConfig, options) => {
      for (const outputPath of options.outputPaths) {
        const relayPath = path.join(outputPath, 'resources', 'relay-deamon1');
        const nodeModules = path.join(relayPath, 'node_modules');

        // 1. Strip the dev .env — each install generates its own
        try { fs.unlinkSync(path.join(relayPath, '.env')); } catch {}

        // 2. Strip git history — never ship .git to end users, and the git object
        //    files trigger SharpCompress decompression errors in Squirrel's NuGet extractor.
        try { fs.rmSync(path.join(relayPath, '.git'), { recursive: true, force: true }); } catch {}

        // 3. Remove build-time-only packages (not needed at runtime):
        //    - node-addon-api: only used to build native addons from source; prebuilts are used instead.
        //      It also contains a zero-byte nothing.c that can trigger a SharpCompress Deflate bug.
        //    - @types/*: TypeScript type declarations, never loaded at runtime.
        //    - undici-types: ditto.
        try { fs.rmSync(path.join(nodeModules, 'node-addon-api'), { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(nodeModules, '@types'), { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(nodeModules, 'undici-types'), { recursive: true, force: true }); } catch {}

        // 4. node-pty: keep only the win32-x64 runtime binaries, remove everything else.
        const nodeptyPath = path.join(nodeModules, 'node-pty');
        const prebuildsPath = path.join(nodeptyPath, 'prebuilds');

        // Remove non-Windows prebuilds
        for (const dir of ['darwin-arm64', 'darwin-x64', 'win32-arm64']) {
          try { fs.rmSync(path.join(prebuildsPath, dir), { recursive: true, force: true }); } catch {}
        }

        // Remove .pdb debug symbol files from win32-x64 — not needed at runtime.
        // Large Windows PDB files are also the most likely trigger for SharpCompress's
        // "WriteEntryTo or OpenEntryStream can only be called once" bug in this Squirrel version.
        const win32x64Path = path.join(prebuildsPath, 'win32-x64');
        if (fs.existsSync(win32x64Path)) {
          for (const f of fs.readdirSync(win32x64Path)) {
            if (f.endsWith('.pdb')) {
              try { fs.unlinkSync(path.join(win32x64Path, f)); } catch {}
            }
          }
        }

        // Remove node-pty build, source, and dev-only directories.
        // build/ only has conpty.dll + OpenConsole.exe (duplicated from prebuilds/win32-x64),
        // so removing it avoids a third copy of those DLLs in the nupkg.
        for (const dir of ['build', 'src', 'deps', 'scripts', 'typings', 'third_party']) {
          try { fs.rmSync(path.join(nodeptyPath, dir), { recursive: true, force: true }); } catch {}
        }
      }
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'VibeRemote',
        setupExe: 'VibeRemoteSetup.exe',
        setupIcon: undefined,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Disabled: relay-deamon1 resources live outside asar
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};
