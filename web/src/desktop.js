// @ts-check
// web/src/desktop.js. The desktop app's bridge (spec 027 G5): inside the Veritas app the window injects
// `window.__TAURI__` (tauri.conf.json withGlobalTauri) and grants this page only the Browse commands
// (app/src-tauri/capabilities/browse.json). In a web browser or on the phone there is no bridge and no Browse.

/** @typedef {{ available: Promise<boolean>, invoke(cmd: string, args?: Record<string, unknown>): Promise<any>, on(event: string, fn: (payload: any) => void): () => void }} Bridge */

/** @param {Window} win @returns {Bridge | null} */
export function desktopBridge(win) {
  const tauri = /** @type {any} */ (win).__TAURI__;
  if (typeof tauri?.core?.invoke !== 'function' || typeof tauri?.event?.listen !== 'function') return null;
  /** @type {(cmd: string, args?: Record<string, unknown>) => Promise<any>} */
  const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
  return {
    available: invoke('browse_available').then(Boolean, () => false),
    invoke,
    on(event, fn) {
      let gone = false;
      /** @type {(() => void) | null} */ let stop = null;
      Promise.resolve(tauri.event.listen(event, (/** @type {{ payload: any }} */ e) => fn(e.payload))).then(
        (unlisten) => { if (gone) unlisten(); else stop = unlisten; },
        () => {},
      );
      return () => { gone = true; stop?.(); };
    },
  };
}
