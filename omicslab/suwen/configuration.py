"""Validated, scoped settings with redacted history and rollback."""
import copy
import re
import math
from urllib.parse import urlsplit

DEFAULTS = {
 'models': {'mode':'balanced','strategy':'quality','roles':{},'fallbacks':[], 'capabilities':{},'auxiliary_profiles':{},'context_window':32000,'sage_verification':False,'orchestration':True,'verification':'standard'},
 'memory': {'enabled':True,'auto_capture':False,'embedding':'keyword','embedding_url':'','embedding_model':'','top_k':5,'retention_days':365},
 'appearance': {'theme':'light','font':'system','font_size':14,'accent':'#3157D5','density':'comfortable','radius':12,'mode':'research','home':'dashboard','onboarded':False,'agent_name':'Eve','avatar':'','shortcuts':{'palette':'k'}},
 'permissions': {'files':'allow','shell':'allow','network':'allow','browser':'allow','messages':'allow','mcp':'allow','memory':'allow','skills':'allow','agents':'allow','python':'allow','system':'allow','notebook':'allow','jobs':'allow','research':'allow','tools':{}},
 'budget': {'concurrency':2,'prices':{}},
 'vision': {'enabled':False,'auto_review':False,'max_repairs':2,'model':'','api_base':'','credential_ref':''},
 'dreaming': {'enabled':False,'auto':False},
 'literature': {
     'enabled':True,
     'daily_enabled':True,
     'startup_delay_seconds':45,
     'check_interval_seconds':900,
     'lookback_hours':48,
     'daily_limit':18,
     'deep_read_limit':4,
     'prior_art_limit':5,
     'min_interestingness':0.45,
     'cross_discipline_weight':0.25,
     'feed_daily_limit':3,
     'proactive_enabled':True,
     'proactive_intensity':'balanced',
     'proactive_daily_limit':2,
     'proactive_cooldown_minutes':240,
     'proactive_ttl_hours':36,
     'auto_dream':True,
     'max_upload_mb':10,
     'fulltext_char_limit':50000,
     'http_timeout_seconds':20,
     'search_result_limit':50,
     'scan_limit':1000,
     'feedback_limit':500,
     'proactive_history_limit':200,
     'sources':{'europe_pmc':True,'openalex':True,'biorxiv':True,'arxiv':True},
     'quota':{'biology':50,'methods':20,'cross_disciplinary':15,'conference':15},
     'top_journals':['Nature','Science','Cell','Nature Medicine','Nature Biotechnology',
                     'Nature Methods','Nature Genetics','Cell Systems','Immunity','Cancer Cell'],
     'bridge_concepts':['topological data analysis','network science','causal inference',
                        'information theory','statistical physics','dynamical systems',
                        'optimal transport','graph learning','mechanistic modeling','control theory'],
 },
}


AUXILIARY_TAGS = {
    'literature.embedding',
    'literature.extraction',
    'literature.classification',
    'reflection.reasoning',
    'skill.extraction',
}


def _validate_nested_types(value, default, path=''):
    """Validate nested defaults without treating an empty mapping as untyped."""
    if isinstance(default, dict):
        if not isinstance(value, dict):
            raise ValueError(f'{path or "设置"}必须为对象')
        if not default:
            return
        unknown = set(value) - set(default)
        if unknown:
            raise ValueError(f'{path or "设置"}包含未知字段：'+','.join(sorted(unknown)))
        for key, item in value.items():
            _validate_nested_types(item, default[key], f'{path}.{key}' if path else key)
    elif isinstance(default, bool):
        if not isinstance(value, bool):
            raise ValueError(f'{path or "设置"}必须为布尔值')
    elif isinstance(default, str):
        if not isinstance(value, str):
            raise ValueError(f'{path or "设置"}必须为文本')
    elif isinstance(default, list):
        if not isinstance(value, list):
            raise ValueError(f'{path or "设置"}必须为数组')
    elif isinstance(default, (int, float)):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'{path or "设置"}必须为数值')


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
               'embedding':{'keyword','api'},'font':{'system','sans','mono'},
               'verification':{'off','standard','sage'},
               'proactive_intensity':{'off','low','balanced','high'}}
        for key,choices in enums.items():
            if key in value and value[key] not in choices:
                raise ValueError(f'{key} 仅支持 {sorted(choices)}')
        ranges={'font_size':(12,22),'radius':(0,24),'context_window':(2048,2000000),'max_tokens':(1000,10000000),
                'max_cost':(0,1000000),'concurrency':(1,8),'max_repairs':(0,5),'top_k':(1,20),'retention_days':(1,3650),'warn_ratio':(.1,1),
                'startup_delay_seconds':(0,3600),'check_interval_seconds':(60,86400),'lookback_hours':(1,720),
                'daily_limit':(1,200),'deep_read_limit':(0,50),'prior_art_limit':(1,20),
                'min_interestingness':(0,1),'cross_discipline_weight':(0,1),'feed_daily_limit':(0,20),
                'proactive_daily_limit':(0,20),'proactive_cooldown_minutes':(0,10080),
                'proactive_ttl_hours':(1,168),'max_upload_mb':(1,100),
                'fulltext_char_limit':(4000,200000),'http_timeout_seconds':(5,120),
                'search_result_limit':(5,200),'scan_limit':(100,10000),
                'feedback_limit':(20,5000),'proactive_history_limit':(20,2000)}
        for key,(low,high) in ranges.items():
            if key in value and (isinstance(value[key],bool) or not isinstance(value[key],(int,float)) or not low<=value[key]<=high):
                raise ValueError(f'{key} 必须在 {low}—{high} 之间')
            if key in value and key not in {'max_cost','warn_ratio','min_interestingness','cross_discipline_weight'} and type(value[key]) is not int:
                raise ValueError(f'{key} 必须为整数')
        for key,default in DEFAULTS[section].items():
            _validate_nested_types(value[key], default, key)
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
                if 'temperature' in caps and not (type(caps['temperature']) is bool or (isinstance(caps['temperature'],(int,float)) and 0<=caps['temperature']<=2)):
                    raise ValueError('temperature 需要布尔值开关或 0—2 的数值')
                if 'context_window' in caps and (type(caps['context_window']) is not int or not 2048<=caps['context_window']<=2000000):
                    raise ValueError('模型 context_window 需要 2048—2000000 的整数')
                if 'modalities' in caps and (not isinstance(caps['modalities'],list) or any(m not in {'text','image','audio'} for m in caps['modalities']) or not caps['modalities']):
                    raise ValueError('modalities 仅支持 text / image / audio 的非空数组')
                if 'supported_parameters' in caps and (not isinstance(caps['supported_parameters'],list) or any(not isinstance(x,str) or not x.strip() for x in caps['supported_parameters'])):
                    raise ValueError('supported_parameters 需要非空白文本数组')
                if caps.get('token_parameter','max_tokens') not in {'max_tokens','max_completion_tokens'}:raise ValueError('Token 参数名无效')
            if not isinstance(value['auxiliary_profiles'],dict):
                raise ValueError('auxiliary_profiles 必须为对象')
            unknown_tags=set(value['auxiliary_profiles'])-AUXILIARY_TAGS
            if unknown_tags:
                raise ValueError('未知辅助模型任务：'+','.join(sorted(unknown_tags)))
            for tag,target in value['auxiliary_profiles'].items():
                if not isinstance(target,dict) or set(target)-{'provider','model','api_base','credential_ref'}:
                    raise ValueError(f'{tag} 辅助模型连接字段无效')
                if any(not isinstance(item,str) for item in target.values()):
                    raise ValueError(f'{tag} 辅助模型连接需要文本字段')
                if target.get('api_base'):
                    url=urlsplit(target['api_base'])
                    if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password:
                        raise ValueError(f'{tag} 服务地址需要不含凭据的 HTTP(S) URL')
        if section=='budget':
            for prices in value['prices'].values():
                if not isinstance(prices,dict) or set(prices)-{'input','output'}:raise ValueError('价格需要 input / output 对象')
                if any(type(v) not in {int,float} or not math.isfinite(v) or v<0 for v in prices.values()):raise ValueError('价格必须为非负有限数值')
        if section=='appearance':
            if value['home'] not in {'dashboard','literature','workbench','tasks2','research','knowledge'}:raise ValueError('默认首页无效')
            if len(value['avatar'])>16:raise ValueError('头像请使用一个字符或 Emoji')
            if set(value['shortcuts'])-{'palette'} or not re.fullmatch('[a-z]',value['shortcuts'].get('palette','k')):
                raise ValueError('命令面板快捷键需要 a-z 单个字母')
        if section=='literature':
            if not isinstance(value['sources'],dict) or not value['sources']:
                raise ValueError('文献来源不能为空')
            if any(not isinstance(key,str) or not key.strip() for key in value['sources']):
                raise ValueError('文献来源名称必须为文本')
            quota=value['quota']
            if any(type(item) is not int or item<0 for item in quota.values()) or sum(quota.values())!=100:
                raise ValueError('文献阅读配额必须为总和 100 的非负整数')
            for key in ('top_journals','bridge_concepts'):
                if any(not isinstance(item,str) or not item.strip() for item in value[key]):
                    raise ValueError(f'{key} 需要非空白文本数组')
            if len(value['top_journals'])>100 or len(value['bridge_concepts'])>100:
                raise ValueError('期刊或桥接概念最多 100 项')
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
