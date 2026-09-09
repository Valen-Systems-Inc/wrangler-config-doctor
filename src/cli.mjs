#!/usr/bin/env node
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {check,canonical,InputError,readableRoot,VERSION} from './core.mjs';

export async function main(args) {
  if(args.length===1 && args[0]==='--version') {process.stdout.write(VERSION+'\n');return 0;}
  if(args.length===1 && args[0]==='--help') {
    process.stdout.write('wrangler-config-doctor check <wrangler.toml|wrangler.json|wrangler.jsonc> [--env <name>] [--strict]\nwrangler-config-doctor mcp --root <directory>\nOffline checks only; Node 22.13+. Exit: 0 pass, 2 findings, 64 invalid input, 70 internal error.\n');return 0;
  }
  if(args.length===3 && args[0]==='mcp' && args[1]==='--root') {
    const {start}=await import('./mcp.mjs'); await start(await readableRoot(args[2]));return 0;
  }
  if(args[0]!=='check' || !args[1]) throw new InputError('INVALID_ARGUMENTS');
  const opts={};
  for(let i=2;i<args.length;i++) {
    if(args[i]==='--strict' && opts.strict===undefined) opts.strict=true;
    else if(args[i]==='--env' && opts.environment===undefined && args[i+1]) opts.environment=args[++i];
    else throw new InputError('INVALID_ARGUMENTS');
  }
  const receipt=await check(await readableRoot(process.cwd()),args[1],opts);
  process.stdout.write(canonical(receipt));return receipt.result.outcome==='pass'?0:2;
}
if(process.argv[1] && await realpath(process.argv[1])===await realpath(fileURLToPath(import.meta.url))) {
  try {process.exitCode=await main(process.argv.slice(2));}
  catch(e) {process.stderr.write((e instanceof InputError?e.code:'INTERNAL_ERROR')+'\n');process.exitCode=e instanceof InputError?64:70;}
}
