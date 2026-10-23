"""KernelService-compatible facade for a workspace's SSH Python worker."""

from .ssh_backend import SSHExecutionBackend


class RemoteKernel:
    def __init__(self, settings, workspace):
        self.backend = SSHExecutionBackend(workspace, settings=settings)
        self.running = False

    async def start(self):
        await self.backend.start()
        self.running = True

    async def stop(self):
        await self.backend.close()
        self.running = False

    async def restart(self):
        await self.stop()
        await self.start()

    async def interrupt(self):
        await self.backend.interrupt()

    async def execute(self, code, timeout_s=None):
        return await self.backend.execute_python(code, timeout_s=timeout_s)

    async def list_vars(self):
        return await self.backend.list_vars()

    async def var_detail(self, name):
        return await self.backend.var_detail(name)

    def status(self):
        return {"running": self.running, "backend": "ssh", "cwd": self.backend.cwd,
                "python": self.backend._python or None,
                "workspace_id": self.backend.workspace.workspace_id}
