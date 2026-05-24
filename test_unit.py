"""Local tests for the phoneinfoga Apify wrapper.

Run:  python3 test_unit.py
Covers:
  * normalize_number — accepts dirty inputs, returns E.164.
  * build_command    — disabled scanners passed correctly.
  * parse_output     — text parser handles a real phoneinfoga local-only run.
  * integration      — invokes phoneinfoga against a sample number end-to-end.

We mock the `apify` module so main.py is importable without the SDK installed.
"""

import os
import subprocess
import sys
import types

_apify_stub = types.ModuleType("apify")


class _DummyActor:
    class log:
        @staticmethod
        def info(*a, **k): pass
        @staticmethod
        def warning(*a, **k): pass
        @staticmethod
        def error(*a, **k): pass
        @staticmethod
        def exception(*a, **k): pass


_apify_stub.Actor = _DummyActor
sys.modules["apify"] = _apify_stub

# Make src package importable
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from src.main import normalize_number, build_command, parse_output, run_phoneinfoga  # noqa: E402


def test_normalize_number():
    cases = [
        ("+14155552671", "+14155552671"),
        ("14155552671", "+14155552671"),
        ("+1 (415) 555-2671", "+14155552671"),
        ("+91 98765 43210", "+919876543210"),
        ("  +44 20 7946 0958  ", "+442079460958"),
    ]
    for raw, expected in cases:
        got = normalize_number(raw)
        assert got == expected, f"normalize_number({raw!r}) = {got!r}, expected {expected!r}"
    print("  normalize_number: OK")


def test_build_command():
    cmd = build_command("+14155552671", [])
    assert cmd == ["phoneinfoga", "scan", "-n", "+14155552671"], cmd
    cmd = build_command("+14155552671", ["googlesearch", "numverify"])
    assert cmd == ["phoneinfoga", "scan", "-n", "+14155552671", "-D", "googlesearch", "-D", "numverify"], cmd
    cmd = build_command("+14155552671", ["nonsense", "ovh"])
    assert "-D" in cmd and "ovh" in cmd and "nonsense" not in cmd, cmd
    print("  build_command: OK")


SAMPLE_OUTPUT = """\
Running scan for phone number +14155552671...

Results for googlesearch
Social media:
\tURL: https://www.google.com/search?q=site%3Afacebook.com+intext%3A%2214155552671%22
\tURL: https://www.google.com/search?q=site%3Atwitter.com+intext%3A%2214155552671%22

Disposable providers:
\tURL: https://www.google.com/search?q=site%3Ahs3x.com+intext%3A%2214155552671%22

Results for local
Raw local: 4155552671
Local: (415) 555-2671
E164: +14155552671
International: 14155552671
Country: US

2 scanner(s) succeeded
"""


def test_parse_output():
    rec = parse_output(SAMPLE_OUTPUT, "+14155552671")
    assert rec["target"] == "+14155552671"
    assert rec["country"] == "US"
    assert rec["e164"] == "+14155552671"
    assert rec["local_format"] == "(415) 555-2671"
    assert rec["raw_local"] == "4155552671"
    assert rec["international"] == "14155552671"
    assert rec["scanners_succeeded"] == 2
    assert rec["googlesearch_url_count"] == 3
    assert "Social media" in rec["googlesearch"]
    assert len(rec["googlesearch"]["Social media"]) == 2
    assert "Disposable providers" in rec["googlesearch"]
    print("  parse_output: OK")


def test_integration():
    """Real phoneinfoga invocation — skipped if binary missing."""
    try:
        subprocess.run(["phoneinfoga", "version"], capture_output=True, check=True, timeout=5)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        print("  integration: SKIPPED (phoneinfoga not installed)")
        return

    output, rc = run_phoneinfoga(
        "+14155552671",
        disable=["googlesearch", "ovh", "numverify", "googlecse"],
        env=os.environ.copy(),
        timeout=30,
    )
    rec = parse_output(output, "+14155552671")
    assert rec["country"] == "US", f"expected country=US, got {rec['country']!r}\noutput:\n{output}"
    assert rec["e164"] == "+14155552671", f"expected e164=+14155552671, got {rec['e164']!r}"
    assert rec["scanners_succeeded"] >= 1, f"expected at least 1 scanner ok, got {rec['scanners_succeeded']}"
    print(f"  integration: OK (country={rec['country']}, scanners_succeeded={rec['scanners_succeeded']})")


if __name__ == "__main__":
    print("Running phoneinfoga wrapper tests...")
    test_normalize_number()
    test_build_command()
    test_parse_output()
    test_integration()
    print("All tests passed.")
