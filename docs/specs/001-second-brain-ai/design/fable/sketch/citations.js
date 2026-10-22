// Pure citation handling. No provider or host knowledge.
/** @typedef {import("./types").Citation} Citation */

/** Pure. Finds [[Note]] links, [@citekey] keys and bare URLs in model text. */
export function extractCitations(text) { throw new Error("not implemented"); }

/**
 * Resolves each citation through the tool set (search_library exact lookups). Unknown notes and keys come back resolved:false;
 * the caller marks them in the text and never renders them as real links.
 * @param {ReturnType<typeof extractCitations>} found
 * @param {import("./types").ToolSet} tools
 * @returns {Promise<Citation[]>}
 */
export function validateCitations(found, tools, signal) { throw new Error("not implemented"); }

/** Pure. Rewrites text so unresolved citations render as "[@key (not found)]" and resolved ones stay as written. */
export function markUnresolved(text, citations) { throw new Error("not implemented"); }
