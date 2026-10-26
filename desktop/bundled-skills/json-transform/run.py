import sys,json
data=json.loads(sys.argv[1]);value=data["value"]
if "keys" in data:
    if not isinstance(value,dict): raise ValueError("key selection requires an object")
    value={key:value[key] for key in data["keys"] if key in value}
print(json.dumps({"value":value,"formatted":json.dumps(value,ensure_ascii=False,indent=2)},ensure_ascii=False))
