export async function queryDatabase(kind:'pubmed'|'uniprot',query:string,signal?:AbortSignal):Promise<any> {
 if(typeof query!=='string'||!query.trim()||query.length>1000)throw new Error('检索词为空或过长');
 const retrievedAt=new Date().toISOString();
 if(kind==='pubmed'){
  const url=new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');url.search=new URLSearchParams({query,format:'json',pageSize:'5',resultType:'core'}).toString();
  const r=await fetch(url,{signal,redirect:'error'});if(!r.ok)throw new Error(`Europe PMC HTTP ${r.status}`);const body=await r.json() as any;
  return {database:'Europe PMC / PubMed',query,retrievedAt,endpoint:url.origin+url.pathname,results:(body.resultList?.result??[]).map((x:any)=>({id:x.id,source:x.source,pmid:x.pmid,title:x.title,doi:x.doi,year:x.pubYear,url:x.pmid?`https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/`:`https://europepmc.org/article/${x.source}/${x.id}`}))};
 }
 const url=new URL('https://rest.uniprot.org/uniprotkb/search');url.search=new URLSearchParams({query,format:'json',size:'5',fields:'accession,id,protein_name,gene_names,organism_name'}).toString();
 const r=await fetch(url,{signal,redirect:'error'});if(!r.ok)throw new Error(`UniProt HTTP ${r.status}`);const body=await r.json() as any;
 return {database:'UniProt',query,retrievedAt,release:r.headers.get('x-uniprot-release'),results:(body.results??[]).map((x:any)=>({id:x.primaryAccession,name:x.uniProtkbId,protein:x.proteinDescription?.recommendedName?.fullName?.value,organism:x.organism?.scientificName,url:`https://www.uniprot.org/uniprotkb/${x.primaryAccession}`}))};
}
