"""Entry point of the frozen server (PyInstaller, spec 024 G3): the same as `python kb.py ...`.

The server starts its indexing run as `<python> kb.py index` (http_api.start_indexing). Frozen, sys.executable is
this binary, so it receives the script path as its first argument; dropping it gives kb.py the arguments it expects.
"""
import os
import sys

if len(sys.argv) > 1 and os.path.basename(sys.argv[1]) == "kb.py":
    del sys.argv[1]

import listen_first  # noqa: E402

listen_first.if_serving(sys.argv)  # `serve`: the port opens before kb's imports, as at the top of kb.py run as a script

import kb  # noqa: E402  (after the argv fix, since kb parses arguments only in main())

kb.main()  # reads the folder list (kb.ensure_layout) before any command, as kb no longer does at import
