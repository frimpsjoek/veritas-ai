# Getting started

## What you need

- macOS (Apple silicon or Intel)
- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- Node 22
- About 1 GB of disk for the search model and the index
- For chat: a Claude or ChatGPT (Codex) sign-in on this computer, or a local model

## Install

```sh
git clone https://github.com/frimpsjoek/veritas-ai.git && cd veritas-ai

# server and its search model (133 MB, from Hugging Face)
(cd server && uv venv && uv pip install --python .venv/bin/python -r requirements.txt)
M=server/models/snowflake-arctic-embed-s && mkdir -p $M/onnx
for f in onnx/model.onnx tokenizer.json config.json; do
  curl -fL -o $M/$f https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/$f
done

# assistant and web app
(cd agent && npm ci && npm run build)
(cd web && npm ci && ./install.sh)

# start
cd server && KB_BACKEND=onnx .venv/bin/python kb.py serve
```

Open <http://localhost:27182/app/>.

## First start

On its first start Veritas:

- creates its output folder, `~/Documents/Veritas`, where it writes notes, digests and chat copies as Markdown;
- finds a Zotero library in `~/Zotero` by itself and starts indexing it;
- shows the progress of indexing in the app.

## Settings to fill in

Home shows a **Welcome to Veritas** card with five steps (your library, your notes, your AI, your papers,
Valency Bond). Each step opens the screen that does it and ticks itself once done; the card goes away when all are
done, or with **Hide this card**. The same screens are under **More > Settings**:

1. **Folders:** add your Obsidian vault and any folder of notes and PDFs. Each folder can be switched off or
   removed later.
2. **Models:** choose the AI that answers: Claude, Codex (ChatGPT), or a local model.
3. **Reading radar:** find your own papers by name or ORCID and pick topics, authors, journals and feeds
   (see [Reading radar](reading-radar.md)).
4. **Sources and tools:** connect literature tools such as Valency Bond (see [Connectors and MCP](connectors.md)).
5. **Server and phone:** a QR code that opens Veritas on your phone, signed in, over your Tailscale network.

## The `veritas` command

`bin/veritas` starts and checks the server; add the `bin/` folder to your PATH, or call it with its path.

```sh
veritas serve          # start (downloads the search model the first time)
veritas open           # open the web app
veritas status         # running? how much is indexed
```

`VERITAS_DATA=/some/folder` keeps the index, settings and search model in that folder instead of `server/data` and
`server/models`, so replacing the code (an upgrade) never touches them. Set it for `web/install.sh` too.

## Keep it running

`kb.py serve` stops when you close the terminal. To start Veritas at login and restart it if it stops, run it as a
macOS LaunchAgent (`launchctl`), pointing at `server/.venv/bin/python server/kb.py serve`.
