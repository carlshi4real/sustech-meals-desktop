import { packager } from '@electron/packager';
import path from 'node:path';
const platform=process.argv[2]||'darwin';
const arch=process.argv[3]||(platform==='win32'?'x64':'arm64');
const out=await packager({dir:'.',name:'南科饭钱',appBundleId:'app.sustech.meals.desktop',platform,arch,out:path.resolve('../../work/desktop-build'),overwrite:true,asar:true,ignore:[/^\/tests/,/^\/scripts/],download:{cacheRoot:path.resolve('../../work/electron-cache')}});
console.log(out.join('\n'));
