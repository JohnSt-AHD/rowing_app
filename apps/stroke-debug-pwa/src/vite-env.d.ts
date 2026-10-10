/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_APP_VERSION_CODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
