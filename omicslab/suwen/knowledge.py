"""Workspace-only knowledge and selective memory, keyword + optional API vectors."""
import hashlib
import io
import json
import math
import re
import time
import zipfile
from collections import Counter
from xml.etree import ElementTree

import httpx

from .store import uid,redact


def terms(text):
    words=re.findall(r'[a-z0-9_]+|[\u4e00-\u9fff]',text.lower())
    chinese=''.join(re.findall(r'[\u4e00-\u9fff]',text))
    return Counter(words+[chinese[i:i+2] for i in range(len(chinese)-1)])


def sensitive(text):
    return bool(re.search(r'sk-[\w-]{8,}|(?i:api[_ -]?key|password|access_token)\s*[:=]|\b\d{17}[0-9Xx]\b',text))


def parse_document(name,data):
    if len(data)>10_000_000:
        raise ValueError('知识源最大 10MB')
    ext=name.lower().rsplit('.',1)[-1]
    if ext=='pdf':
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError('PDF 解析未安装：请安装 pypdf；原文件未更改')
        return [(f'page:{i+1}',p.extract_text() or '') for i,p in enumerate(PdfReader(io.BytesIO(data)).pages)]
    if ext=='docx':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            member=archive.getinfo('word/document.xml')
            if member.file_size>20_000_000:
                raise ValueError('解压后文档过大')
            xml=ElementTree.fromstring(archive.read(member))
            return [('document','\n'.join(t.text or '' for t in xml.iter() if t.tag.endswith('}t')))]
    if ext not in {'txt','md','csv','tsv','py','r','js','json','html','xml','tex','yaml','yml'}:
        raise ValueError('不支持的知识源格式')
    return [('text',data.decode('utf-8-sig'))]


class Knowledge:
    def __init__(self,platform):
        self.platform=platform;self.store=platform.store

    async def vector(self,text,scope):
        config=self.platform.config.get('memory',scope)['value']
        models=self.platform.config.get('models',scope)['value']
        role=models['roles'].get('embedding',{})
        if config['embedding']!='api':
            return None
        if sensitive(text):
            raise ValueError('检测到可能的敏感凭据，禁止发送到嵌入服务')
        base=config['embedding_url'] or role.get('api_base','')
        model=config['embedding_model'] or role.get('model','')
        if not base or not model:
            raise ValueError('独立嵌入服务未配置 URL 或模型')
        from .models import require_private_endpoint
        require_private_endpoint(models['strategy'],base)
        key=self.platform.vault.get(role.get('credential_ref') or 'embedding')
        async with httpx.AsyncClient(timeout=30) as client:
            response=await client.post(base.rstrip('/')+'/embeddings',
                json={'model':model,'input':text[:12000]},
                headers={'Authorization':f'Bearer {key}'} if key else {})
            if response.status_code>=400:
                raise ValueError(f'嵌入服务 HTTP {response.status_code}；请检查配置')
            vector=response.json()['data'][0]['embedding']
            if not isinstance(vector,list) or not vector or not all(type(v) in {int,float} and math.isfinite(v) for v in vector):
                raise ValueError('嵌入返回格式无效')
            return vector

    async def add(self,scope,title,text,kind='memory',source='',locator='',auto=False):
        config=self.platform.config.get('memory',scope)['value']
        if not config['enabled']:
            raise ValueError('记忆已暂停')
        if kind not in {'memory','knowledge','preference','conclusion','evidence'}:
            raise ValueError('记忆类型无效')
        if not text.strip() or len(text)>64000:
            raise ValueError('正文为空或超过 64000 字符')
        if sensitive(text):
            raise ValueError('检测到潜在敏感凭据或身份信息，请先脱敏')
        if auto and (not config['auto_capture'] or len(text)<80):
            return None
        digest=hashlib.sha256(text.strip().encode()).hexdigest()
        records=self.store.list('knowledge',scope)
        same=next((r for r in records if r.get('digest')==digest),None)
        if same:
            return same
        conflicts=[r['id'] for r in records if r['title']==title and r.get('kind')==kind]
        vector=await self.vector(text,scope)
        return self.store.put('knowledge',uid('mem'),{'title':title[:200],'text':text,'kind':kind,
           'source':source,'locator':locator,'digest':digest,'vector':vector,'embedding_model':config['embedding_model'] if vector else None,
           'expires_at':time.time()+config['retention_days']*86400,'conflicts':conflicts,'automatic':auto},scope)

    async def index(self,scope,name,data):
        parsed=parse_document(name,data)
        fingerprint=hashlib.sha256(data).hexdigest()
        entries=[]
        for location,text in parsed:
            for offset in range(0,len(text),1400):
                chunk=text[offset:offset+1800]
                if chunk.strip():
                    entry=await self.add(scope,name,chunk,'knowledge',name,f'{location};chars:{offset}-{offset+len(chunk)}')
                    entries.append(entry['id'])
        return self.store.put('source',hashlib.sha256(name.encode()).hexdigest()[:20],
           {'name':name,'digest':fingerprint,'chunks':entries,'indexed_at':time.time()},scope)

    async def search(self,scope,query,limit=5,source=''):
        if not self.platform.config.get('memory',scope)['value']['enabled']:
            return []
        query_terms=terms(query)
        vector=await self.vector(query,scope)
        result=[]
        active_sources={r['name']:set(r.get('chunks',[])) for r in self.store.list('source',scope)}
        for row in self.store.list('knowledge',scope):
            if row.get('expires_at',float('inf'))<time.time() or (source and row.get('source')!=source):
                continue
            if row['kind']=='knowledge' and row.get('source') in active_sources and row['id'] not in active_sources[row['source']]:
                continue
            words=terms(row['title']+' '+row['text'])
            score=sum(min(count,words.get(word,0)) for word,count in query_terms.items())/max(1,math.sqrt(sum(words.values())))
            if vector and row.get('vector') and row.get('embedding_model')==self.platform.config.get('memory',scope)['value']['embedding_model']:
                other=row['vector']
                if len(vector)==len(other):
                    norm=math.sqrt(sum(v*v for v in vector)*sum(v*v for v in other)) or 1
                    score+=sum(a*b for a,b in zip(vector,other))/norm
            if score>0:
                item={k:v for k,v in row.items() if k!='vector'}
                item['score']=round(score,6);result.append(item)
        return sorted(result,key=lambda r:r['score'],reverse=True)[:min(20,max(1,limit))]

    def export(self,scope):
        return {'schema_version':2,'items':[{k:v for k,v in r.items() if k!='vector'} for r in self.store.list('knowledge',scope)]}
