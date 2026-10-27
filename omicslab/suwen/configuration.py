"""Validated, scoped settings with redacted history and rollback."""
import copy
import re
import math
from urllib.parse import urlsplit

DEFAULTS = {
 'models': {'mode':'balanced','strategy':'quality','roles':{},'fallbacks':[], 'capabilities':{},'context_window':32000,'sage_verification':False,'orchestration':False},
 'memory': {'enabled':True,'auto_capture':False,'embedding':'keyword','embedding_url':'','embedding_model':'','top_k':5,'retention_days':365},
 'appearance': {'theme':'light','font':'system','font_size':14,'accent':'#404040','density':'comfortable','radius':12,'mode':'research','home':'workbench','onboarded':False,'agent_name':'Eve助手','avatar':'','shortcuts':{'palette':'k'}},
 'permissions': {'files':'ask','shell':'ask','network':'ask','browser':'deny','messages':'ask','mcp':'ask','memory':'allow','skills':'allow','agents':'allow','python':'ask','system':'allow','notebook':'ask','jobs':'ask','research':'allow','tools':{}},
 'budget': {'concurrency':2,'prices':{}},
 'vision': {'enabled':False,'auto_review':False,'max_repairs':2,'model':'','api_base':'','credential_ref':''},
}


class Configuration:
    def __init__(self,store):
        self.store=store

    def get(self,section,scope='global'):
        if section not in DEFAULTS:
            raise ValueError('未知设置分类')
        value=copy.deepcopy(DEFAULTS[section])
        global_record=self.store.get('config',section)
        if global_record:
            value.update(global_record['value'])
        local=self.store.get('config',section,scope) if scope!='global' else global_record
        if local:
            value.update(local['value'])
        # Legacy cumulative ceilings remain in historical records, but have no runtime effect.
        value={k:v for k,v in value.items() if k in DEFAULTS[section]}
        return {'value':value,'revision':local['revision'] if local else 0,'scope':scope,'section':section,'effective':'immediate'}

    def update(self,section,patch,scope='global',expected=None,validate_only=False):
        if section not in DEFAULTS or not isinstance(patch,dict):
            raise ValueError('设置分类或内容无效')
        if set(patch)-set(DEFAULTS[section]):
            raise ValueError('包含未知设置字段：'+','.join(set(patch)-set(DEFAULTS[section])))
        value=dict(self.get(section,scope)['value'],**patch)
        enums={'mode': {'fast','balanced','deep'} if section=='models' else {'research','minimal','developer'},
               'theme':{'light','dark','system'},'strategy':{'quality','latency','cost','privacy'},'density':{'compact','comfortable'},
               'embedding':{'keyword','api'},'font':{'system','sans','mono'}}
        for key,choices in enums.items():
            if key in value and value[key] not in choices:
                raise ValueError(f'{key} 仅支持 {sorted(choices)}')
        ranges={'font_size':(12,22),'radius':(0,24),'context_window':(2048,2000000),'max_tokens':(1000,10000000),
                'max_cost':(0,1000000),'concurrency':(1,8),'max_iterations':(1,200),'max_repairs':(0,5),'top_k':(1,20),'retention_days':(1,3650),'warn_ratio':(.1,1)}
        for key,(low,high) in ranges.items():
            if key in value and (isinstance(value[key],bool) or not isinstance(value[key],(int,float)) or not low<=value[key]<=high):
                raise ValueError(f'{key} 必须在 {low}—{high} 之间')
            if key in value and key not in {'max_cost','warn_ratio'} and type(value[key]) is not int:
                raise ValueError(f'{key} 必须为整数')
        for key,default in DEFAULTS[section].items():
            if isinstance(default,bool) and not isinstance(value[key],bool):
                raise ValueError(f'{key} 必须为布尔值')
            if isinstance(default,dict) and not isinstance(value[key],dict):
                raise ValueError(f'{key} 必须为对象')
            if isinstance(default,str) and not isinstance(value[key],str):
                raise ValueError(f'{key} 必须为文本')
            if isinstance(default,list) and not isinstance(value[key],list):
                raise ValueError(f'{key} 必须为数组')
        if section=='models':
            if set(value['roles'])-{'text','reasoning','vision','embedding','code'}:
                raise ValueError('模型角色仅支持 text / reasoning / vision / embedding / code')
            for target in list(value['roles'].values())+value['fallbacks']:
                if not isinstance(target,dict) or any(not isinstance(v,str) for v in target.values()):
                    raise ValueError('模型连接需要文本字段的对象')
                if set(target)-{'provider','model','api_base','credential_ref'}:
                    raise ValueError('模型连接包含未知字段')
            for caps in value['capabilities'].values():
                if not isinstance(caps,dict):raise ValueError('每个模型的能力必须为对象')
                if 'max_output' in caps and (type(caps['max_output']) is not int or not 32<=caps['max_output']<=200000):
                    raise ValueError('max_output 需要 32—200000 的整数')
                if 'temperature' in caps and type(caps['temperature']) is not bool:raise ValueError('temperature 能力需要布尔值')
                if caps.get('token_parameter','max_tokens') not in {'max_tokens','max_completion_tokens'}:raise ValueError('Token 参数名无效')
        if section=='budget':
            for prices in value['prices'].values():
                if not isinstance(prices,dict) or set(prices)-{'input','output'}:raise ValueError('价格需要 input / output 对象')
                if any(type(v) not in {int,float} or not math.isfinite(v) or v<0 for v in prices.values()):raise ValueError('价格必须为非负有限数值')
        if section=='appearance':
            if value['home'] not in {'workbench','tasks2','research','knowledge'}:raise ValueError('默认首页无效')
            if len(value['avatar'])>16:raise ValueError('头像请使用一个字符或 Emoji')
            if set(value['shortcuts'])-{'palette'} or not re.fullmatch('[a-z]',value['shortcuts'].get('palette','k')):
                raise ValueError('命令面板快捷键需要 a-z 单个字母')
        for key in ('api_base','embedding_url'):
            if key in value and value[key]:
                url=urlsplit(value[key])
                if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password:raise ValueError('服务地址需要不含凭据的 HTTP(S) URL')
        if section=='permissions':
            for key,permission in value.items():
                if key=='tools':
                    if any(v not in {'allow','ask','deny','read_only'} for v in permission.values()):
                        raise ValueError('工具权限无效')
                elif permission not in {'allow','ask','deny','read_only'}:
                    raise ValueError('权限级别无效')
        if 'accent' in value and not re.fullmatch(r'#[0-9a-fA-F]{6}',value['accent']):
            raise ValueError('强调色需要 #RRGGBB 格式')
        if re.search(r'"(?:api_key|password|secret|token)"\s*:',__import__('json').dumps(value)):
            raise ValueError('请通过凭据入口加密保存密钥，并在设置中使用 credential_ref')
        if validate_only:return {'valid':True}
        row=self.store.put('config',section,{'schema_version':2,'value':value},scope,expected)
        self.store.audit('config.changed',{'section':section,'revision':row['revision']},scope)
        return self.get(section,scope)

    def rollback(self,section,revision,scope):
        rows=self.store.history('config',section,scope)
        old=next((r for r in rows if r['revision']==revision),None)
        if old is None:
            raise ValueError('历史版本不存在')
        return self.update(section,{k:v for k,v in old['value'].items() if k in DEFAULTS[section]},scope)
