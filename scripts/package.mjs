import { packager } from '@electron/packager';
import path from 'node:path';
const arch=process.argv[2]||'arm64';
const out=await packager({dir:'.',name:'南科饭钱',appBundleId:'app.sustech.meals.desktop',platform:'darwin',arch,out:path.resolve('../../work/desktop-build'),overwrite:true,asar:true,ignore:[/^\/tests/,/^\/scripts/],download:{cacheRoot:path.resolve('../../work/electron-cache')}});
console.log(out.join('\n'));
