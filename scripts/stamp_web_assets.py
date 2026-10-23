"""Version module graph and entry assets so upgrades cannot reuse stale UI modules."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
version = re.search(r'__version__\s*=\s*"([^"]+)"', (root/'omicslab/__init__.py').read_text(encoding='utf-8')).group(1)
web = root/'omicslab/web'
for path in (web/'js').rglob('*.js'):
    text = path.read_text(encoding='utf-8')
    text = re.sub(r'''(["'])(\.{1,2}/[^"'\n]+?\.js)(?:\?v=[\w.\-]+)?(["'])''',
                  lambda m: m[1]+m[2]+'?v='+version+m[3], text)
    path.write_text(text,encoding='utf-8')
index = web/'index.html'
text = index.read_text(encoding='utf-8')
text = re.sub(r'((?:src|href)="(?:js|css|assets)/[^"?]+\.(?:js|css|svg))(?:\?v=[\w.\-]+)?(")',
              lambda m: m[1]+'?v='+version+m[2],text)
index.write_text(text,encoding='utf-8')
print('Web asset version:',version)
