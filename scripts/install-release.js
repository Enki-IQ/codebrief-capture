#!/usr/bin/env node
import {homedir} from 'node:os';
import {installCaptureRelease} from './lib/release-installation.js';
const args=process.argv.slice(2);
try {
 if(args.length!==4||args[0]!=='--source'||args[2]!=='--manifest-sha256'||!args[1]||!/^[a-f0-9]{64}$/.test(args[3]))throw Error('capture_installation_usage: --source <reviewed-local-artifact> --manifest-sha256 <trusted-published-sha256>');
 const result=installCaptureRelease({source:args[1],manifestSha256:args[3],home:homedir()});
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
