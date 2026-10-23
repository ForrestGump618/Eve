"""Biomni-inspired retrieval + execution, with an independent evidence gate.

Self-authored lightweight tools; does not claim to bundle Biomni's E1 environment.
"""
import hashlib
import importlib.util
import json
import math
import re
import time
from urllib.parse import quote

import httpx

from .knowledge import terms,sensitive
from .store import uid,redact

CATALOG=[
 {'name':'bio_literature_search','domain':'literature','description':'检索 Europe PMC 的论文元数据、PMID、DOI 与撤稿标志','dependencies':['network'],'source':'https://europepmc.org/RestfulWebService'},
 {'name':'bio_protein_lookup','domain':'protein','description':'按 UniProt accession 获取蛋白、基因、物种与注释','dependencies':['network'],'source':'https://www.uniprot.org/help/api'},
 {'name':'bio_sequence_check','domain':'genomics','description':'本地 DNA 序列长度、GC、反向互补与非法字符检查','dependencies':[],'source':'self-authored'},
 {'name':'bio_record_claim','domain':'evidence','description':'登记生物学结论，区分证据、推断和待验证假设','dependencies':[],'source':'self-authored'},
 {'name':'bio_verify_claim','domain':'verification','description':'从实际指标文件执行数值规则、校验来源与执行轨迹；不以模型意见作为验证通过','dependencies':['metric_json'],'source':'self-authored'},
 {'name':'run_python_code','domain':'analysis','description':'在选定工作区持久内核执行分析，保留代码与运行轨迹','dependencies':['python'],'source':'built-in'},
]


def is_research(text):
    return bool(re.search(r'基因|肿瘤|通路|假设|生物学|差异表达|蛋白|单细胞|转录组|细胞通讯|gene|hypothes|differential|cancer|protein|transcriptom|single.cell',text,re.I))


class Biomedical:
    def __init__(self,platform):self.platform=platform;self.store=platform.store

    def status(self):
        installed=bool(importlib.util.find_spec('biomni'))
        return {'source':'https://github.com/snap-stanford/Biomni','integration':'independent lightweight implementation + optional MCP',
            'upstream_installed':installed,'e1_environment':'not_verified','datalake':'not_downloaded',
            'tools':CATALOG,'evidence_gate':'required_for_research_conclusions',
            'reference_article':{'url':'https://zhuanlan.zhihu.com/p/1916045864771786659','access':'403; primary repository used'}}

    def retrieve(self,query):
        query_terms=terms(query)
        scored=[]
        for item in CATALOG:
            words=terms(item['name']+' '+item['description']+' '+item['domain'])
            score=sum(count*words.get(key,0) for key,count in query_terms.items())
            scored.append(dict(item,score=score))
        return sorted(scored,key=lambda r:r['score'],reverse=True)

    async def literature(self,scope,query,limit=5):
        if sensitive(query):raise ValueError('检索词包含潜在敏感数据，请先脱敏')
        params={'query':query,'format':'json','resultType':'core','pageSize':min(10,max(1,limit))}
        async with httpx.AsyncClient(timeout=30) as client:
            response=await client.get('https://www.ebi.ac.uk/europepmc/webservices/rest/search',params=params)
            if response.status_code!=200:raise ValueError(f'Europe PMC 返回 HTTP {response.status_code}')
            results=response.json().get('resultList',{}).get('result',[])
        records=[]
        for paper in results:
            source=paper.get('source','MED');accession=str(paper.get('id',''))
            record={'title':paper.get('title',''),'doi':paper.get('doi'),'pmid':paper.get('pmid'),
                'year':paper.get('pubYear'),'abstract':re.sub('<[^>]+>','',paper.get('abstractText',''))[:6000],
                'url':f'https://europepmc.org/article/{quote(source)}/{quote(accession)}','retrieved_at':time.time(),
                'source_type':'literature_metadata','source_verified':True,'scientific_status':'relevance_requires_review',
                'retracted':paper.get('isRetracted')=='Y','query':query}
            records.append(self.store.put('bio_source',hashlib.sha256((source+accession).encode()).hexdigest()[:24],record,scope))
        return {'results':records,'count':len(records),'query':query,'note':'来源元数据已取得；不代表论文支持某项生物学结论'}

    async def protein(self,scope,accession):
        if not re.fullmatch(r'[A-Z0-9]{6,10}',accession):raise ValueError('需要 UniProt accession，例如 P04637')
        async with httpx.AsyncClient(timeout=30) as client:
            response=await client.get(f'https://rest.uniprot.org/uniprotkb/{accession}.json')
            if response.status_code!=200:raise ValueError(f'UniProt HTTP {response.status_code}')
            data=response.json()
        record={'accession':data.get('primaryAccession'),'protein':data.get('proteinDescription'),
            'genes':data.get('genes',[]),'organism':data.get('organism'),'sequence_length':data.get('sequence',{}).get('length'),
            'url':f'https://www.uniprot.org/uniprotkb/{accession}','retrieved_at':time.time(),'source_type':'database',
            'source_verified':True,'scientific_status':'annotation_not_causation'}
        return self.store.put('bio_source','uniprot_'+accession,record,scope)

    @staticmethod
    def sequence(sequence):
        value=re.sub(r'\s+','',sequence).upper()
        if not value or len(value)>1_000_000:raise ValueError('DNA 序列需为 1—1000000 个碱基')
        invalid=sorted(set(value)-set('ACGTN'))
        valid=len(value)-value.count('N')
        return {'length':len(value),'gc_fraction':(value.count('G')+value.count('C'))/valid if valid else None,
            'ambiguous':value.count('N'),'invalid':invalid,'valid':not invalid,
            'reverse_complement':value.translate(str.maketrans('ACGTN','TGCAN'))[::-1] if not invalid else None,
            'sha256':hashlib.sha256(value.encode()).hexdigest(),'method':'deterministic DNA alphabet check'}

    def record_claim(self,scope,run,data):
        if data.get('kind') not in {'evidence','inference','hypothesis'} or not data.get('statement'):
            raise ValueError('结论需要 statement 和 kind（evidence / inference / hypothesis）')
        sources=list(data.get('sources') or [])
        if any(not self.store.get('bio_source',source,scope) for source in sources):raise ValueError('引文来源不存在或不属于此工作区')
        return self.store.put('claim',uid('claim'),{'statement':str(data['statement'])[:5000],'kind':data['kind'],
            'sources':sources,'run':run,'validation_status':'unverified','limitations':data.get('limitations',''),
            'reviewer':None,'checks':[]},scope)

    async def verify(self,scope,id,path,rules):
        claim=self.store.get('claim',id,scope)
        if not claim:raise ValueError('结论不存在或不属于此工作区')
        if not rules or len(rules)>30:raise ValueError('需要 1—30 条独立数值规则')
        backend=await self.platform.backend(scope)
        raw=await backend.read_text(path,max_bytes=200000)
        text=raw.get('text',raw.get('content',''))
        metrics=json.loads(text)
        if not isinstance(metrics,dict):raise ValueError('指标文件必须为 JSON 对象')
        checks=[]
        operations={'lt':lambda a,b:a<b,'le':lambda a,b:a<=b,'gt':lambda a,b:a>b,'ge':lambda a,b:a>=b,'eq':lambda a,b:a==b}
        for rule in rules:
            name=rule.get('metric');op=rule.get('op');value=metrics.get(name);threshold=rule.get('threshold')
            if op not in operations or not isinstance(value,(float,int)) or isinstance(value,bool) or not math.isfinite(value):
                checks.append({'metric':name,'passed':False,'reason':'指标缺失、非有限数值或操作符无效'});continue
            if not isinstance(threshold,(float,int)) or isinstance(threshold,bool) or not math.isfinite(threshold):raise ValueError('阈值必须为有限数值')
            checks.append({'metric':name,'value':value,'op':op,'threshold':threshold,'passed':operations[op](value,threshold)})
        sources=[self.store.get('bio_source',source,scope) for source in claim['sources']]
        source_ok=bool(sources) and all(s and s.get('source_verified') and not s.get('retracted') for s in sources)
        passed=all(c['passed'] for c in checks)
        status='checks_passed_needs_human' if passed and source_ok else 'insufficient_evidence'
        return self.store.put('claim',id,dict(claim,checks=checks,metrics_path=path,
            metrics_sha256=hashlib.sha256(text.encode()).hexdigest(),source_check=source_ok,
            validation_status=status,reviewer=None,validated_at=time.time(),
            limitations='数值检查不证明因果关系；还需核对样本独立性、混杂、多重检验与原始数据。'),scope)

    def gate(self,scope,run,text,scientific=False):
        claims=[r for r in self.store.list('claim',scope) if r.get('run')==run]
        if not scientific and not claims:return {'status':'not_applicable','claims':[]}
        blockers=[]
        if not claims:blockers.append('尚未登记可追溯的生物学结论和证据')
        for claim in claims:
            if claim['validation_status']!='human_reviewed':blockers.append(f'{claim["id"]}：{claim["validation_status"]}')
        gate={'status':'needs_review' if blockers else 'human_reviewed','claims':[r['id'] for r in claims],
            'blockers':blockers,'execution_success_is_not_scientific_validation':True,'run':run}
        self.store.put('evidence_gate',run or uid('gate'),gate,scope)
        return gate

    def record_execution(self,scope,run,name,args,result):
        # Store provenance and hashes, not raw private inputs or credentials.
        record={'run':run,'tool':name,'ok':result.ok,'arguments_sha256':hashlib.sha256(json.dumps(args,sort_keys=True,default=str).encode()).hexdigest(),
            'output_sha256':hashlib.sha256((result.content or '').encode()).hexdigest(),'duration_ms':result.duration_ms,
            'code':redact(args.get('code','')[:20000]) if name in {'run_python_code','sandbox_python'} else '',
            'input_path':args.get('path'),'execution_status':'executed' if result.ok else 'failed',
            'scientific_status':'unverified','environment':'workspace kernel; runtime trace retains detailed outputs'}
        return self.store.put('provenance',uid('step'),record,scope)

    def register(self):
        from ..agent.tools import ToolSpec
        from ..agent.types import ToolResult
        definitions={
          'bio_tool_search':('检索适合当前生物医学任务的可用工具。',{'query':{'type':'string'}}),
          'bio_literature_search':('检索 Europe PMC，保存可追溯文献元数据。',{'query':{'type':'string'},'limit':{'type':'integer'}}),
          'bio_protein_lookup':('通过 UniProt accession 查询蛋白注释。',{'accession':{'type':'string'}}),
          'bio_sequence_check':('独立计算 DNA 序列 QC；不访问网络。',{'sequence':{'type':'string'}}),
          'bio_record_claim':('登记科研结论与证据来源，最终回答前使用。',{'statement':{'type':'string'},'kind':{'type':'string','enum':['evidence','inference','hypothesis']},'sources':{'type':'array','items':{'type':'string'}},'limitations':{'type':'string'}}),
          'bio_verify_claim':('从实际 JSON 指标文件执行独立检查；不由模型给出通过状态。',{'claim_id':{'type':'string'},'metrics_path':{'type':'string'},'rules':{'type':'array','items':{'type':'object','properties':{'metric':{'type':'string'},'op':{'type':'string','enum':['lt','le','gt','ge','eq']},'threshold':{'type':'number'}},'required':['metric','op','threshold']}}}),
        }
        for name,(description,properties) in definitions.items():
            async def handler(ctx,args,tool=name):
                ws=getattr(getattr(ctx,'backend',None),'workspace',None);scope=getattr(ws,'workspace_id','ws_main')
                run=getattr(ctx,'run_id','') or ctx.conversation_id
                if tool=='bio_tool_search':data={'tools':self.retrieve(args.get('query',''))}
                elif tool=='bio_literature_search':data=await self.literature(scope,args.get('query',''),int(args.get('limit',5)))
                elif tool=='bio_protein_lookup':data=await self.protein(scope,args.get('accession',''))
                elif tool=='bio_sequence_check':data=self.sequence(args.get('sequence',''))
                elif tool=='bio_record_claim':data=self.record_claim(scope,run,args)
                else:data=await self.verify(scope,args.get('claim_id',''),args.get('metrics_path',''),args.get('rules',[]))
                return ToolResult('',tool,True,json.dumps(data,ensure_ascii=False,default=str)[:20000],data=data)
            category='network' if name in {'bio_literature_search','bio_protein_lookup'} else 'system' if name in {'bio_tool_search','bio_sequence_check'} else 'research'
            spec=ToolSpec(name,description,{'type':'object','properties':properties},category,handler,category=='network')
            self.platform.state.registry.register(spec)
