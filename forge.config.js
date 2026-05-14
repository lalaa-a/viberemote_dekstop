const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

module.exports = {
  packagerConfig: {
    name: 'VibeRemote',
    executableName: 'VibeRemote',
    asar: true,
    // relay-deamon1 must be outside asar so Node can exec its scripts
    ignore: [/^\/relay-deamon1/],
    extraResource: ['relay-deamon1'],
  },
  hooks: {
    // Strip the dev .env from the packaged relay-deamon1 — each install generates its own
    postPackage: async (_forgeConfig, options) => {
      for (const outputPath of options.outputPaths) {
        const envPath = path.join(outputPath, 'resources', 'relay-deamon1', '.env');
        try { fs.unlinkSync(envPath); } catch {}
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
