import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { capacitorNativeHtml } from '../../packages/vite-plugins/capacitor-html.ts';

function readNativeAppVersion(): { version: string; versionCode: string } {
  const gradlePath = path.resolve(
    __dirname,
    '../coach-native/android/app/build.gradle',
  );
  if (!fs.existsSync(gradlePath)) {
    return { version: '0.1.0', versionCode: '1' };
  }
  const text = fs.readFileSync(gradlePath, 'utf8');
  return {
    version: text.match(/versionName\s+"([^"]+)"/)?.[1] ?? '0.1.0',
    versionCode: text.match(/versionCode\s+(\d+)/)?.[1] ?? '1',
  };
}

export default defineConfig(({ mode }) => {
  const isNative = mode === 'native';
  const isDev = mode === 'development';
  const webBase = isDev ? '/' : '/manager/';
  const nativeVersion = isNative ? readNativeAppVersion() : null;

  return {
    base: isNative ? './' : webBase,
    build: {
      outDir: isNative
        ? path.resolve(__dirname, '../coach-native/www')
        : 'dist',
      emptyOutDir: true,
      modulePreload: false,
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
              includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
              manifest: {
                name: 'CrewSight Manager',
                short_name: 'Manager',
                description:
                  'Fleet map, session history, and capsize monitoring for coaches',
                theme_color: '#0a1628',
                background_color: '#0a1628',
                display: 'standalone',
                orientation: 'any',
                start_url: webBase,
                scope: webBase,
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
                  {
                    src: 'icons/icon-512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable',
                  },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                runtimeCaching: [
                  {
                    urlPattern: /^https:\/\/.*\/api\//,
                    handler: 'NetworkOnly',
                  },
                ],
              },
            }),
          ]),
    ],
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isNative ? 'native' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        nativeVersion?.version ?? '0.1.0',
      ),
    },
    server: {
      port: 5185,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
