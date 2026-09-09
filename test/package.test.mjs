import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {buildZip,ROOT,FILES} from '../scripts/build.mjs';
const exec=promisify(callback);
test('portable archive: checksum, allowlist, licenses, CLI and actual MCP with no runtime install',async t=>{
  const output=await mkdtemp(path.join(tmpdir(),'doctor-package-'));
  t.after(()=>rm(output,{recursive:true,force:true}));
  const built=await buildZip(output);const bytes=await readFile(built.archive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),built.sha256);
  assert.equal(await readFile(built.archive+'.sha256','utf8'),`${built.sha256}  ${ROOT}.zip\n`);
  const listing=(await exec('/usr/bin/unzip',['-Z1',built.archive])).stdout.trim().split('\n');
  assert.deepEqual(listing,FILES);
  const modes=(await exec('/usr/bin/unzip',['-Z','-l',built.archive])).stdout.split('\n');
  for(const file of FILES) assert.ok(modes.find(line=>line.endsWith(' '+file))?.startsWith('-'));
  await exec('/usr/bin/unzip',['-q',built.archive,'-d',output]);
  const root=path.join(output,ROOT), cli=path.join(root,'wrangler-config-doctor.mjs');
  for(const f of FILES) assert.doesNotMatch(await readFile(path.join(output,f),'utf8'),/\/Users\/|\/private\/tmp\/|private-owner|private-host|localhost:\d+|sk_live_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/u);
  assert.equal((await exec(process.execPath,[cli,'--version'])).stdout,'0.1.0\n');
  assert.match((await exec(process.execPath,[cli,'--help'])).stdout,/check/);
  const checked=JSON.parse((await exec(process.execPath,[cli,'check','examples/wrangler.jsonc'],{cwd:root})).stdout);
  assert.equal(checked.result.outcome,'pass');
  const client=new Client({name:'portable-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--root',root],stderr:'pipe'}));
    assert.equal((await client.listTools()).tools.length,1);
    assert.deepEqual((await client.callTool({name:'wrangler_config_check',arguments:{configPath:'examples/wrangler.jsonc'}})).structuredContent,checked);
  } finally {await client.close();}
});
