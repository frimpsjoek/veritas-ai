/* global Zotero, IOUtils, PathUtils, SecondBrain, ChromeUtils */
// content/zotero-host.js: the Host for standalone Zotero. Only file in the plugin that touches Subprocess or Zotero.Server.
// TODO const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

/** @implements {import("./types").Host} */
SecondBrain.ZoteroHost = class {
  constructor(sb) { this.sb = sb; this.dataDir = PathUtils.join(Zotero.DataDirectory.dir, "second-brain"); }

  /** Subprocess.call with stdin/stdout pipes wrapped as ChildProcessLike; stderr is cleaned by the provider. */
  spawn(cmd, args, opts) { throw new Error("not implemented"); }
  /** Zotero.HTTP.request for JSON; a streaming variant with onprogress chunks for OpenAI SSE. */
  fetch(url, init) { throw new Error("not implemented"); }
  files = { read: null, write: null, append: null, list: null, remove: null }; // IOUtils; TODO fill
  /**
   * Registers Zotero.Server.Endpoints["/second-brain/mcp/" + token] (POST, application/json), verified in Spike 2.
   * Returns http://127.0.0.1:<Zotero.Server.port>/second-brain/mcp/<token>. Notifications → [202, "", ""].
   */
  serveMcp(handler) { throw new Error("not implemented"); }
  tools = {
    search_library:   (args, signal) => { throw new Error("not implemented"); }, // local-index.js search + Zotero full text
    read_source:      (args, signal) => { throw new Error("not implemented"); }, // item abstract/notes/full text by key, or a local note
    search_scholarly: (args, signal) => { throw new Error("not implemented"); }, // SecondBrain.Discover.search, marked against the library
    current_item:     (args, signal) => { throw new Error("not implemented"); }, // ZoteroPane selected items
  };
  /** LocalStore.folder/Literature Reviews/<date> <title>.md, collision-safe suffix. */
  writeReport(title, frontMatter, body) { throw new Error("not implemented"); }
  /** Pref path, then CODEX_BINARY / ChatGPT.app bundle / ~/.local/bin / PATH. */
  which(binary) { throw new Error("not implemented"); }
};

/** Picks the runtime the chat tab uses: remote through the Second Brain server when it answers, local otherwise. */
SecondBrain.runtimeFor = function (sb) {
  // TODO if (sb.obsidian reachable) return connectRuntime(sb.server, undefined, zoteroSse); else return sb.localRuntime ??= createRuntime(new SecondBrain.ZoteroHost(sb), () => sb.agentSettings())
  // TODO on transition local → remote: remote.conversations.import(await local.conversations.list()) once, like local notes today
  throw new Error("not implemented");
};
