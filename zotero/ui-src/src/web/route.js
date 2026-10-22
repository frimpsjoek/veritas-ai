// @ts-check
// ui-src/src/web/route.js. The web shell's route, kept in location.hash so reload and Back work (spec 013 plan §2).
//   #/home[?issue=]   #/chat[?mode=&session=&project=]   #/library[?collection=]   #/notes[?q=]   #/paper/KEY   #/note/PATH
//   #/routines   #/projects   #/settings[?section=index]   (#/sources, the old radar page, opens Settings > Reading radar)
// `projects` and the `project`/`section` parameters are additions to the plan's WebRoute type.

/** @typedef {"chat" | "ask" | "find" | "report" | "systematic"} RouteChatMode */
/** @typedef {{ view: "home", issue?: string } | { view: "chat", mode?: RouteChatMode, session?: string, project?: string }
 *   | { view: "library", collection?: string } | { view: "notes", q?: string }
 *   | { view: "paper", key: string } | { view: "note", path: string }
 *   | { view: "routines" } | { view: "projects" } | { view: "sources" } | { view: "settings", section?: string }} WebRoute */

export const CHAT_MODES = /** @type {const} */ (['chat', 'ask', 'find', 'report', 'systematic']);

/** @param {string} hash @returns {WebRoute} */
export function parseRoute(hash) {
  const [pathPart = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [view = '', ...rest] = pathPart.split('/');
  const tail = rest.map(decodeURIComponent).join('/');
  switch (view) {
    case 'chat': {
      const mode = params.get('mode');
      return {
        view: 'chat',
        ...(mode && CHAT_MODES.includes(/** @type {any} */ (mode)) ? { mode: /** @type {RouteChatMode} */ (mode) } : {}),
        ...(params.get('session') ? { session: /** @type {string} */ (params.get('session')) } : {}),
        ...(params.get('project') ? { project: /** @type {string} */ (params.get('project')) } : {}),
      };
    }
    case 'library': return { view: 'library', ...(params.get('collection') ? { collection: /** @type {string} */ (params.get('collection')) } : {}) };
    case 'notes': return { view: 'notes', ...(params.get('q') ? { q: /** @type {string} */ (params.get('q')) } : {}) };
    case 'paper': return tail ? { view: 'paper', key: tail } : { view: 'home' };
    case 'note': return tail ? { view: 'note', path: tail } : { view: 'home' };
    case 'routines': return { view: 'routines' };
    case 'projects': return { view: 'projects' };
    case 'sources': return { view: 'settings', section: 'radar' };  // the radar's setup lives in Settings now
    case 'settings': return { view: 'settings', ...(/^[a-z]+$/.test(params.get('section') ?? '') ? { section: /** @type {string} */ (params.get('section')) } : {}) };
    default: return { view: 'home', ...(params.get('issue') ? { issue: /** @type {string} */ (params.get('issue')) } : {}) };
  }
}

/** @param {WebRoute} route */
export function formatRoute(route) {
  /** @param {Record<string, string | undefined>} params */
  const query = (params) => {
    const entries = Object.entries(params).filter(([, v]) => v);
    return entries.length ? `?${new URLSearchParams(/** @type {[string, string][]} */ (entries))}` : '';
  };
  switch (route.view) {
    case 'chat': return `#/chat${query({ mode: route.mode, session: route.session, project: route.project })}`;
    case 'library': return `#/library${query({ collection: route.collection })}`;
    case 'notes': return `#/notes${query({ q: route.q })}`;
    case 'paper': return `#/paper/${encodeURIComponent(route.key)}`;
    case 'note': return `#/note/${route.path.split('/').map(encodeURIComponent).join('/')}`;
    case 'settings': return `#/settings${query({ section: route.section })}`;
    case 'home': return `#/home${query({ issue: route.issue })}`;
    default: return `#/${route.view}`;
  }
}

/** Home's links (home/links.js) as hash routes; a web address goes through the host (spec 015).
 *  @param {{ openLink(url: string, opts?: { outside?: boolean }): void }} host @returns {import('../home/links.js').HomeLinks} */
export function webLinks(host) {
  return {
    href: (target) => (target.to === 'url' ? target.url : target.to === 'session' ? formatRoute({ view: 'chat', session: target.id }) : target.to === 'issue' ? formatRoute({ view: 'home', issue: target.id }) : target.to === 'sources' ? formatRoute({ view: 'settings', section: 'radar' }) : formatRoute({ view: target.to })),
    openWeb: (url, event) => host.openLink(url, event.metaKey || event.ctrlKey || event.shiftKey ? { outside: true } : undefined),
  };
}
