const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('wallet',Object.fromEntries(['load','settings','add','toggle','remove','school','scan','backup','restore','cancelSync'].map(name=>[name,(arg)=>ipcRenderer.invoke('wallet:'+name,arg)])));

contextBridge.exposeInMainWorld('syncEvents',{onProgress:callback=>{ipcRenderer.on('sync-progress',(_event,message)=>callback(message));}});
