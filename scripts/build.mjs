import {build} from 'esbuild';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,utimes,chmod,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(callback);
export const ROOT='wrangler-config-doctor-v0.1.0';
export const FILES=['LICENSE','README.md','THIRD_PARTY_NOTICES.md','rule-pack.json','examples/wrangler.jsonc',
  'licenses/jsonc-parser.txt','licenses/smol-toml.txt','licenses/mcp-server.txt','licenses/mcp-core.txt','licenses/zod.txt',
  'wrangler-config-doctor.mjs'].map(p=>`${ROOT}/${p}`).sort();
const packageRoot=path.resolve(import.meta.dirname,'..');
const licensePaths={
  'jsonc-parser':'jsonc-parser/LICENSE.md','smol-toml':'smol-toml/LICENSE',
  'mcp-server':'@modelcontextprotocol/server/LICENSE','mcp-core':'@modelcontextprotocol/core/LICENSE','zod':'zod/LICENSE'
};
export async function buildZip(outDir=path.join(packageRoot,'dist')) {
  await mkdir(outDir,{recursive:true});
  const stage=await mkdtemp(path.join(outDir,'.stage-'));
  const root=path.join(stage,ROOT);
  try {
    await mkdir(path.join(root,'licenses'),{recursive:true});
    await mkdir(path.join(root,'examples'));
    await build({entryPoints:[path.join(packageRoot,'src/cli.mjs')],outfile:path.join(root,'wrangler-config-doctor.mjs'),
      bundle:true,platform:'node',format:'esm',target:'node22',mainFields:['module','main'],legalComments:'none',logLevel:'silent',sourcemap:false});
    for(const f of ['LICENSE','README.md','rule-pack.json','examples/wrangler.jsonc']) await copyFile(path.join(packageRoot,f),path.join(root,f));
    let notices='# Third-party notices\n\nBundled dependencies retain their licenses. Original Valen Systems code is MIT.\n\n';
    for(const [name,source] of Object.entries(licensePaths)) {
      const data=await readFile(path.join(packageRoot,'node_modules',source));
      await writeFile(path.join(root,'licenses',name+'.txt'),data);
      const pkg=JSON.parse(await readFile(path.join(packageRoot,'node_modules',path.dirname(source),'package.json'),'utf8'));
      notices+=`- ${pkg.name} ${pkg.version}: metadata license ${pkg.license}; exact text in licenses/${name}.txt; SHA-256 ${createHash('sha256').update(data).digest('hex')}.\n`;
    }
    notices+='\nMCP license text includes its upstream Apache-2.0-to-MIT transition. Read the supplied license. esbuild is a build-only dependency and is not shipped.\n';
    await writeFile(path.join(root,'THIRD_PARTY_NOTICES.md'),notices);
    for(const f of FILES) {await chmod(path.join(stage,f),0o644);await utimes(path.join(stage,f),946684800,946684800);}
    const temporary=path.join(stage,'archive.zip');
    await exec('/usr/bin/zip',['-X','-q',temporary,...FILES],{cwd:stage});
    const bytes=await readFile(temporary);const hash=createHash('sha256').update(bytes).digest('hex');
    const archive=path.join(outDir,ROOT+'.zip');
    await writeFile(archive,bytes);await writeFile(archive+'.sha256',`${hash}  ${ROOT}.zip\n`);
    return {archive,bytes:bytes.length,sha256:hash};
  } finally {await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildZip()));
