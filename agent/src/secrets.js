// @ts-check
// agent-src/src/secrets.js (server spec 020 G1, spec 024 G2). Where Second Brain keeps the keys it is given (OpenAlex,
// model services, outside sources): the system's own store, service "second-brain", the key's name as the account.
//   macOS    the login Keychain, through `security`
//   Windows  Credential Manager, through Windows PowerShell (its PasswordVault)
//   Linux    the Secret Service (GNOME Keyring, KWallet), through `secret-tool`
// When the system has none that works (no `secret-tool`, no D-Bus session over SSH, no Keychain for this login):
// <data>/secrets.json, owner-only (0600). Settings hold only a reference and the last four characters
// (settings.js); a value leaves this module only for the code that uses it.
//
// The key always goes to the store on stdin, so it never appears in the process list (`security
// add-generic-password -w <key>` would show it to `ps`): `security -i` reads its whole command there, secret-tool
// reads the secret there, and the PowerShell script (passed encoded, with only the key's name in it) reads it there.

const SERVICE = 'second-brain';
const FILE = 'secrets.json';

/** A PowerShell script for one Credential Manager call, as -EncodedCommand wants it (UTF-16LE, base64). Names are
 *  checked against NAME first, so one cannot break out of the quotes. Exit 44 = no such key (as `security`), 3 = no
 *  Credential Manager to use. @param {"set" | "get" | "remove"} op @param {string} name */
function credentialScript(op, name) {
  const script = `$ErrorActionPreference = 'Stop'
$op = '${op}'
$name = '${name}'
try {
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
} catch { [Console]::Error.WriteLine("no credential manager: $_"); exit 3 }
function Find { try { $vault.Retrieve('${SERVICE}', $name) } catch { $null } }
$found = Find
if ($op -eq 'set') {
  $value = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
  if ($found) { $vault.Remove($found) }
  $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', $name, $value)))
} elseif (-not $found) { exit 44 }
elseif ($op -eq 'get') { $found.RetrievePassword(); [Console]::Out.Write($found.Password) }
else { $vault.Remove($found) }
`;
  const utf16 = [...script].map((c) => String.fromCharCode(c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8)).join('');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', btoa(utf16)];
}

/** @typedef {{ args: string[], input?: string }} StoreCall */
/** @typedef {{ kind: string, label: string, commands: string[], set(name: string, value: string): StoreCall,
 *    get(name: string): StoreCall, remove(name: string): StoreCall, notFound(code: number): boolean, unusable: RegExp }} SystemStore */

/** @type {Record<string, SystemStore>} */
const STORES = {
  darwin: {
    kind: 'keychain', label: 'the Keychain', commands: ['/usr/bin/security'],
    set: (name, value) => ({ args: ['-i'], input: `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value}"` }),
    get: (name) => ({ args: ['find-generic-password', '-s', SERVICE, '-a', name, '-w'] }),
    remove: (name) => ({ args: ['delete-generic-password', '-s', SERVICE, '-a', name] }),
    notFound: (code) => code === 44,  // security's exit code for "no such item"
    // What `security` says when there is no Keychain it may use
    unusable: /keychain cannot be found|no default keychain|user interaction is not allowed|authorization was canceled|could not be found in the keychain/i,
  },
  linux: {
    kind: 'secret-service', label: 'the Secret Service', commands: ['secret-tool'],
    set: (name, value) => ({ args: ['store', `--label=Veritas: ${name}`, 'service', SERVICE, 'account', name], input: value }),
    get: (name) => ({ args: ['lookup', 'service', SERVICE, 'account', name] }),
    remove: (name) => ({ args: ['clear', 'service', SERVICE, 'account', name] }),
    notFound: () => true,  // `clear` of a key that is not there is not an error
    // No session bus (SSH, a server), no keyring daemon, or the unlock prompt dismissed
    unusable: /d-bus|dbus|org\.freedesktop\.secrets|secret service|not provided by any|no such secret collection|prompt dismissed|was not provided/i,
  },
  win32: {
    kind: 'credential-manager', label: 'Windows Credential Manager', commands: ['powershell.exe'],
    set: (name, value) => ({ args: credentialScript('set', name), input: value }),
    get: (name) => ({ args: credentialScript('get', name) }),
    remove: (name) => ({ args: credentialScript('remove', name) }),
    notFound: (code) => code === 44,
    unusable: /no credential manager/i,
  },
};

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
 * @param {{ keychain?: boolean }} [opts] `keychain: false` forces the file (tests, or a system store not to be used)
 */
export function createSecretStore(platform, dataDir, opts = {}) {
  /** @type {Map<string, string | null>} */
  const cache = new Map();
  const system = STORES[platform.os ?? 'darwin'];  // a platform that does not say is the Mac this began on
  /** @type {Promise<string | null> | null} the store's command, or null: the file */
  let found = null;
  const command = () => (found ??= opts.keychain === false || !system || typeof platform.which !== 'function' ? Promise.resolve(null)
    : platform.which(system.commands).catch(() => null));
  const keychain = async () => Boolean(await command());

  /** @param {StoreCall} call */
  async function run({ args, input }) {
    const cmd = /** @type {string} */ (await command());
    const child = await platform.spawn({ cmd, args, env: {}, cwd: platform.homeDir || '/' });
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
    async kind() { return (await keychain()) ? system.kind : 'file'; },

    /** @param {string} name @param {string} value */
    async set(name, value) {
      checkName(name);
      if (!VALUE.test(value)) throw new SecretError('That key has characters Second Brain cannot store safely (quotes, backslashes or line breaks). Copy it again from the site.');
      if (cache.get(name) === value) return;
      if (await keychain()) {
        const { code, err } = await run(system.set(name, value));
        if (code === 0) { cache.set(name, value); return; }
        // No usable store (no Keychain for this login, no D-Bus session over SSH, no session to ask): the owner-only file.
        if (!system.unusable.test(err)) throw new SecretError(`Couldn't save the key in ${system.label} (${err.trim() || `exit ${code}`}).`);
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
        const { code, out } = await run(system.get(name));
        // a key kept in the file because there was no usable store when it was saved
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
        const { code, err } = await run(system.remove(name));
        if (code !== 0 && !system.notFound(code) && !system.unusable.test(err)) throw new SecretError(`Couldn't remove the key from ${system.label} (${err.trim() || `exit ${code}`}).`);
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
