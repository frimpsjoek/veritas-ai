// @ts-check
// ui-src/src/settings/settings-widgets.js (spec 016 U2). The rows of Settings that are more than one control and
// work the same in every app: the OpenAlex key and the outside-sources (MCP) list. Each takes (doc, host) and
// returns the element the view puts in the row. The app-specific ones (phone QR, search index status, Zotero
// colours) are passed in by each host.
import { h } from '../dom.js';
import { openAlexKeyRow } from '../chat/openalex-key.js';
import { MCP_CATALOG, catalogEntry } from '../../../agent/src/catalog.js';
import { connectGuide, customServerForm, keyLine } from './connect-guide.js';
import { logoFor, logoSvg, iconFor } from '../logos.js';

/** @param {Document} doc @param {any} host */
export function openalexKeyWidget(doc, host) { return openAlexKeyRow(doc, host); }

/** @param {Document} doc @param {string} text @param {() => void | Promise<void>} onClick */
function button(doc, text, onClick) {
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', text));
  b.type = 'button';
  b.addEventListener('click', () => void onClick());
  return b;
}

/** A source's name with its logo in front: bundled, else (web app) the site's icon, else its initials (logos.js).
 *  @param {Document} doc @param {string} name @param {string} [known] the catalog's name for it @param {boolean} [web] */
function named(doc, name, known, web = false) {
  const label = h(doc, 'span', 'sbs-label sbs-named');
  const logo = logoFor(known ?? name) ?? logoFor(name);
  label.append(logo ? logoSvg(doc, logo, 16) : iconFor(doc, { label: known ?? name }, { size: 16, web }));
  label.append(name);
  return label;
}

/** @param {string} verdict */
const verdictReason = (verdict) => verdict === 'hidden_writes' ? 'hidden: can change things'
  : verdict === 'hidden_unmarked' ? "hidden: doesn't say whether it changes things" : 'usable';

/** Outside sources: what is added (state, trust, tools, Test, Remove) and the catalog to add from.
 *  @param {Document} doc @param {any} host */
export function mcpWidget(doc, host) {
  const root = h(doc, 'div', 'sbs-mcp');
  const list = h(doc, 'div', 'sbs-mcp-list');
  const catalog = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbs-mcp-catalog'));
  catalog.append(h(doc, 'summary', '', 'Add from the catalog'));
  const own = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbs-mcp-catalog sbs-mcp-own'));
  own.append(h(doc, 'summary', '', 'Add your own'));
  root.append(list, catalog, own);

  const say = (/** @type {unknown} */ error) => host.notice?.(String(/** @type {any} */ (error)?.message ?? error));
  const refresh = async () => {
    list.replaceChildren();
    let reports;
    try { reports = await (await host.ai()).mcp.list(); } catch (error) {
      host.logError?.(error);
      list.append(h(doc, 'p', 'sbs-help', "Couldn't reach the Veritas server."));
      return;
    }
    if (!reports.length) { list.append(h(doc, 'p', 'sbs-help', 'No outside sources added yet.')); return; }
    for (const report of reports) {
      const usable = report.tools.filter((/** @type {any} */ t) => t.verdict === 'exposed').length;
      const state = report.state === 'connected' ? `Connected · ${usable} usable tool${usable === 1 ? '' : 's'}`
        : report.state === 'failed' ? (report.error || "Couldn't connect") : 'Disabled';
      const item = h(doc, 'div', 'sbs-mcp-item');
      const head = h(doc, 'div', 'sbs-mcp-head');
      const text = h(doc, 'div', 'sbs-mcp-text');
      text.append(named(doc, report.config.name, catalogEntry(report.config.name)?.name, host.kind === 'web'), h(doc, 'span', `sbs-help${report.state === 'failed' ? ' is-bad' : ''}`, state));
      const trust = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbs-mcp-trust'));
      const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
      box.type = 'checkbox';
      box.checked = Boolean(report.config.trustUnmarked);
      box.addEventListener('change', async () => {
        try { await (await host.ai()).mcp.save({ ...report.config, trustUnmarked: box.checked }); } catch (e) { say(e); }
        await refresh();
      });
      trust.append(box, h(doc, 'span', '', 'Trust it'));
      head.append(text, trust,
        button(doc, 'Test', async () => { try { await (await host.ai()).mcp.save(report.config); } catch (e) { say(e); } await refresh(); }),
        button(doc, 'Remove', async () => { try { await (await host.ai()).mcp.remove(report.config.name); } catch (e) { say(e); } await refresh(); }));
      item.append(head);
      // A source with a key: say it is saved (never the key itself) and offer to replace it (spec 020 G2).
      const entry = catalogEntry(report.config.name);
      const keyFields = (entry?.setup?.fields ?? []).filter((f) => f.kind === 'key');
      if (entry && keyFields.length) {
        const bag = (/** @type {any} */ f) => (f.in === 'env' ? /** @type {any} */ (report.config).env : /** @type {any} */ (report.config).headers)?.[f.name];
        const saved = keyFields.map((f) => keyLine(bag(f))).find(Boolean) ?? 'No key saved';
        const keyRow = h(doc, 'div', 'sbs-mcp-keyline');
        const guideBox = h(doc, 'div', '');
        keyRow.append(h(doc, 'span', 'sbs-help', saved), button(doc, saved.startsWith('Key saved') ? 'Replace key' : 'Add key', () => {
          guideBox.replaceChildren(connectGuide(doc, host, entry, { existing: report.config, onDone: refresh, onCancel: () => guideBox.replaceChildren() }));
        }));
        item.append(keyRow, guideBox);
      }
      if (report.tools.length) {
        const tools = h(doc, 'ul', 'sbs-mcp-tools');
        for (const tool of report.tools) tools.append(h(doc, 'li', tool.verdict === 'exposed' ? '' : 'is-hidden', `${tool.name} — ${verdictReason(tool.verdict)}`));
        item.append(tools);
      }
      list.append(item);
    }
  };
  for (const entry of MCP_CATALOG) {
    const line = h(doc, 'div', 'sbs-mcp-entry');
    const text = h(doc, 'div', 'sbs-mcp-text');
    text.append(named(doc, entry.name, entry.id, host.kind === 'web'), h(doc, 'span', 'sbs-help', entry.note ? `${entry.description} (${entry.note})` : entry.description));
    // Something to type (a key, an email): the Connect guide. Nothing to type: one click, as before.
    if (entry.setup?.fields.length) {
      const guideBox = h(doc, 'div', 'sbs-mcp-guidebox');
      const connect = button(doc, 'Connect', () => {
        guideBox.replaceChildren(connectGuide(doc, host, entry, { onDone: refresh, onCancel: () => guideBox.replaceChildren() }));
      });
      line.append(text, connect);
      catalog.append(line, guideBox);
      continue;
    }
    const add = button(doc, 'Add', async () => {
      add.disabled = true; add.textContent = 'Adding…';
      try { await (await host.ai()).mcp.save(entry.config); await refresh(); } catch (e) { say(`Couldn't add ${entry.name}: ${/** @type {any} */ (e)?.message ?? e}`); }
      add.disabled = false; add.textContent = 'Add';
    });
    line.append(text, add);
    catalog.append(line);
  }
  own.append(customServerForm(doc, host, { onDone: refresh }));
  void refresh();
  return root;
}
