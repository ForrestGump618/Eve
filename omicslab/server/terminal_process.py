"""Platform PTY adapter. No command interpretation or workspace fallback."""
from __future__ import annotations

import codecs
import os
import shutil
import subprocess


class ShellProcess:
    def __init__(self, cwd: str, cols: int = 100, rows: int = 30):
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        if os.name == "nt":
            from winpty import PtyProcess

            executable = shutil.which("pwsh.exe") or shutil.which("powershell.exe")
            if not executable:
                raise RuntimeError("PowerShell 未安装")
            self.label = "PowerShell"
            startup = (
                "try {[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)} catch {}; "
                "try {[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)} catch {}; "
                "$OutputEncoding=[Console]::OutputEncoding"
            )
            self.process = PtyProcess.spawn(
                [executable, "-NoLogo", "-NoProfile", "-NoExit", "-Command", startup],
                cwd=cwd, env=env, dimensions=(rows, cols),
            )
            self.pid = self.process.pid
        else:
            import pty
            master, slave = pty.openpty()
            self.master = master
            executable = env.get("SHELL") or "/bin/bash"
            self.label = os.path.basename(executable)
            try:
                self.process = subprocess.Popen(
                    [executable, "-i"], stdin=slave, stdout=slave, stderr=slave,
                    cwd=cwd, env=env, start_new_session=True,
                )
            finally:
                os.close(slave)
            self.pid = self.process.pid
            self.resize(cols, rows)

    def read(self) -> str:
        if os.name == "nt":
            return self.process.read(16384)
        try:
            return self.decoder.decode(os.read(self.master, 16384))
        except OSError:
            return ""

    def write(self, data: str) -> None:
        if os.name == "nt":
            self.process.write(data)
        else:
            os.write(self.master, data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        if os.name == "nt":
            self.process.setwinsize(rows, cols)
        else:
            import fcntl
            import struct
            import termios
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self) -> None:
        if os.name == "nt":
            if self.process.isalive():
                subprocess.run(
                    ["taskkill", "/PID", str(self.pid), "/T", "/F"],
                    capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW,
                )
            self.process.close(force=True)
        else:
            import signal
            if self.process.poll() is None:
                os.killpg(self.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
            os.close(self.master)
