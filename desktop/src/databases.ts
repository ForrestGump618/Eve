type DatabaseKind = 'pubmed' | 'uniprot';
type Fetcher = typeof fetch;

const PRIMARY_TIMEOUT_MS = 8_000;
const FALLBACK_TIMEOUT_MS = 12_000;

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) signal.throwIfAborted();
}

function resultUrl(accession: unknown): string {
  return `https://www.uniprot.org/uniprotkb/${encodeURIComponent(String(accession ?? ''))}`;
}

function mapUniProt(results: any[]): any[] {
  return results.map(record => ({
    id: record.primaryAccession ?? record.accession ?? null,
    name: record.uniProtkbId ?? record.id ?? null,
    protein:
      record.proteinDescription?.recommendedName?.fullName?.value ??
      record.protein?.recommendedName?.fullName?.value ??
      record.protein?.submittedName?.[0]?.fullName?.value ??
      null,
    organism: record.organism?.scientificName ?? record.organism?.names?.[0]?.value ?? null,
    url: resultUrl(record.primaryAccession ?? record.accession),
  }));
}

function ebiProteinUrl(query: string): URL | undefined {
  const trimmed = query.trim();
  const accession = trimmed.match(/^(?:accession\s*:\s*)?([A-Z][0-9][A-Z0-9]{4,8})$/i)?.[1];
  const gene = trimmed.match(/(?:^|\s)(?:gene|gene_exact)\s*:\s*(?:"([^"]+)"|([^\s]+))/i);
  const taxid = trimmed.match(/(?:^|\s)(?:organism_id|taxid)\s*:\s*(\d+)/i)?.[1];

  if (accession !== undefined) {
    return new URL(`https://www.ebi.ac.uk/proteins/api/proteins/${encodeURIComponent(accession)}`);
  }

  const geneName = gene?.[1] ?? gene?.[2];
  if (geneName === undefined && taxid === undefined) return undefined;

  const url = new URL('https://www.ebi.ac.uk/proteins/api/proteins');
  if (geneName !== undefined) url.searchParams.set('gene', geneName);
  if (taxid !== undefined) url.searchParams.set('taxid', taxid);
  url.searchParams.set('size', '5');
  return url;
}

async function queryPubMed(
  query: string,
  retrievedAt: string,
  signal: AbortSignal | undefined,
  fetcher: Fetcher,
): Promise<any> {
  const normalized = /^(?:PMID[:\s]*)?\d{5,10}$/i.test(query.trim())
    ? `EXT_ID:${query.replace(/\D/g, '')} AND SRC:MED`
    : query;
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  url.search = new URLSearchParams({
    query: normalized,
    format: 'json',
    pageSize: '5',
    resultType: 'core',
  }).toString();

  try {
    const response = await fetcher(url, {
      signal: boundedSignal(signal, PRIMARY_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
    const body = await response.json() as any;
    if (!Array.isArray(body.resultList?.result)) throw new Error('Malformed Europe PMC response');
    return {
      database: 'Europe PMC / PubMed',
      query,
      retrievedAt,
      endpoint: url.origin + url.pathname,
      results: body.resultList.result.map((record: any) => ({
        id: record.id ?? null,
        source: record.source ?? null,
        pmid: record.pmid ?? null,
        title: record.title ?? '',
        doi: record.doi ?? null,
        year: record.pubYear ?? null,
        authors: record.authorString ?? '',
        abstract: (record.abstractText ?? '').replace(/<[^>]*>/g, ' ').slice(0, 12_000),
        url: record.pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`
          : `https://europepmc.org/article/${record.source}/${record.id}`,
      })),
    };
  } catch (primaryError) {
    throwIfCancelled(signal);
    const endpoint = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
    const fallbackSignal = boundedSignal(signal, FALLBACK_TIMEOUT_MS);
    try {
      const search = await fetcher(
        `${endpoint}esearch.fcgi?${new URLSearchParams({
          db: 'pubmed',
          term: query,
          retmode: 'json',
          retmax: '5',
        })}`,
        { signal: fallbackSignal, redirect: 'error' },
      );
      if (!search.ok) throw new Error(`PubMed fallback HTTP ${search.status}`);
      const ids = ((await search.json()) as any).esearchresult?.idlist;
      if (!Array.isArray(ids)) throw new Error('Malformed PubMed search response');
      if (!ids.length) {
        return {
          database: 'NCBI PubMed',
          query,
          retrievedAt,
          results: [],
          fallback: true,
          fallbackReason: primaryError instanceof Error ? primaryError.message : String(primaryError),
        };
      }

      const summary = await fetcher(
        `${endpoint}esummary.fcgi?${new URLSearchParams({
          db: 'pubmed',
          id: ids.join(','),
          retmode: 'json',
        })}`,
        { signal: fallbackSignal, redirect: 'error' },
      );
      if (!summary.ok) throw new Error(`PubMed summary HTTP ${summary.status}`);
      const records = ((await summary.json()) as any).result;
      if (!records) throw new Error('Malformed PubMed summary response');
      return {
        database: 'NCBI PubMed',
        query,
        retrievedAt,
        fallback: true,
        fallbackReason: primaryError instanceof Error ? primaryError.message : String(primaryError),
        results: ids.map((id: string) => ({
          id,
          pmid: id,
          title: records[id]?.title ?? '',
          year: records[id]?.pubdate ?? '',
          abstract: null,
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        })),
      };
    } catch (fallbackError) {
      throwIfCancelled(signal);
      throw new Error(
        `PubMed unavailable: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
        `fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
}

async function queryUniProt(
  query: string,
  retrievedAt: string,
  signal: AbortSignal | undefined,
  fetcher: Fetcher,
): Promise<any> {
  const url = new URL('https://rest.uniprot.org/uniprotkb/search');
  url.search = new URLSearchParams({
    query,
    format: 'json',
    size: '5',
    fields: 'accession,id,protein_name,gene_names,organism_name',
  }).toString();

  try {
    const response = await fetcher(url, {
      signal: boundedSignal(signal, PRIMARY_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`UniProt HTTP ${response.status}`);
    const body = await response.json() as any;
    return {
      database: 'UniProt',
      query,
      retrievedAt,
      release: response.headers.get('x-uniprot-release'),
      results: mapUniProt(Array.isArray(body.results) ? body.results : []),
    };
  } catch (primaryError) {
    throwIfCancelled(signal);
    const fallbackUrl = ebiProteinUrl(query);
    if (fallbackUrl === undefined) {
      throw new Error(
        `UniProt unavailable: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
        'EBI fallback supports accession, gene and organism_id/taxid queries',
      );
    }

    try {
      const response = await fetcher(fallbackUrl, {
        signal: boundedSignal(signal, FALLBACK_TIMEOUT_MS),
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`EBI Proteins HTTP ${response.status}`);
      const body = await response.json() as any;
      const records = Array.isArray(body) ? body : [body];
      return {
        database: 'UniProt via EBI Proteins',
        query,
        retrievedAt,
        endpoint: fallbackUrl.origin + fallbackUrl.pathname,
        fallback: true,
        fallbackReason: primaryError instanceof Error ? primaryError.message : String(primaryError),
        results: mapUniProt(records),
      };
    } catch (fallbackError) {
      throwIfCancelled(signal);
      throw new Error(
        `UniProt unavailable: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
        `fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
}

export async function queryDatabase(
  kind: DatabaseKind,
  query: string,
  signal?: AbortSignal,
  fetcher: Fetcher = globalThis.fetch,
): Promise<any> {
  if (typeof query !== 'string' || !query.trim() || query.length > 1_000) {
    throw new Error('检索词为空或过长');
  }
  const retrievedAt = new Date().toISOString();
  return kind === 'pubmed'
    ? queryPubMed(query, retrievedAt, signal, fetcher)
    : queryUniProt(query, retrievedAt, signal, fetcher);
}
