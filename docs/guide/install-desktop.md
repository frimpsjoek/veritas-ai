# Install the desktop app

The desktop app is Veritas in a window of its own: download it, open it, and the guided setup takes over. Nothing
else to install: the server, the assistant and the web app are inside.

## Download

From the [latest release](https://github.com/frimpsjoek/veritas-ai/releases/latest):

| System | File |
|---|---|
| macOS, Apple silicon (M1 and later) | `Veritas_<version>_aarch64.dmg` |
| macOS, Intel | `Veritas_<version>_x64.dmg` |
| Windows 10 and 11 | `Veritas_<version>_x64-setup.exe` |
| Linux | `Veritas_<version>_amd64.AppImage`, or `Veritas_<version>_amd64.deb` for Debian and Ubuntu |

The installers are about 90 MB. On its first start the app downloads the search model (133 MB, once) unless it can
reuse one (below).

## Opening an unsigned app

The app is not yet signed with an Apple or Microsoft certificate, so each system warns once before the first start.

**macOS.** Open the `.dmg` and drag Veritas to Applications. The first time, right-click (or Control-click) Veritas in
Applications and choose **Open**, then **Open** again. If macOS only offers **Move to Trash**: open **System Settings >
Privacy & Security**, scroll to "Veritas was blocked", and click **Open Anyway**. Or, in Terminal:

```sh
xattr -d com.apple.quarantine /Applications/Veritas.app
```

**Windows.** Run the setup file. If SmartScreen says "Windows protected your PC", click **More info**, then **Run
anyway**. The app installs for your user only and needs no administrator rights.

**Linux.** Make the AppImage executable and run it:

```sh
chmod +x Veritas_*_amd64.AppImage
./Veritas_*_amd64.AppImage
```

or install the `.deb` with `sudo apt install ./Veritas_*_amd64.deb`.

## First start

1. **An index you already have.** If this computer already has a Veritas index (a Homebrew install, or the Second
   Brain server Veritas grew from), the app says so, with its size: "Found an existing Veritas index (85,297
   passages from 4,036 notes, 22 chats). Use it?" **Use it** copies it (the original is only read, never changed) and
   only notes that changed since are read again. Your chats, radar issues and routines come with it; when that index
   has none, they come from the other index found that has the most. **Start fresh** builds a new index; **Choose a folder…** takes another
   Veritas data folder (the one that holds `kb.sqlite`).
2. **The search model.** Downloaded with a progress bar, unless it came with the index above.
3. **Guided setup.** The web app's Welcome card: your library, your notes, your AI, your papers.

The same import is a command for other installs: `kb.py import-data --find` lists the indexes on this computer,
`kb.py import-data <folder>` copies one into this install's data folder.

## Where things are

| | macOS | Windows | Linux |
|---|---|---|---|
| Data, index and search model | `~/Library/Application Support/io.github.frimpsjoek.veritas` | `%APPDATA%\io.github.frimpsjoek.veritas` | `~/.local/share/io.github.frimpsjoek.veritas` |
| Server log | `<data>/logs/server.log` | same | same |

The app runs the server at `http://127.0.0.1:27182` (another port if a Homebrew or source install already uses
27182), so the Zotero and Obsidian plugins find it as usual.

## Menu bar and tray

Closing the window keeps Veritas running in the menu bar (macOS) or tray (Windows, Linux), so the plugins and your
phone keep working. The icon's menu has **Open Veritas**, **Start at login** and **Quit Veritas**; Quit stops the
server and the assistant.

## Updates

The app checks the latest release each time it starts and asks before installing ("Install and restart" or
"Later"). Your library and settings stay where they are. Updates are checked with the release's signature, so only
builds from this project are installed.

## Remove

Quit Veritas from its menu, then delete the app (macOS: drag it from Applications to the Trash; Windows: **Settings >
Apps**; Linux: delete the AppImage or `sudo apt remove veritas`). Delete the data folder above to remove the index
and settings too.
