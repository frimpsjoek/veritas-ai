# Veritas roadmap

Spec: `../2026-10-22-veritas-design.md` (approved 2026-10-22).

The design covers five subsystems. Each phase gets its own plan, written when the phase before it has landed, so
each plan argues from code that exists. Each phase leaves every test green and the tool usable.

| Phase | Delivers | Design goals | Plan |
|---|---|---|---|
| 1. One repo | `veritas` repo as a fresh copy (old repos + running server untouched); parts `server/ agent/ ui/ web/ zotero/ obsidian/ docs/specs/`; enforced import boundaries; one check command + CI. No behaviour change. | 1, 2, 7 | `2026-10-22-phase1-one-repo.md` |
| 2. One knowledge base | Zotero plugin becomes a server client (standalone index + in-Zotero agent removed); connector interface + 5 connectors; several Zotero libraries; output folder setting (`~/Documents/Veritas/` default, or a chosen Obsidian vault); old-path lookup for `[[Note]]` links; chats mirrored as `.md`; default library for "+ Add", Zotero Web API writes. | 4, 5, 8, 9, 10, 11 | later |
| 3. Web app on its own | Front end on Vite (shared by desktop and browser), static build, setup screen (server URL + sign-in, server list), Bearer auth, CORS allow-list, images/PDF via fetch→blob, single-use iframe tickets, QR carrying URL + token, plain-HTTP warning, GitHub Pages deploy (Joseph approves Pages). | 3 | later |
| 3b. Desktop app | `app/`: Tauri shell around the Vite front end; Python server packaged (PyInstaller) and `agentd` as sidecars started/stopped by the app; uses bundled server by default, can connect to another; plugins find the app's local port. | 12 | later |
| 4. First-launch setup | Setup flow in web, Zotero and Obsidian: connect to server, add sources (type detected or picked), pick output folder and default library. | 6 | later |
| 5. Veritas name + cutover | Rename IDs/env vars/Keychain/data folder to Veritas; optional one-time copy script (settings, Keychain keys) into Veritas's own data; old Second Brain keeps running until Joseph decides to retire it; archive old repos only when he says (Joseph approves). | calls list | later |

Gates needing Joseph: creating the GitHub repo and every push (Phase 1 end), enabling Pages (3), running the copy
script and retiring Second Brain (5), archiving old repos (5).
