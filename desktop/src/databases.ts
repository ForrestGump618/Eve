export async function queryDatabase(kind:'pubmed'|'uniprot',query:string,signal?:AbortSignal):Promise<any> {
 if(typeof query!=='string'||!query.trim()||query.length>1000)throw new Error('检索词为空或过长');
 signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]);
 const retrievedAt=new Date().toISOString();
 if(kind==='pubmed'){
  const normalized=/^(?:PMID[:\s]*)?\d{5,10}$/i.test(query.trim())?`EXT_ID:${query.replace(/\D/g,'')} AND SRC:MED`:query;
  const url=new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');url.search=new URLSearchParams({query:normalized,format:'json',pageSize:'5',resultType:'core'}).toString();
  try {
   const r=await fetch(url,{signal,redirect:'error'});if(!r.ok)throw new Error(`Europe PMC HTTP ${r.status}`);const body=await r.json() as any;
   if(!Array.isArray(body.resultList?.result))throw new Error('Malformed Europe PMC response');
   return {database:'Europe PMC / PubMed',query,retrievedAt,endpoint:url.origin+url.pathname,results:body.resultList.result.map((x:any)=>({id:x.id??null,source:x.source??null,pmid:x.pmid??null,title:x.title??'',doi:x.doi??null,year:x.pubYear??null,authors:x.authorString??'',abstract:(x.abstractText??'').replace(/<[^>]*>/g,' ').slice(0,12000),url:x.pmid?`https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/`:`https://europepmc.org/article/${x.source}/${x.id}`}))};
  }catch(error){
   signal.throwIfAborted();
   const endpoint='https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
   const search=await fetch(`${endpoint}esearch.fcgi?${new URLSearchParams({db:'pubmed',term:query,retmode:'json',retmax:'5'})}`,{signal,redirect:'error'});
   if(!search.ok)throw new Error(`PubMed fallback HTTP ${search.status}`);
   const ids=((await search.json()) as any).esearchresult?.idlist;
   if(!Array.isArray(ids))throw new Error('Malformed PubMed search response');
   if(!ids.length)return {database:'NCBI PubMed',query,retrievedAt,results:[],fallback:true};
   const summary=await fetch(`${endpoint}esummary.fcgi?${new URLSearchParams({db:'pubmed',id:ids.join(','),retmode:'json'})}`,{signal,redirect:'error'});
   if(!summary.ok)throw new Error(`PubMed summary HTTP ${summary.status}`);
   const records=((await summary.json()) as any).result;
   if(!records)throw new Error('Malformed PubMed summary response');
   return {database:'NCBI PubMed',query,retrievedAt,fallback:true,results:ids.map(id=>({id,pmid:id,title:records[id]?.title??'',year:records[id]?.pubdate??'',abstract:null,url:`https://pubmed.ncbi.nlm.nih.gov/${id}/`}))};
  }
 }
 const url=new URL('https://rest.uniprot.org/uniprotkb/search');url.search=new URLSearchParams({query,format:'json',size:'5',fields:'accession,id,protein_name,gene_names,organism_name'}).toString();
 const r=await fetch(url,{signal,redirect:'error'});if(!r.ok)throw new Error(`UniProt HTTP ${r.status}`);const body=await r.json() as any;
 return {database:'UniProt',query,retrievedAt,release:r.headers.get('x-uniprot-release'),results:(body.results??[]).map((x:any)=>({id:x.primaryAccession,name:x.uniProtkbId,protein:x.proteinDescription?.recommendedName?.fullName?.value,organism:x.organism?.scientificName,url:`https://www.uniprot.org/uniprotkb/${x.primaryAccession}`}))};
}
