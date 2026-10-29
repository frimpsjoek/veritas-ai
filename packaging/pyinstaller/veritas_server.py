"""Entry point of the frozen server (PyInstaller, spec 024 G3): the same as `python kb.py ...`.

The server starts its indexing run as `<python> kb.py index` (http_api.start_indexing). Frozen, sys.executable is
this binary, so it receives the script path as its first argument; dropping it gives kb.py the arguments it expects.
"""
import os
import sys

if len(sys.argv) > 1 and os.path.basename(sys.argv[1]) == "kb.py":
    del sys.argv[1]

import kb  # noqa: E402  (after the argv fix, since kb parses arguments only in main())

kb.main()
