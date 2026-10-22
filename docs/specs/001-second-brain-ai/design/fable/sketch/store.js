// Stores over Host.files. One runtime owns one dataDir; there is no locking because there is no second writer.
/** @typedef {import("./types").Conversation} Conversation */
/** @typedef {import("./types").ConversationId} ConversationId */

export class ConversationStore {
  /** @param {import("./types").Host["files"]} files @param {string} dir  <dataDir>/chats */
  constructor(files, dir) { throw new Error("not implemented"); }
  /** chats/<id>.jsonl: line 1 is the header {id,title,mode,provider,model,web,createdAt}; each later line is a StoredTurn. */
  create(header) { throw new Error("not implemented"); }
  append(id, turn) { throw new Error("not implemented"); }
  read(id) { throw new Error("not implemented"); }
  list() { throw new Error("not implemented"); }
  rename(id, title) { throw new Error("not implemented"); }  // rewrites the header line
  remove(id) { throw new Error("not implemented"); }
  /** Adopt foreign conversations by id; an existing id is skipped, so a retried import converges. */
  import(conversations) { throw new Error("not implemented"); }
}

export class ReviewStore {
  /** @param {string} dir <dataDir>/reviews */
  constructor(files, dir) { throw new Error("not implemented"); }
  create(id, input) { throw new Error("not implemented"); }         // reviews/<id>/review.json (input + startedAt only)
  exists(id, relPath) { throw new Error("not implemented"); }
  readJson(id, relPath) { throw new Error("not implemented"); }
  writeJson(id, relPath, value) { throw new Error("not implemented"); } // write to a temp name then rename, so a crash never leaves a half file that resume would trust
  writeText(id, relPath, text) { throw new Error("not implemented"); }
  listFindings(id) { throw new Error("not implemented"); }           // findings/*.json
  list() { throw new Error("not implemented"); }
}
