import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cargo=spawnSync('cargo',['build','--release','--locked','--manifest-path',resolve(root,'../vocal-engine/Cargo.toml')],{cwd:root,stdio:'inherit',windowsHide:true});
if(cargo.status!==0)throw new Error('Vocal Engine Release build failed');
const binary=resolve(root,'../vocal-engine/target/release/king-vocal-engine.exe');
const destination=resolve(root,'.local-tools/vocal-engine');
mkdirSync(destination,{recursive:true});
copyFileSync(binary,resolve(destination,'king-vocal-engine.exe'));
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});
const source=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','src','src-tauri','scripts','public','package.json','package-lock.json','vite.config.mjs','../vocal-engine/src','../vocal-engine/Cargo.toml','../vocal-engine/Cargo.lock'],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
if(git.status!==0||source.status!==0)throw new Error('Unable to record build source identity');
const hash=createHash('sha256');
for(const path of [...new Set(source.stdout.split('\0').filter(Boolean))].sort()){
  const bytes=readFileSync(resolve(root,path));
  hash.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes);
}
writeFileSync(resolve(root,'public/build-info.json'),JSON.stringify({builtAt:new Date().toISOString(),commit:git.stdout.trim(),sourceTreeSha256:hash.digest('hex'),vocalEngineSha256:createHash('sha256').update(readFileSync(binary)).digest('hex')},null,2));
