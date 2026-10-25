import type { Json } from './harness/types.js';
import { safeError } from './security.js';

/** MCP content is not required to be JSON text. Preserve structured content and
 * multi-block text/resource results, while refusing isError and empty responses. */
export function parseMcpResult(result: any): Json {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new Error('Malformed MCP tool result');
  if (result.isError) throw new Error(`MCP tool failed: ${safeError(result.content.filter((x:any)=>x?.type==='text').map((x:any)=>x.text).join('\n') || 'server returned isError')}`);
  if (result.structuredContent !== undefined) {
    if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) throw new Error('Malformed MCP structuredContent');
    return result.structuredContent as Json;
  }
  if (!result.content.length || JSON.stringify(result).length > 2000000) throw new Error('Empty or oversized MCP tool result');
  if (result.content.some((x:any)=>!x || typeof x !== 'object' || typeof x.type !== 'string' || (x.type === 'text' && typeof x.text !== 'string'))) throw new Error('Malformed MCP content block');
  if (result.content.length === 1 && result.content[0].type === 'text') {
    const text = result.content[0].text;
    if (!text.trim()) throw new Error('Empty MCP tool result');
    try { return JSON.parse(text) as Json; } catch { return { content: result.content, text } as Json; }
  }
  return { content:result.content } as Json;
}
