"""The server checks HTTPS sites against the system's certificates (truststore), not the certificate folder of the
machine its Python was built on: the release app's server, built on CI, found no certificates on the user's Mac and
every figure, paper text and abstract download failed with CERTIFICATE_VERIFY_FAILED (2026-11-20)."""
import os
import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]

CODE = """
import ssl, sys
sys.path.insert(0, {server!r})
import kb
print(kb.trust_system_certificates(), type(ssl.create_default_context()).__module__)
"""


def test_main_trusts_the_system_certificates():
    out = subprocess.run([sys.executable, "-c", CODE.format(server=str(SERVER))], capture_output=True, text=True,
                         check=True, env={**os.environ, "SSL_CERT_FILE": "/nonexistent",
                                          "SSL_CERT_DIR": "/nonexistent"}).stdout.split()
    assert out[0] == "True"
    assert out[1].startswith("truststore")


def test_main_calls_it_first():
    source = (SERVER / "kb.py").read_text()
    body = source.split("def main() -> None:\n", 1)[1]
    assert body.lstrip().startswith("trust_system_certificates()")
