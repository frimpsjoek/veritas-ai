// @ts-check
// agent-src/src/secrets.js (server spec 020 G1). Where Second Brain keeps the keys it is given (OpenAlex,
// model services, outside sources): the macOS login Keychain, service "second-brain", the key's name as the account.
// Off a Mac, <data>/secrets.json, owner-only (0600). Settings hold only a reference and the last four characters
// (settings.js); a value leaves this module only for the code that uses it.
//
// Writes go through `security -i`, which reads its command from stdin, so the key never appears in the process
// list (`security add-generic-password -w <key>` would show it to `ps`).

const SERVICE = 'second-brain';
const SECURITY = '/usr/bin/security';
const FILE = 'secrets.json';
const NOT_FOUND = 44;  // security's exit code for "no such item"
/** What `security` says when there is no Keychain it may use; the key then goes to the owner-only file. */
const NO_KEYCHAIN = /keychain cannot be found|no default keychain|user interaction is not allowed|authorization was canceled|could not be found in the keychain/i;

/** A name is one short token: what kind of key and whose ("openalex", "endpoint:lm-studio", "mcp:nasa-ads:env:ADS_API_KEY"). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** Real API keys are printable ASCII without quotes or backslashes; anything else could not be passed safely. */
const VALUE = /^[\x21\x23-\x5b\x5d-\x7e](?:[\x20\x21\x23-\x5b\x5d-\x7e]{0,4094}[\x21\x23-\x5b\x5d-\x7e])?$/;

export class SecretError extends Error {}

/** "a1b2" for display: never more than the last four characters, nothing for a short key. @param {string} value */
export const lastFour = (value) => (value.length >= 12 ? value.slice(-4) : '');

/** @param {string} name */
function checkName(name) {
  if (!NAME.test(name)) throw new SecretError(`not a key name: ${JSON.stringify(name)}`);
  return name;
}

/**
 * @param {import("./platform").Platform} platform
 * @param {string} dataDir
 * @param {{ keychain?: boolean }} [opts] `keychain: false` forces the file (tests, or a Mac without `security`)
 */
export function createSecretStore(platform, dataDir, opts = {}) {
  /** @type {Map<string, string | null>} */
  const cache = new Map();
  /** @type {Promise<boolean> | null} */
  let useKeychain = null;
  const keychain = () => (useKeychain ??= opts.keychain === false || typeof platform.which !== 'function' ? Promise.resolve(false)
    : platform.which([SECURITY]).then((found) => Boolean(found), () => false));

  /** @param {string[]} args @param {string} [input] */
  async function security(args, input) {
    const child = await platform.spawn({ cmd: SECURITY, args, env: {}, cwd: platform.homeDir || '/' });
    /** @type {string[]} */
    const out = [];
    const reading = (async () => { for await (const line of child.lines()) out.push(line); })();
    if (input !== undefined) {
      await child.write(input);
      await child.closeInput?.();
    }
    const code = await child.exited;
    await reading.catch(() => {});
    return { code, out: out.join('\n'), err: child.stderrTail() };
  }

  const filePath = `${dataDir}/${FILE}`;
  async function readFile() {
    const text = await platform.fs.read(filePath);
    try { return text ? /** @type {Record<string, string>} */ (JSON.parse(text)) : {}; } catch { return {}; }
  }
  /** @param {Record<string, string>} all */
  const writeFile = (all) => platform.fs.writeAtomic(filePath, JSON.stringify(all, null, 2), { private: true });

  return {
    async kind() { return (await keychain()) ? 'keychain' : 'file'; },

    /** @param {string} name @param {string} value */
    async set(name, value) {
      checkName(name);
      if (!VALUE.test(value)) throw new SecretError('That key has characters Second Brain cannot store safely (quotes, backslashes or line breaks). Copy it again from the site.');
      if (cache.get(name) === value) return;
      if (await keychain()) {
        const { code, err } = await security(['-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value}"`);
        if (code === 0) { cache.set(name, value); return; }
        // No usable Keychain (none for this login, a locked one over SSH, no session to ask): the owner-only file.
        if (!NO_KEYCHAIN.test(err)) throw new SecretError(`Couldn't save the key in the Keychain (${err.trim() || `exit ${code}`}).`);
        await writeFile({ ...(await readFile()), [name]: value });
      } else {
        await writeFile({ ...(await readFile()), [name]: value });
      }
      cache.set(name, value);
    },

    /** @param {string} name @returns {Promise<string | null>} */
    async get(name) {
      checkName(name);
      if (cache.has(name)) return cache.get(name) ?? null;
      let value = null;
      if (await keychain()) {
        const { code, out } = await security(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
        // a key kept in the file because there was no Keychain when it was saved
        value = code === 0 ? out : (await readFile())[name] ?? null;
      } else {
        value = (await readFile())[name] ?? null;
      }
      cache.set(name, value);
      return value;
    },

    /** @param {string} name */
    async remove(name) {
      checkName(name);
      if (await keychain()) {
        const { code, err } = await security(['delete-generic-password', '-s', SERVICE, '-a', name]);
        if (code !== 0 && code !== NOT_FOUND) throw new SecretError(`Couldn't remove the key from the Keychain (${err.trim() || `exit ${code}`}).`);
        const { [name]: _inFile, ...others } = await readFile();
        if (_inFile !== undefined) await writeFile(others);
      } else {
        const { [name]: _gone, ...rest } = await readFile();
        await writeFile(rest);
      }
      cache.set(name, null);
    },
  };
}

/** @typedef {ReturnType<typeof createSecretStore>} SecretStore */
