"""OS-encrypted credentials; no plaintext fallback on unsupported systems."""
import base64
import ctypes
import os
import threading


class Vault:
    def __init__(self,store):
        self.store=store
        self.temporary={}
        self.lock=threading.RLock()

    @staticmethod
    def _crypt(raw, decrypt=False):
        if os.name!='nt':
            raise ValueError('此平台未配置系统凭据库，只支持临时会话凭据')
        from ctypes import wintypes
        class Blob(ctypes.Structure):
            _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
        buffer=ctypes.create_string_buffer(raw)
        source=Blob(len(raw),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)))
        output=Blob()
        function=ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
        if not function(ctypes.byref(source),None,None,None,None,1,ctypes.byref(output)):
            raise ValueError('系统凭据加解密失败')
        try:
            return ctypes.string_at(output.data,output.size)
        finally:
            ctypes.windll.kernel32.LocalFree(output.data)

    def put(self,id,value,persist=True):
        if not isinstance(value,str) or not value:
            raise ValueError('凭据不能为空')
        with self.lock:
            if persist:
                ciphertext=base64.b64encode(self._crypt(value.encode())).decode()
                self.store.put('vault',id,{'ciphertext':ciphertext,'provider':'windows-dpapi'})
            self.temporary[id]=value
        return {'credential_ref':id,'stored':persist,'provider':'windows-dpapi' if persist else 'session'}

    def get(self,id):
        if not id:
            return ''
        with self.lock:
            if id in self.temporary:
                return self.temporary[id]
            row=self.store.get('vault',id)
            return self._crypt(base64.b64decode(row['ciphertext']),True).decode() if row else ''
