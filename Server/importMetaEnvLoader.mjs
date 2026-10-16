// ─────────────────────────────────────────────────────────────
// CAMP-Backend/Server/importMetaEnvLoader.mjs
//
// Test-only ESM loader hook used by peerDurability.test.js.
//
// The offline-admin client modules read `import.meta.env.*`, which Vite
// provides in the browser but Node does not. This hook rewrites those
// reads to a global the test controls, so the REAL client code (peer.js,
// db.js, sync.js, …) can be imported and executed under plain Node.
// It only touches files under offline-admin/src/.
// ─────────────────────────────────────────────────────────────
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.includes("/offline-admin/src/") && url.endsWith(".js")) {
    const { source } = await nextLoad(url, context);
    const patched = String(source).replaceAll(
      "import.meta.env",
      "(globalThis.__VITE_ENV__||{})"
    );
    return { format: "module", source: patched, shortCircuit: true };
  }
  return nextLoad(url, context);
}
