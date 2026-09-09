import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,symlink,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {check,parseConfig,diagnose,readableRoot,canonical} from '../src/core.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const exec=promisify(callback);
const cli=path.resolve(import.meta.dirname,'../src/cli.mjs');
const clean={name:'example',compatibility_date:'2026-09-01'};
async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'doctor-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root:await readableRoot(root),write:async (name,value)=>writeFile(path.join(root,name),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value))};
}
test('TOML, JSON and JSONC parse to the same checks; JSON stays strict',()=>{
  const inputs=[['toml','name="example"\ncompatibility_date="2026-09-01"'],['json',JSON.stringify(clean)],['jsonc','{/*comment*/"name":"example","compatibility_date":"2026-09-01",}']];
  for(const [format,text] of inputs) assert.deepEqual(diagnose(parseConfig(Buffer.from(text),format)),[]);
  for(const text of ['{"x":1,}','{/*x*/"x":1}','{','[]','{"x":1,"x":2}','{"a":{"x":1,"x":2}}']) assert.throws(()=>parseConfig(Buffer.from(text),'json'));
  assert.throws(()=>parseConfig(Buffer.from('x=1\nx=2'),'toml'),/DUPLICATE_KEY/);
  assert.throws(()=>parseConfig(Buffer.from([255]),'json'),/CONFIG_PARSE_ERROR/);
  assert.throws(()=>parseConfig(Buffer.alloc(1024*1024+1),'json'),/ANALYSIS_LIMIT/);
});
test('each diagnostic catches its intended hazard with static paths/messages',()=>{
  const examples=[
    {compatibility_date:'2026-02-30'},
    {route:'private.example/*',routes:[]},
    {r2_buckets:[{binding:'X'}],d1_databases:[{binding:'X'}]},
    {vars:{MODE:'prod'},env:{stage:{}}},
    {migrations:[{tag:'v1',new_classes:['A'],deleted_classes:['A']}]},
    {assets:{directory:'dist'},site:{bucket:'dist'}},
    {observability:{enabled:true,head_sampling_rate:2}},
    {vars:{VERY_PRIVATE_API_TOKEN:'SECRET_VALUE'}}
  ];
  examples.forEach((x,i)=>{
    const d=diagnose({...clean,...x},i===3?'stage':undefined);
    assert.ok(d.some(v=>v.code===`WCD00${i+1}`));
    assert.doesNotMatch(JSON.stringify(d),/private\.example|VERY_PRIVATE|SECRET_VALUE/);
  });
  assert.deepEqual(diagnose({...clean,observability:{logs:{enabled:true}},future_property:{anything:1}}),[]);
  assert.deepEqual(diagnose({...clean,migrations:[{tag:'v1',new_classes:['A']},{tag:'v2',deleted_classes:['A']}]}),[]);
  assert.ok(diagnose({...clean,migrations:[{tag:'v1'},{tag:'v1'}]}).some(d=>d.code==='WCD005'));
});
test('environments inherit routes/triggers/date, omit bindings, and respect explicit route overrides',()=>{
  const config={...clean,route:'example.com/*',triggers:{crons:['0 * * * *']},r2_buckets:[{binding:'BUCKET'}],env:{stage:{routes:[]}}};
  assert.deepEqual(diagnose(config,'stage').map(d=>[d.code,d.path]),[['WCD004','env.*.r2_buckets']]);
  assert.throws(()=>diagnose(config,'missing'),/ENVIRONMENT_NOT_FOUND/);
  assert.throws(()=>diagnose({...clean,env:Object.fromEntries(Array.from({length:65},(_,i)=>['e'+i,{}]))}),/ANALYSIS_LIMIT/);
  assert.throws(()=>diagnose({...clean,r2_buckets:Array.from({length:257},(_,i)=>({binding:'B'+i}))}),/ANALYSIS_LIMIT/);
});
test('read paths reject escapes, symlinks, directories, wrong filenames and oversized files',async t=>{
  const {root,write}=await fixture(t);await write('wrangler.json',clean);
  for(const p of ['../wrangler.json','/wrangler.json','x\\wrangler.json','./wrangler.json','Wrangler.json','.env']) await assert.rejects(check(root,p),/UNSAFE/);
  await mkdir(path.join(root,'child'));await symlink(path.join(root,'wrangler.json'),path.join(root,'child','wrangler.json'));
  await assert.rejects(check(root,'child/wrangler.json'),/UNSAFE/);
  await symlink(path.join(root,'child'),path.join(root,'alias'));
  await assert.rejects(check(root,'alias/wrangler.json'),/UNSAFE/);
  await assert.rejects(readableRoot(path.join(root,'alias')),/UNSAFE_ROOT/);
  await write('wrangler.toml',Buffer.alloc(1024*1024+1));await assert.rejects(check(root,'wrangler.toml'),/ANALYSIS_LIMIT/);
  await exec('/usr/bin/mkfifo',[path.join(root,'wrangler.jsonc')]);await assert.rejects(check(root,'wrangler.jsonc'),/UNSAFE/);
});
test('CLI output is deterministic, secret-safe, strict policy changes only outcome, and files are unchanged',async t=>{
  const {root,write}=await fixture(t);
  await write('wrangler.json',{...clean,vars:{API_TOKEN:'never-echo-me'},$schema:'https://private.example/schema',build:{command:'touch MUST_NOT_EXIST'}});
  const before=await readFile(path.join(root,'wrangler.json'));
  const a=await check(root,'wrangler.json');const b=await check(root,'wrangler.json',{strict:true});
  assert.equal(a.result.outcome,'pass');assert.equal(b.result.outcome,'fail');assert.deepEqual(a.result.diagnostics,b.result.diagnostics);
  const one=await exec(process.execPath,[cli,'check','wrangler.json'],{cwd:root});
  const two=await exec(process.execPath,[cli,'check','wrangler.json'],{cwd:root});
  assert.equal(one.stdout,two.stdout);assert.equal(one.stdout,canonical(a));assert.equal(one.stderr,'');
  assert.doesNotMatch(one.stdout,/never-echo-me|API_TOKEN|private\.example|touch MUST/);
  assert.deepEqual(await readFile(path.join(root,'wrangler.json')),before);
  await assert.rejects(readFile(path.join(root,'MUST_NOT_EXIST')));
  await assert.rejects(exec(process.execPath,[cli,'check','wrangler.json','--strict'],{cwd:root}),e=>e.code===2);
  await assert.rejects(exec(process.execPath,[cli,'check','../wrangler.json'],{cwd:root}),e=>e.code===64 && e.stdout==='' && e.stderr==='UNSAFE_CONFIG_PATH\n');
  const bin=path.join(root,'doctor');await symlink(cli,bin);
  assert.equal((await exec(process.execPath,[bin,'--version'])).stdout,'0.1.0\n');
});
test('real stdio MCP exposes one tool and matches CLI evidence',async t=>{
  const {root,write}=await fixture(t);await write('wrangler.json',clean);
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--root',root],stderr:'pipe'});
  const client=new Client({name:'doctor-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['wrangler_config_check']);
    const result=await client.callTool({name:'wrangler_config_check',arguments:{configPath:'wrangler.json'}});
    assert.deepEqual(result.structuredContent,await check(root,'wrangler.json'));
    const invalid=await client.callTool({name:'wrangler_config_check',arguments:{configPath:'wrangler.json',token:'never-echo-token'}});
    assert.equal(invalid.isError,true);assert.doesNotMatch(JSON.stringify(invalid),/never-echo-token/);
  } finally {await client.close();}
});
