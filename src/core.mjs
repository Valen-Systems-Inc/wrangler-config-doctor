import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {parse as parseJson, visit} from 'jsonc-parser';
import {parse as parseToml} from 'smol-toml';
import rulePack from '../rule-pack.json' with {type: 'json'};

export const VERSION = '0.1.0';
const MAX_BYTES = 1024 * 1024;
export class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const bad = code => { throw new InputError(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const own = (x, key) => Object.hasOwn(x, key);
const cmp = (a,b) => {
  const aa = [...a], bb = [...b];
  for (let i=0;i<Math.min(aa.length,bb.length);i++) {
    const d=aa[i].codePointAt(0)-bb[i].codePointAt(0); if(d) return d;
  }
  return aa.length-bb.length;
};
export function canonical(value) {
  const sorted = x => Array.isArray(x) ? x.map(sorted) : object(x) ?
    Object.fromEntries(Object.keys(x).sort(cmp).map(k=>[k, sorted(x[k])])) : x;
  return JSON.stringify(sorted(value), null, 2)+'\n';
}
export function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/[:\\\u0000-\u001f\u007f]/u.test(value) && !path.isAbsolute(value) &&
    value.split('/').every(p=>p && p!=='.' && p!=='..') &&
    ['wrangler.toml','wrangler.json','wrangler.jsonc'].includes(path.basename(value));
}
export async function readableRoot(root) {
  try {
    const resolved = path.resolve(root);
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) bad('UNSAFE_ROOT');
    return await realpath(resolved);
  } catch { bad('UNSAFE_ROOT'); }
}
async function readConfig(root, relative) {
  if (!safePath(relative)) bad('UNSAFE_CONFIG_PATH');
  let current = root;
  try {
    const segments=relative.split('/');
    for (let i=0;i<segments.length;i++) {
      current=path.join(current,segments[i]);
      const info=await lstat(current);
      if(info.isSymbolicLink() || (i<segments.length-1 ? !info.isDirectory() : !info.isFile())) bad('UNSAFE_CONFIG_PATH');
    }
    const resolved=await realpath(current);
    if (!resolved.startsWith(root+path.sep) && !(root===path.parse(root).root && resolved.startsWith(root))) bad('UNSAFE_CONFIG_PATH');
    const file=await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info=await file.stat();
      if(!info.isFile()) bad('UNSAFE_CONFIG_PATH');
      if(info.size>MAX_BYTES) bad('ANALYSIS_LIMIT_EXCEEDED');
      const buffer=Buffer.alloc(MAX_BYTES+1);
      let count=0;
      while(count<buffer.length) {
        const {bytesRead}=await file.read(buffer,count,buffer.length-count,null);
        if(!bytesRead) break; count+=bytesRead;
      }
      if(count>MAX_BYTES) bad('ANALYSIS_LIMIT_EXCEEDED');
      return buffer.subarray(0,count);
    } finally { await file.close(); }
  } catch(e) { if(e instanceof InputError) throw e; bad('CONFIG_READ_ERROR'); }
}
export function parseConfig(bytes, format) {
  if(bytes.length>MAX_BYTES) bad('ANALYSIS_LIMIT_EXCEEDED');
  let text, data;
  try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { bad('CONFIG_PARSE_ERROR'); }
  try {
    if(format==='toml') data=parseToml(text);
    else {
      const stack=[]; let depth=0;
      const options={disallowComments:format==='json',allowTrailingComma:format==='jsonc'};
      visit(text, {
        onObjectBegin(){ if(++depth>64) bad('ANALYSIS_LIMIT_EXCEEDED'); stack.push(new Set()); },
        onObjectProperty(key){const keys=stack.at(-1); if(keys.has(key)) bad('DUPLICATE_KEY'); keys.add(key);},
        onObjectEnd(){stack.pop();depth--;},
        onArrayBegin(){if(++depth>64) bad('ANALYSIS_LIMIT_EXCEEDED');},
        onArrayEnd(){depth--;}
      },options);
      const errors=[]; data=parseJson(text,errors,options);
      if(errors.length) bad('CONFIG_PARSE_ERROR');
    }
  } catch(e) {
    if(e instanceof InputError) throw e;
    if(format==='toml' && /duplicate|already defined|redefine/i.test(e.message)) bad('DUPLICATE_KEY');
    bad('CONFIG_PARSE_ERROR');
  }
  if(!object(data)) bad('CONFIG_PARSE_ERROR');
  const pending=[[data,0]]; let nodes=0;
  while(pending.length) {
    const [x,depth]=pending.pop();
    if(++nodes>50000 || depth>64) bad('ANALYSIS_LIMIT_EXCEEDED');
    if(x && typeof x==='object') {
      if(!Array.isArray(x) && !object(x)) bad('CONFIG_PARSE_ERROR');
      for(const v of Object.values(x)) pending.push([v,depth+1]);
    } else if(typeof x==='number' && !Number.isFinite(x)) bad('CONFIG_PARSE_ERROR');
  }
  return data;
}

const arrays=['kv_namespaces','r2_buckets','d1_databases','vectorize','hyperdrive','services',
  'analytics_engine_datasets','mtls_certificates','dispatch_namespaces','workflows','pipelines',
  'secrets_store_secrets'];
const singles=['ai','browser','images','version_metadata'];
const nonInherited=[...arrays,...singles,'vars','define','durable_objects','queues','send_email'];
const messages={
  WCD001:'Set a valid compatibility_date; dates beyond this rule pack need a newer reference.',
  WCD002:'Choose either route or routes in this configuration.',
  WCD003:'Use unique names for supported bindings and variables; check binding field shapes.',
  WCD004:'This top-level category is not inherited. Declare it in the selected environment if needed.',
  WCD005:'Migration tags must be unique and operations within each migration must not conflict.',
  WCD006:'Check assets/site usage and the assets directory. A build plugin may supply the directory.',
  WCD007:'Set observability enabled (or logs/traces enabled) and use sampling rates between 0 and 1.',
  WCD008:'Possible credential variable detected. Store secrets outside vars; no keys or values are reported.'
};

export function diagnose(config, environment) {
  if(config.env!==undefined && !object(config.env)) bad('INVALID_ENVIRONMENTS');
  if(Object.keys(config.env??{}).length>64) bad('ANALYSIS_LIMIT_EXCEEDED');
  if(environment!==undefined && (typeof environment!=='string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(environment))) bad('INVALID_ENVIRONMENT');
  let selected=config, prefix='';
  const diagnostics=[];
  const emit=(code, severity, at)=>{
    if(diagnostics.length>=1000) bad('ANALYSIS_LIMIT_EXCEEDED');
    diagnostics.push({code,severity,path:at,message:messages[code]});
  };
  if(environment!==undefined) {
    if(!own(config.env??{},environment) || !object(config.env[environment])) bad('ENVIRONMENT_NOT_FOUND');
    const env=config.env[environment]; prefix='env.*.';
    selected={...config,...env};
    for(const key of nonInherited) {
      if(!own(env,key)) {
        delete selected[key];
        if(own(config,key)) emit('WCD004','warning',prefix+key);
      }
    }
  }
  const date=selected.compatibility_date;
  const validDate=typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/u.test(date) &&
    Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
  if(!validDate) emit('WCD001','error',prefix+'compatibility_date');
  else if(date>rulePack.coverageDate) emit('WCD001','warning',prefix+'compatibility_date');
  // Wrangler's mutual-exclusion validator checks the raw scope being validated.
  const routeScope=environment===undefined?config:config.env[environment];
  if(own(routeScope,'route') && own(routeScope,'routes')) emit('WCD002','error',prefix+'routes');

  const seen=new Set(); let inspected=0;
  const name=(value,at)=>{
    if(++inspected>256) bad('ANALYSIS_LIMIT_EXCEEDED');
    if(typeof value!=='string' || !value || seen.has(value)) emit('WCD003','error',prefix+at);
    else seen.add(value);
  };
  const bindings=(value,key,at)=>{
    if(value===undefined) return;
    if(!Array.isArray(value)) {emit('WCD003','error',prefix+at); return;}
    for(const item of value) name(object(item)?item[key]:undefined,at);
  };
  for(const key of arrays) bindings(selected[key],'binding',key);
  for(const key of singles) if(own(selected,key)) name(selected[key]?.binding,key);
  if(own(selected,'durable_objects')) {
    if(!object(selected.durable_objects) || !Array.isArray(selected.durable_objects.bindings)) emit('WCD003','error',prefix+'durable_objects.bindings');
    else bindings(selected.durable_objects.bindings,'name','durable_objects.bindings');
  }
  if(own(selected,'queues')) {
    if(!object(selected.queues)) emit('WCD003','error',prefix+'queues');
    else bindings(selected.queues.producers,'binding','queues.producers');
  }
  bindings(selected.send_email,'name','send_email');
  if(object(selected.assets) && own(selected.assets,'binding')) name(selected.assets.binding,'assets.binding');
  if(own(selected,'vars')) {
    if(!object(selected.vars)) emit('WCD003','error',prefix+'vars');
    else {
      for(const key of Object.keys(selected.vars)) name(key,'vars');
      if(Object.keys(selected.vars).some(k=>/(?:secret|password|token|private[_-]?key|api[_-]?key|credential)/iu.test(k))) emit('WCD008','warning',prefix+'vars');
    }
  }
  if(own(selected,'migrations')) {
    const tags=new Set();
    if(!Array.isArray(selected.migrations)) emit('WCD005','error',prefix+'migrations');
    else for(const migration of selected.migrations) {
      if(++inspected>256) bad('ANALYSIS_LIMIT_EXCEEDED');
      if(!object(migration) || typeof migration.tag!=='string' || !migration.tag || tags.has(migration.tag)) {emit('WCD005','error',prefix+'migrations');continue;}
      tags.add(migration.tag); const classes=new Set();
      const operation=c=>{
        if(++inspected>256) bad('ANALYSIS_LIMIT_EXCEEDED');
        if(typeof c!=='string' || !c || classes.has(c)) emit('WCD005','error',prefix+'migrations');
        else classes.add(c);
      };
      for(const field of ['new_classes','new_sqlite_classes','deleted_classes']) if(own(migration,field)) {
        if(!Array.isArray(migration[field])) emit('WCD005','error',prefix+'migrations');
        else migration[field].forEach(operation);
      }
      if(own(migration,'renamed_classes')) {
        if(!Array.isArray(migration.renamed_classes)) emit('WCD005','error',prefix+'migrations');
        else for(const pair of migration.renamed_classes) {operation(pair?.from);operation(pair?.to);}
      }
    }
  }
  if(own(selected,'assets')) {
    if(own(selected,'site') || !object(selected.assets) ||
      (own(selected.assets,'directory') && (typeof selected.assets.directory!=='string' || !selected.assets.directory.trim()))) emit('WCD006','error',prefix+'assets');
    else if(!own(selected.assets,'directory')) emit('WCD006','warning',prefix+'assets.directory');
  }
  if(own(selected,'observability')) {
    const obs=selected.observability;
    let valid=object(obs);
    if(valid) {
      valid=[obs.enabled,obs.logs?.enabled,obs.traces?.enabled].some(x=>typeof x==='boolean');
      for(const section of [obs,obs.logs,obs.traces]) {
        if(section===undefined) continue;
        if(!object(section)) {valid=false;continue;}
        if(own(section,'enabled') && typeof section.enabled!=='boolean') valid=false;
        const rate=section.head_sampling_rate;
        if(rate!==undefined && (typeof rate!=='number' || !Number.isFinite(rate) || rate<0 || rate>1)) valid=false;
      }
    }
    if(!valid) emit('WCD007','error',prefix+'observability');
  }
  return diagnostics.sort((a,b)=>({error:0,warning:1,info:2}[a.severity]-{error:0,warning:1,info:2}[b.severity]) || cmp(a.code,b.code) || cmp(a.path,b.path));
}

/** @param {string} root @param {string} configPath @param {{environment?:string,strict?:boolean}} [options] */
export async function check(root, configPath, {environment,strict=false}={}) {
  if(typeof strict!=='boolean') bad('INVALID_POLICY');
  const bytes=await readConfig(root,configPath);
  const format=path.extname(configPath).slice(1);
  const diagnostics=diagnose(parseConfig(bytes,format),environment);
  const summary={errors:0,warnings:0,info:0,total:diagnostics.length};
  for(const d of diagnostics) summary[{error:'errors',warning:'warnings',info:'info'}[d.severity]]++;
  return {schemaVersion:1,tool:'wrangler-config-doctor',toolVersion:VERSION,rulePack,
    input:{path:configPath,format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
    policy:{strict,environment:environment??null},
    result:{outcome:summary.errors || (strict && summary.warnings)?'fail':'pass',diagnostics,summary}};
}
