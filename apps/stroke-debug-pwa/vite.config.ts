import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { capacitorNativeHtml } from '../../packages/vite-plugins/capacitor-html.ts';

function readNativeAppVersion(): { version: string; versionCode: string } {
  const gradlePath = path.resolve(
    __dirname,
    '../stroke-debug-native/android/app/build.gradle',
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
  const nativeVersion = isNative ? readNativeAppVersion() : null;

  return {
    base: isNative ? './' : '/',
    build: {
      outDir: isNative
        ? path.resolve(__dirname, '../stroke-debug-native/www')
        : 'dist',
      emptyOutDir: true,
      modulePreload: false,
    },
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isNative ? 'native' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        nativeVersion?.version ?? '0.1.0',
      ),
      'import.meta.env.VITE_APP_VERSION_CODE': JSON.stringify(
        nativeVersion?.versionCode ?? '',
      ),
    },
    resolve: {
      alias: {
        '@rowing/motion-analysis': path.resolve(
          __dirname,
          '../../packages/motion-analysis/index.js',
        ),
        // Motion-only entry — avoid pulling GPS / BLE plugins into this debug app.
        '@rowing/sensor-adapters': path.resolve(
          __dirname,
          isNative
            ? '../../packages/sensor-adapters/src/capacitor/motion.ts'
            : '../../packages/sensor-adapters/src/web/motion.ts',
        ),
        '@rowing/sensor-adapters/types': path.resolve(
          __dirname,
          '../../packages/sensor-adapters/src/types.ts',
        ),
      },
    },
    plugins: isNative ? [capacitorNativeHtml()] : [],
    server: {
      port: 5190,
    },
  };
});
