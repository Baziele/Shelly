import { defineConfig } from 'tsup';

export default defineConfig({
  // Keep `node:` imports as written: node:sqlite has no unprefixed name.
  removeNodeProtocol: false,
});
