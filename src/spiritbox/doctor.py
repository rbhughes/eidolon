"""Environment checks: confirm the RTL-SDR CLI tools and dongle are usable
before the app builds on top of them.

Note: we shell out to the rtl_fm/rtl_sdr binaries rather than using the
pyrtlsdr ctypes bindings. The installed driver is the RTL-SDR Blog fork
(needed for V4 hardware support), which doesn't export every symbol
pyrtlsdr expects (e.g. rtlsdr_set_dithering), so pyrtlsdr fails at import
time. The CLI tools talk to the same driver and work fine.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

REQUIRED_BINARIES = ["rtl_test", "rtl_sdr", "rtl_fm"]


def check_binaries() -> tuple[bool, str]:
    missing = [b for b in REQUIRED_BINARIES if shutil.which(b) is None]
    if missing:
        return False, f"missing binaries: {', '.join(missing)}"
    return True, f"found: {', '.join(REQUIRED_BINARIES)}"


def check_device() -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["rtl_test", "-t"],
            capture_output=True,
            text=True,
            timeout=8,
        )
    except subprocess.TimeoutExpired:
        return False, "rtl_test timed out"
    except FileNotFoundError:
        return False, "rtl_test not found"

    output = result.stdout + result.stderr
    if "Found 1 device" in output or "Found " in output and "device(s)" in output:
        return True, output.strip().splitlines()[0]
    return False, f"device not detected: {output.strip()}"


def check_capture() -> tuple[bool, str]:
    """Run rtl_fm briefly and confirm it actually produces audio bytes."""
    try:
        proc = subprocess.run(
            ["rtl_fm", "-f", "100.0M", "-M", "fm", "-s", "200k", "-r", "48k", "-"],
            capture_output=True,
            timeout=3,
        )
    except subprocess.TimeoutExpired as exc:
        # rtl_fm doesn't exit on its own; timeout is the expected path.
        data = exc.stdout or b""
        if len(data) > 0:
            return True, f"captured {len(data)} bytes before timeout"
        return False, "no data captured before timeout"
    except FileNotFoundError:
        return False, "rtl_fm not found"

    data = proc.stdout or b""
    if len(data) > 0:
        return True, f"captured {len(data)} bytes"
    return False, f"no data captured; stderr: {proc.stderr.decode(errors='replace').strip()}"


def main() -> None:
    checks = [
        ("binaries", check_binaries),
        ("device", check_device),
        ("capture", check_capture),
    ]
    all_ok = True
    for name, fn in checks:
        ok, detail = fn()
        all_ok &= ok
        status = "OK" if ok else "FAIL"
        print(f"[{name}] {status}: {detail}")

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
