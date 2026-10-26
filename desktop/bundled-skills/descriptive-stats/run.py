import sys,json,statistics,math
values=json.loads(sys.argv[1])["numbers"]
if not values or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in values): raise ValueError("numbers must be nonempty finite numbers")
print(json.dumps({"count":len(values),"mean":statistics.mean(values),"median":statistics.median(values),"min":min(values),"max":max(values),"sample_stdev":statistics.stdev(values) if len(values)>1 else None}))
