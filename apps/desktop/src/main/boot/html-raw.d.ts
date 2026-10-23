// Vite `?raw` import type for the static boot page bundled into the main process.
declare module '*.html?raw' {
  const content: string;
  export default content;
}
