/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_CANVAS_PERF?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
