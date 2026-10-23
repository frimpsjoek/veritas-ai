# Homebrew formula for Veritas AI (spec 024 G1). Published in the tap frimpsjoek/homebrew-veritas as Formula/veritas.rb;
# `url` and `sha256` are set for each release tag of veritas-ai.
class Veritas < Formula
  desc "Open-source research assistant you can check: your papers, notes and new literature, with citations"
  homepage "https://github.com/frimpsjoek/veritas-ai"
  url "https://github.com/frimpsjoek/veritas-ai/archive/refs/tags/v0.54.0.tar.gz"
  sha256 "b4d5518eadf14df52c3a06cf3f6f98ec1e9a73f6f8c37b1e109dcfeffac30ebe"
  license "MIT"
  revision 2

  depends_on "node@22" => :build
  depends_on "node@22"
  depends_on "python@3.12"
  depends_on "uv"

  def install
    libexec.install Dir["*"]
    ENV.prepend_path "PATH", Formula["node@22"].opt_bin
    cd(libexec/"agent") { system "npm", "ci"; system "npm", "run", "build" }
    cd(libexec/"web") { system "npm", "ci"; system "npm", "run", "build" }
    (bin/"veritas").write_env_script libexec/"bin/veritas",
      VERITAS_DATA:      var/"veritas",
      VERITAS_PYTHON:    var/"veritas/venv/bin/python",
      SECOND_BRAIN_NODE: Formula["node@22"].opt_bin/"node",
      PATH:              "#{Formula["node@22"].opt_bin}:$PATH"
  end

  def post_install
    (var/"veritas").mkpath
    # The Python environment lives beside the data, not in the keg: Homebrew rewrites the libraries of files in a keg,
    # which fails for prebuilt wheels (tantivy); here it is also kept across upgrades and rebuilt when they change.
    venv = var/"veritas/venv"
    ENV["UV_CACHE_DIR"] = (var/"veritas/.uv-cache").to_s  # the sandbox allows no writes to ~/.cache
    ENV["UV_PYTHON_DOWNLOADS"] = "never"
    system Formula["uv"].opt_bin/"uv", "venv", "--allow-existing", "--python", Formula["python@3.12"].opt_bin/"python3.12", venv
    system Formula["uv"].opt_bin/"uv", "pip", "install", "--python", venv/"bin/python", "-r", libexec/"server/requirements.txt"
    # the web app goes into the data folder, so an upgrade does not wipe it either
    system "env", "VERITAS_DATA=#{var}/veritas", "PATH=#{Formula["node@22"].opt_bin}:#{ENV["PATH"]}",
           "sh", libexec/"web/install.sh"
  end

  service do
    run [opt_bin/"veritas", "serve"]
    keep_alive true
    log_path var/"log/veritas.log"
    error_log_path var/"log/veritas.log"
  end

  def caveats
    <<~EOS
      Start Veritas now and at login:  brew services start veritas
      Open it:                         veritas open   (http://localhost:27182/app/)
      Your data and the search model live in #{var}/veritas.
    EOS
  end

  test do
    assert_match "veritas serve", shell_output("#{bin}/veritas 2>&1", 2)
  end
end
