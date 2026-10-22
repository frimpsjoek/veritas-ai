// The Gecko globals gecko/shims.js reads directly, declared with only the members it uses, so the file is type
// checked instead of excluded. gecko/platform.js receives every other Gecko global through its `deps` argument.
// Inside Zotero these are real; nothing outside gecko/ refers to them.

declare const Services: {
  env: { exists(name: string): boolean; get(name: string): string };
  appShell: { hiddenDOMWindow: Window & typeof globalThis };
};

declare const Zotero: {
  debug(message: string): void;
  getMainWindow(): (Window & typeof globalThis) | null;
};
