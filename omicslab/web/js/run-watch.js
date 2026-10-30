// Observe transitions only. Refreshing elapsed time must never produce a toast.
export function createRunFailureObserver(notify,{startedAt=Date.now(),limit=500}={}){
 const seen=new Map();
 return runs=>{
  const failures=[];
  for(const run of runs){
   const previous=seen.get(run.run_id);
   const created=typeof run.created_at==='number'?run.created_at*1000:Date.parse(run.created_at||'');
   if(['failed','interrupted'].includes(run.status)&&previous!==run.status&&
      (previous!==undefined||created>=startedAt))failures.push(run);
   seen.set(run.run_id,run.status);
  }
  while(seen.size>limit)seen.delete(seen.keys().next().value);
  if(failures.length)notify(failures);
 };
}
