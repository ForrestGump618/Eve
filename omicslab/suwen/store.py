"""Versioned platform records, checkpoints, audit and usage in SQLite/WAL."""
from __future__ import annotations

import copy
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path


class Conflict(ValueError):
    pass


def uid(prefix='item'):
    return f'{prefix}_{uuid.uuid4().hex[:12]}'


def redact(value):
    if isinstance(value, dict):
        return {k: '[redacted]' if re.search(r'password|api.?key|authorization|secret|access.?token|refresh.?token', k, re.I)
                and not k.endswith('_ref') else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'''(?ix)(\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\b\s*[=:]\s*)(["'])(.*?)\2''', r'\1"[redacted]"', value)
        value = re.sub(r'bot\d+:[A-Za-z0-9_-]+', 'bot[redacted]', value)
        value = re.sub(r'(?i)(bearer\s+)[^\s"\']+', r'\1[redacted]', value)
        return re.sub(r'\bsk-[\w-]{8,}', '[redacted]', value)
    return value


class PlatformStore:
    def __init__(self, home):
        self.home = Path(home)
        self.path = self.home / 'suwen' / 'platform.db'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
          INSERT INTO schema_version SELECT 2 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
          CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, scope TEXT, data TEXT NOT NULL,
            revision INTEGER NOT NULL, updated REAL NOT NULL, PRIMARY KEY(kind,id,scope));
          CREATE TABLE IF NOT EXISTS history(kind TEXT,id TEXT,scope TEXT,data TEXT,revision INTEGER,updated REAL,
            PRIMARY KEY(kind,id,scope,revision));
          CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,kind TEXT,data TEXT,created REAL);
          CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,task TEXT,agent TEXT,
            model TEXT,input INTEGER,output INTEGER,cost REAL,estimated INTEGER,latency REAL,created REAL);
          CREATE TABLE IF NOT EXISTS dedup(channel TEXT,message TEXT,created REAL,PRIMARY KEY(channel,message));
        ''')

    def get(self, kind, id, scope='global'):
        with self.lock:
            row = self.db.execute('SELECT * FROM records WHERE kind=? AND id=? AND scope=?',(kind,id,scope)).fetchone()
        return self._decode(row) if row else None

    @staticmethod
    def _decode(row):
        return dict(json.loads(row['data']), id=row['id'], scope=row['scope'], revision=row['revision'], updated_at=row['updated'])

    def list(self, kind, scope='global', *, limit=None, session_id=None):
        query = 'SELECT * FROM records WHERE kind=? AND scope=?'
        params = [kind, scope]
        if session_id is not None:
            query += " AND json_extract(data,'$.session_id')=?"
            params.append(session_id)
        query += ' ORDER BY updated DESC'
        if limit is not None:
            query += ' LIMIT ?'
            params.append(min(1000, max(1, int(limit))))
        with self.lock:
            rows = self.db.execute(query, params).fetchall()
        return [self._decode(r) for r in rows]

    def put(self, kind, id, data, scope='global', expected=None):
        clean = copy.deepcopy(data)
        for key in ('id','scope','revision','updated_at'):
            clean.pop(key,None)
        encoded=json.dumps(clean,ensure_ascii=False)
        if len(encoded)>4_000_000:
            raise ValueError('单条记录超过 4MB')
        with self.lock, self.db:
            old=self.get(kind,id,scope)
            revision=old['revision'] if old else 0
            if expected is not None and expected != revision:
                raise Conflict('配置已被其他操作修改，请刷新后重试')
            if old:
                self.db.execute('INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?)',
                  (kind,id,scope,json.dumps(redact(old),ensure_ascii=False),revision,old['updated_at']))
            self.db.execute('INSERT OR REPLACE INTO records VALUES(?,?,?,?,?,?)',
                            (kind,id,scope,encoded,revision+1,time.time()))
        return self.get(kind,id,scope)

    def delete(self, kind, id, scope='global'):
        old=self.get(kind,id,scope)
        if old is None:
            raise KeyError(id)
        self.put('trash',uid(),{'kind':kind,'record':old},scope)
        with self.lock,self.db:
            self.db.execute('DELETE FROM records WHERE kind=? AND id=? AND scope=?',(kind,id,scope))
        return {'ok':True,'recoverable':True}

    def history(self,kind,id,scope='global'):
        with self.lock:
            rows=self.db.execute('SELECT * FROM history WHERE kind=? AND id=? AND scope=? ORDER BY revision DESC',(kind,id,scope)).fetchall()
        return [self._decode(r) for r in rows]

    def audit(self,kind,data,scope='global'):
        with self.lock,self.db:
            self.db.execute('INSERT INTO audit(scope,kind,data,created) VALUES(?,?,?,?)',
                (scope,kind,json.dumps(redact(data),ensure_ascii=False,default=str)[:20000],time.time()))

    def logs(self,scope='global',limit=50):
        with self.lock:
            rows=self.db.execute('SELECT * FROM audit WHERE scope=? ORDER BY id DESC LIMIT ?',
                (scope,min(200,max(1,limit)))).fetchall()
        return [dict(r, data=json.loads(r['data'])) for r in rows]

    def backup(self):
        target=self.home/'backups'/f'suwen-{int(time.time())}-{uuid.uuid4().hex[:6]}.db'
        target.parent.mkdir(parents=True,exist_ok=True)
        with self.lock,sqlite3.connect(target) as backup:
            self.db.backup(backup)
        return target

    def close(self):
        with self.lock:
            self.db.close()
