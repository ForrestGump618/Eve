"""Independent metric gates and comparable experiment records; no model grading."""
import hashlib
import json
import math
from .store import uid


async def read_metrics(platform,scope,path):
    raw=await (await platform.backend(scope)).read_text(path,max_bytes=200000)
    if raw.get('truncated'):raise ValueError('指标文件过大，禁止使用截断数据')
    text=raw.get('text',raw.get('content',''))
    metrics=json.loads(text)
    if not isinstance(metrics,dict):raise ValueError('指标文件必须是 JSON 对象')
    return metrics,hashlib.sha256(text.encode()).hexdigest()


def checks(metrics,rules):
    if not isinstance(rules,list) or not 1<=len(rules)<=30:raise ValueError('需要 1—30 条检查规则')
    result=[]
    for rule in rules:
        if not isinstance(rule,dict):raise ValueError('检查规则必须是对象')
        op=rule.get('op');threshold=rule.get('threshold');name=rule.get('metric')
        if op not in {'lt','le','gt','ge','eq'} or not isinstance(name,str):raise ValueError('指标名或比较操作无效')
        if type(threshold) not in {int,float} or not math.isfinite(threshold):raise ValueError('阈值必须为有限数值')
        value=metrics.get(name)
        finite=type(value) in {int,float} and math.isfinite(value)
        passed=finite and {'lt':lambda:value<threshold,'le':lambda:value<=threshold,'gt':lambda:value>threshold,'ge':lambda:value>=threshold,'eq':lambda:value==threshold}[op]()
        result.append({'metric':name,'value':value if finite else None,'op':op,'threshold':threshold,'passed':bool(passed)})
    return result


class Experiments:
    def __init__(self,platform):self.platform=platform;self.store=platform.store

    async def record(self,scope,data):
        self.platform.require_workspace(scope)
        for k in ('name','dataset','protocol','metric','path'):
            if not isinstance(data.get(k),str) or not data[k].strip():raise ValueError(f'缺少 {k}')
        if data.get('direction') not in {'min','max'}:raise ValueError('direction 仅支持 min / max')
        metrics,digest=await read_metrics(self.platform,scope,data['path'])
        score=metrics.get(data['metric'])
        if type(score) not in {int,float} or not math.isfinite(score):raise ValueError('目标指标缺失或不是有限数值')
        result={k:data[k] for k in ('name','dataset','protocol','metric','path','direction')}
        result.update(score=score,metrics_sha256=digest,kind='imported_metrics',scientific_status='unverified')
        return self.store.put('experiment',uid('experiment'),result,scope)

    def compare(self,scope,ids):
        self.platform.require_workspace(scope)
        if not isinstance(ids,list) or not 2<=len(ids)<=50 or any(not isinstance(i,str) for i in ids) or len(set(ids))!=len(ids):raise ValueError('请选择 2—50 个不同实验')
        rows=[self.store.get('experiment',id,scope) for id in ids]
        if any(r is None for r in rows):raise ValueError('实验不存在或不属于当前工作区')
        if len({tuple(r[k] for k in ('dataset','protocol','metric','direction')) for r in rows})!=1:raise ValueError('仅能比较相同数据集、评估协议、指标及方向的实验')
        rows.sort(key=lambda r:r['score'],reverse=rows[0]['direction']=='max')
        return {'ranking':rows,'best':[r['id'] for r in rows if r['score']==rows[0]['score']],
            'scientific_status':'unverified','note':'排序仅按导入指标；数据集与协议标识由用户声明，不证明统计显著性、数据无泄漏或生物学因果。'}
