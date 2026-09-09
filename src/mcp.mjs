import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {check,InputError,safePath,VERSION} from './core.mjs';

export function createServer(root) {
  const server=new McpServer({name:'wrangler-config-doctor',version:VERSION});
  server.registerTool('wrangler_config_check',{
    description:'Check a selected local Wrangler configuration for eight common hazards. Does not deploy or contact Cloudflare.',
    inputSchema:z.strictObject({configPath:z.string().max(1024).refine(safePath,'Safe relative config path required'),
      environment:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),strict:z.boolean().default(false)}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async ({configPath,environment,strict})=>{
    try {return {content:[{type:'text',text:'Offline configuration analysis complete.'}],structuredContent:await check(root,configPath,{environment,strict})};}
    catch(e) {return {isError:true,content:[{type:'text',text:e instanceof InputError?e.code:'INTERNAL_ERROR'}]};}
  });
  return server;
}
export async function start(root) {
  return serveStdio(()=>createServer(root),{onerror(){process.stderr.write('MCP_ERROR\n');}});
}
