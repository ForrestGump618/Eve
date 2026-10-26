import sys,json,csv,io,math,statistics
rows=list(csv.DictReader(io.StringIO(json.loads(sys.argv[1])["csv"])))
columns=list(rows[0]) if rows else []
summary={}
for col in columns:
    values=[]
    for row in rows:
        try:
            value=float(row.get(col,""))
            if math.isfinite(value): values.append(value)
        except (ValueError,TypeError): pass
    if values: summary[col]={"count":len(values),"mean":statistics.mean(values),"min":min(values),"max":max(values)}
print(json.dumps({"rowCount":len(rows),"columns":columns,"numericSummary":summary},ensure_ascii=False))
