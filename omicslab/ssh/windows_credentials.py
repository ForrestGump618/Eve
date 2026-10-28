"""Windows Credential Manager backend. No optional pip dependency or secret files."""
import ctypes
from ctypes import wintypes


class WindowsCredentials:
    def __init__(self):
        class Credential(ctypes.Structure):
            _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                        ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                        ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]
        self.Credential = Credential
        self.api = ctypes.WinDLL("Advapi32", use_last_error=True)
        self.api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
        self.api.CredWriteW.restype = wintypes.BOOL
        self.api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
        self.api.CredReadW.restype = wintypes.BOOL
        self.api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        self.api.CredDeleteW.restype = wintypes.BOOL
        self.api.CredFree.argtypes = [ctypes.c_void_p]
        self.api.CredFree.restype = None

    def set_password(self, service, name, value):
        raw = value.encode("utf-8")
        if len(raw) > 5120:
            raise ValueError("凭据超过系统容量")
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        record = self.Credential(Type=1, TargetName=f"{service}:{name}", UserName=name,
                                 CredentialBlobSize=len(raw), CredentialBlob=buffer, Persist=2)
        try:
            if not self.api.CredWriteW(ctypes.byref(record), 0):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            ctypes.memset(buffer, 0, len(raw))

    def get_password(self, service, name):
        pointer = ctypes.POINTER(self.Credential)()
        if not self.api.CredReadW(f"{service}:{name}", 1, 0, ctypes.byref(pointer)):
            code = ctypes.get_last_error()
            if code == 1168:
                return None
            raise ctypes.WinError(code)
        try:
            record = pointer.contents
            return ctypes.string_at(record.CredentialBlob, record.CredentialBlobSize).decode("utf-8")
        finally:
            self.api.CredFree(pointer)

    def delete_password(self, service, name):
        if not self.api.CredDeleteW(f"{service}:{name}", 1, 0) and ctypes.get_last_error() != 1168:
            raise ctypes.WinError(ctypes.get_last_error())
