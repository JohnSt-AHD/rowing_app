import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';
import { capacitorNativeHtml } from '../../packages/vite-plugins/capacitor-html.ts';

function readNativeAppVersion(): { version: string; versionCode: string } {
  const gradlePath = path.resolve(
    __dirname,
    '../recorder-native/android/app/build.gradle',
  );
  const text = fs.readFileSync(gradlePath, 'utf8');
  const version = text.match(/versionName\s+"([^"]+)"/)?.[1] ?? '';
  const versionCode = text.match(/versionCode\s+(\d+)/)?.[1] ?? '';
  return { version, versionCode };
}

function readWebAppVersion(): string {
  const pkgPath = path.resolve(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? '';
}

export default defineConfig(({ mode }) => {
  const isNative = mode === 'native';
  const nativeVersion = isNative ? readNativeAppVersion() : null;
  const appVersion = nativeVersion?.version ?? readWebAppVersion();
  const appVersionCode = nativeVersion?.versionCode ?? '';

  return {
    base: isNative ? './' : '/',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      modulePreload: false,
      commonjsOptions: {
        defaultIsModuleExports: true,
      },
    },
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isNative ? 'native' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_VERSION_CODE': JSON.stringify(appVersionCode),
    },
    resolve: {
      alias: {
        '@rowing/telemetry-types': path.resolve(
          __dirname,
          '../../packages/telemetry-types/src/index.ts',
        ),
        '@rowing/motion-analysis': path.resolve(
          __dirname,
          '../../packages/motion-analysis/index.js',
        ),
        '@rowing/rowing-pace': path.resolve(
          __dirname,
          '../../packages/rowing-pace/index.js',
        ),
        '@rowing/sensor-adapters': path.resolve(
          __dirname,
          isNative
            ? '../../packages/sensor-adapters/src/capacitor/index.ts'
            : '../../packages/sensor-adapters/src/web/index.ts',
        ),
      },
    },
    plugins: [
      ...(isNative
        ? [capacitorNativeHtml()]
        : [
            VitePWA({
              registerType: 'autoUpdate',
              strategies: 'injectManifest',
              srcDir: 'src',
              filename: 'sw.ts',
              injectRegister: 'auto',
              includeAssets: ['icons/icon.svg'],
              manifest: {
                name: 'CrewSight',
                short_name: 'CrewSight',
                description: 'GPS rowing recorder — HR, stroke rate, capsize safety',
                theme_color: '#0a1628',
                background_color: '#0a1628',
                display: 'standalone',
                orientation: 'portrait',
                start_url: '/',
                icons: [
                  {
                    src: 'icons/icon-192.png',
                    sizes: '192x192',
                    type: 'image/png',
                  },
                  {
                    src: 'icons/icon-512.png',
                    sizes: '512x512',
                    type: 'image/png',
                  },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                runtimeCaching: [
                  {
                    urlPattern: /^https:\/\/.*\/api\/ingest/,
                    handler: 'NetworkOnly',
                  },
                ],
              },
            }),
          ]),
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
