import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryDatabase } from '../src/databases.js';

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('UniProt falls back to EBI for gene and organism queries', async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://rest.uniprot.org/')) {
      return response({ message: 'upstream failed' }, { status: 503 });
    }
    return response([{
      accession: 'P04637',
      id: 'P53_HUMAN',
      protein: { recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } } },
      organism: { names: [{ type: 'scientific', value: 'Homo sapiens' }] },
    }]);
  }) as typeof fetch;

  const result = await queryDatabase('uniprot', 'gene:TP53 AND organism_id:9606', undefined, fetcher);
  assert.equal(result.database, 'UniProt via EBI Proteins');
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason, /UniProt HTTP 503/);
  assert.equal(result.results[0].id, 'P04637');
  assert.equal(result.results[0].organism, 'Homo sapiens');
  assert.equal(requests.length, 2);
  assert.match(requests[1], /gene=TP53/);
  assert.match(requests[1], /taxid=9606/);
});

test('UniProt falls back to the EBI accession endpoint', async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://rest.uniprot.org/')) throw new Error('network timeout');
    return response({
      accession: 'P04637',
      id: 'P53_HUMAN',
      protein: { recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } } },
      organism: { names: [{ type: 'scientific', value: 'Homo sapiens' }] },
    });
  }) as typeof fetch;

  const result = await queryDatabase('uniprot', 'accession:P04637', undefined, fetcher);
  assert.equal(result.results[0].id, 'P04637');
  assert.match(requests[1], /\/proteins\/P04637$/);
});

test('PubMed falls back to NCBI and retains the primary failure', async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://www.ebi.ac.uk/europepmc/')) {
      return response({ error: 'unavailable' }, { status: 503 });
    }
    if (url.includes('esearch.fcgi')) return response({ esearchresult: { idlist: ['12345678'] } });
    if (url.includes('esummary.fcgi')) {
      return response({ result: { '12345678': { title: 'TP53 study', pubdate: '2026' } } });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const result = await queryDatabase('pubmed', 'TP53 cancer', undefined, fetcher);
  assert.equal(result.database, 'NCBI PubMed');
  assert.equal(result.results[0].pmid, '12345678');
  assert.match(result.fallbackReason, /Europe PMC HTTP 503/);
  assert.equal(requests.length, 3);
});

test('UniProt reports both primary and unsupported fallback errors', async () => {
  const fetcher = (async () => response({ message: 'down' }, { status: 500 })) as typeof fetch;
  await assert.rejects(
    queryDatabase('uniprot', 'keyword:kinase', undefined, fetcher),
    /UniProt unavailable: UniProt HTTP 500; EBI fallback supports accession, gene and organism_id\/taxid queries/,
  );
});
