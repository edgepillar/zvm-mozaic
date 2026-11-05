import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'

// These are explicit memory capabilities, not Vue compilation, image decoding,
// a browser, storage, a wallet or a node. Both actual scripts are tested below.
// Getter watches compare their result by identity; explicit source arrays compare
// members. Only dependency changes schedule callbacks. This follows the relevant
// distinction in Vue 3.5.43 watch.ts; this port is not the Vue runtime.
const tick = async () => {for (let i = 0; i < 12; i++) await Promise.resolve()}
function vuePorts() {
  const watches=[], refs=[], unmounted=[], dependencies=new WeakMap()
  let collecting=null, flushing=false
  const dependency=(target,key)=>{
    let fields=dependencies.get(target)
    if(!fields){fields=new Map();dependencies.set(target,fields)}
    if(!fields.has(key))fields.set(key,{version:0})
    return fields.get(key)
  }
  const collect=get=>{
    const before=collecting, deps=new Set();collecting=deps
    try{return {value:get(),deps}}finally{collecting=before}
  }
  const read=watch=>{const result=collect(watch.get);watch.deps=result.deps;return result.value}
  const changed=(watch,next)=>watch.multiple ? next.some((value,i)=>!Object.is(value,watch.old[i])) : !Object.is(next,watch.old)
  const flush=(sync=false)=>{
    if(flushing)return
    flushing=true
    try{
      for(let rounds=0;;rounds++){
        const ready=watches.filter(w=>w.active && w.dirty && (!sync || w.opts?.flush==='sync'))
        if(!ready.length)break
        if(rounds>=32)throw new Error('The declared memory watcher capabilities did not settle')
        for(const w of ready){
          w.dirty=false;const next=read(w)
          if(changed(w,next)){const old=w.old;w.old=next;w.fn(next,old)}
        }
      }
    }finally{flushing=false}
  }
  const reactive=object=>new Proxy(object,{
    get(target,key,receiver){const dep=dependency(target,key);collecting?.add(dep);return Reflect.get(target,key,receiver)},
    set(target,key,value){
      if(Object.is(target[key],value))return true
      target[key]=value;const dep=dependency(target,key);dep.version++
      for(const w of watches)if(w.deps.has(dep))w.dirty=true
      flush(true);return true
    }
  })
  const ref=value=>{const item=reactive({value});refs.push(item);return item}
  const computed=get=>{
    let available=false,value,versions=new Map()
    return {get value(){
      if(!available || [...versions].some(([dep,version])=>dep.version!==version)){
        const result=collect(get);value=result.value;versions=new Map([...result.deps].map(dep=>[dep,dep.version]));available=true
      }
      for(const dep of versions.keys())collecting?.add(dep)
      return value
    }}
  }
  const watch=(source,fn,opts)=>{
    const multiple=Array.isArray(source)
    const get=typeof source==='function' ? source : multiple ? ()=>source.map(value=>typeof value==='function' ? value() : value.value) : ()=>source.value
    const row={get,fn,opts,multiple,deps:new Set(),dirty:false,active:true,old:undefined}
    row.old=read(row);watches.push(row)
    if(opts?.immediate)fn(row.old,undefined)
  }
  return {vue:{reactive,ref,shallowRef:ref,computed,watch,onBeforeUnmount:fn=>unmounted.push(fn)},flush,refs,
    unmount(){unmounted.forEach(fn=>fn());watches.forEach(w=>{w.active=false})}}
}
async function moduleWithPorts(code,ports,globals,identifier) {
  const context=createContext({console,Promise,AbortController,DOMException,Uint8ClampedArray,...globals})
  const cached=new Map()
  const module=new SourceTextModule(stripTypeScriptTypes(code,{mode:'strip'}),{context,identifier})
  await module.link(name=>{
    if(!ports[name]) throw new Error('Undeclared import capability: '+name)
    if(!cached.has(name)) {
      const values=ports[name]
      cached.set(name,new SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value)},{context,identifier:name}))
    }
    return cached.get(name)
  })
  await module.evaluate();return module.namespace
}
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}

export async function dialogFixture() {
  const v=vuePorts(), requests=[], disposed=[], emissions=[], stamp={value:null}, guide={picture:null,x:0,y:0,visible:false}
  const props=v.vue.reactive({open:false,file:null,at:{x:50,y:60}})
  const ports={vue:v.vue,'../core/image':{
    decode(file,signal) {const d=deferred();requests.push({file,signal,...d});return d.promise},
    disposeDecoded(value) {if(value)disposed.push(value.id)},guide,stamp,
    scaled(value,width,name) {return {name,w:width,h:Math.round(width*value.height/value.width),canvas:{id:value.id}}},
    pixelsOf:()=>[{x:0,y:0,rgb:1}]},
    '../core/endpoint':{endpoint:{canvas:null}},'../core/format':{number:String,units:String},
    './Modal.vue':{default:{}},'./Icon.vue':{default:{}}}
  const source=readFileSync(new URL('../src/components/ImportDialog.vue',import.meta.url),'utf8')
  const script=/<script setup lang="ts">([\s\S]*?)<\/script>/.exec(source)?.[1]
  if(!script)throw new Error('Actual import dialog script missing')
  const tail=`\nexport const __calls={load,finish,asStamp,asGuide,pick};
export function __state(){return {bitmap:bitmap.value,name:name.value,width:width.value,error:error.value,picture:picture.value}}
export function __fileInput(value){input.value=value}
`
  const namespace=await moduleWithPorts(script+tail,ports,{defineProps:()=>props,defineEmits:()=>type=>{emissions.push(type);if(type==='close')props.open=false}},'actual-import-dialog-script')
  let pickerClicks=0
  namespace.__fileInput({click(){pickerClicks++}})
  const flush=async()=>{await tick();v.flush();await tick()}
  return {props,requests,disposed,emissions,stamp,guide,flush,
    pickerCount:()=>pickerClicks,
    setBatch(file){props.open=true;props.file=file;v.flush()},
    select(file){props.file=file;props.open=true;v.flush()},
    choose(file){namespace.__calls.pick({target:{files:[file],value:'selected'}});v.flush()},
    calls:namespace.__calls,state:()=>namespace.__state(),
    resolve(i,id='image-'+i,width=8,height=4){requests[i].resolve({id,width,height,source:{id},vector:false})},
    reject(i,message='Controlled image failure'){requests[i].reject(new Error(message))},
    unmount(){v.unmount()}}
}

export async function imageFixture() {
  const v=vuePorts(), urls=new Map(), revoked=[], images=[], bitmaps=[], timers=[]
  let next=0
  class ImagePort {
    constructor(){this.naturalWidth=8;this.naturalHeight=4;this.src='';images.push(this)}
    decode(){this.pending=deferred();return this.pending.promise}
  }
  const globals={Image:ImagePort,Blob,File,URL:{
    createObjectURL(blob){const url='blob:memory-'+(++next);urls.set(url,blob);return url},
    revokeObjectURL(url){revoked.push(url);urls.delete(url)}},
    setTimeout(fn,delay){timers.push({fn,delay});return timers.length},
    createImageBitmap(image){const d=deferred(),result={image,closed:0,close(){this.closed++}};bitmaps.push({image,result,...d});return d.promise},
    document:{createElement(name){if(name!=='canvas')throw new Error('Undeclared image element');return {width:0,height:0,getContext(){return {drawImage(){},getImageData(){return {data:new Uint8ClampedArray([1,2,3,255])}}}}}}}}
  const source=readFileSync(new URL('../src/core/image.ts',import.meta.url),'utf8')
  const namespace=await moduleWithPorts(source,{vue:v.vue},globals,'actual-image-module')
  return {module:namespace,urls,revoked,images,bitmaps,timers,
    flush:tick,
    ready(i=images.length-1,width=8,height=4){images[i].naturalWidth=width;images[i].naturalHeight=height;images[i].pending.resolve()},
    bad(i=images.length-1){images[i].pending.reject(new Error('Controlled decoder failure'))},
    bitmap(i=bitmaps.length-1){bitmaps[i].resolve(bitmaps[i].result);return bitmaps[i].result},
    timersRun(){timers.splice(0).forEach(timer=>timer.fn())}}
}
