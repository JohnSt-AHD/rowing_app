/**
 * After `npx cap add android`, set version + arm64-only split for the stroke-debug app.
 * Paths are resolved from the repo root (this file lives in scripts/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradlePath = path.join(
  root,
  'apps/stroke-debug-native/android/app/build.gradle',
);
const stringsPath = path.join(
  root,
  'apps/stroke-debug-native/android/app/src/main/res/values/strings.xml',
);

if (!fs.existsSync(gradlePath)) {
  console.error('Missing', gradlePath);
  process.exit(1);
}

let gradle = fs.readFileSync(gradlePath, 'utf8');

if (!/versionCode\s+\d+/.test(gradle)) {
  gradle = gradle.replace(
    /targetSdkVersion rootProject\.ext\.targetSdkVersion\n/,
    `targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "0.1.0"
`,
  );
} else {
  gradle = gradle
    .replace(/versionCode\s+\d+/, 'versionCode 1')
    .replace(/versionName\s+"[^"]+"/, 'versionName "0.1.0"');
}

if (!/splits\s*\{/.test(gradle)) {
  gradle = gradle.replace(
    /buildTypes\s*\{[\s\S]*?\n    \}/,
    (block) => `${block}
    // arm64-only for phone sideload size
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a'
            universalApk false
        }
    }`,
  );
}

fs.writeFileSync(gradlePath, gradle);

if (fs.existsSync(stringsPath)) {
  let strings = fs.readFileSync(stringsPath, 'utf8');
  strings = strings
    .replace(
      /<string name="app_name">[^<]*<\/string>/,
      '<string name="app_name">CrewSight Stroke Debug</string>',
    )
    .replace(
      /<string name="title_activity_main">[^<]*<\/string>/,
      '<string name="title_activity_main">CrewSight Stroke Debug</string>',
    )
    .replace(
      /<string name="package_name">[^<]*<\/string>/,
      '<string name="package_name">nz.org.rowing.strokedebug</string>',
    )
    .replace(
      /<string name="custom_url_scheme">[^<]*<\/string>/,
      '<string name="custom_url_scheme">nz.org.rowing.strokedebug</string>',
    );
  fs.writeFileSync(stringsPath, strings);
}

console.log('[patch-stroke-debug-android] ok');
