"""Real local PTY acceptance. Runs an installed shell, never a simulated shell."""
import os
import threading
import time

import pytest
from omicslab.server.terminal_process import ShellProcess


@pytest.mark.skipif(os.name != "nt", reason="PowerShell ConPTY acceptance is Windows-specific")
def test_powershell_persistent_state_resize_unicode_and_interrupt(tmp_path):
    shell = ShellProcess(str(tmp_path), 120, 30)
    chunks = []
    def read():
        try:
            while True:
                text = shell.read()
                if not text:
                    break
                chunks.append(text)
                # A headless PTY reader must answer PSReadLine's cursor query;
                # the real UI's xterm does this as part of its VT protocol.
                if "\x1b[6n" in text:
                    shell.write("\x1b[1;1R")
        except (EOFError, OSError):
            pass
    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    def wait(marker):
        deadline = time.monotonic()+12
        while time.monotonic() < deadline:
            if marker in "".join(chunks):
                return
            time.sleep(.05)
        pytest.fail(f"PTY output marker missing: {marker}; output={''.join(chunks)[-3000:]!r}")
    try:
        shell.write("$eveValue = 137; Write-Output ('VALUE_' + $eveValue)\r")
        wait("VALUE_137")
        shell.write("Write-Output ('STATE_' + ($eveValue + 1)); [Console]::WriteLine([char]0x7814 + [string][char]0x7a76)\r")
        wait("STATE_138")
        wait("研究")
        shell.resize(100, 24)
        shell.write("Write-Output ('SLEEP_' + 'STARTED'); Start-Sleep -Seconds 20; Write-Output ('LONG_' + 'DONE')\r")
        wait("SLEEP_STARTED")
        shell.write("\x03")
        time.sleep(.5)
        shell.write("Write-Output ('CTRL_' + 'RECOVERED')\r")
        wait("CTRL_RECOVERED")
        assert "LONG_DONE" not in "".join(chunks)
    finally:
        shell.close()
        thread.join(3)
    assert not thread.is_alive()
