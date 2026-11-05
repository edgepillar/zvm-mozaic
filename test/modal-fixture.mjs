import {readFileSync} from 'node:fs'
import {vuePorts, moduleWithPorts} from './import-fixture.mjs'

// A declared memory-only dialog/event queue and Vue port. This executes the
// actual SFC script and checks its template binding; it does not compile Vue
// or exercise a browser, native focus, native dialog events or a wallet.
export async function modalFixture() {
  const v=vuePorts(), props=v.vue.reactive({open:false,title:'Controlled modal'}), emissions=[], queued=[]
  let shows=0, closes=0
  const dialog={open:false,
    showModal(){if(this.open)throw new Error('The memory native dialog was already open');this.open=true;shows++},
    close(){if(!this.open)return;this.open=false;closes++;queued.push('parent-close')},
  }
  const source=readFileSync(new URL('../src/components/Modal.vue',import.meta.url),'utf8')
  const script=/<script setup lang="ts">([\s\S]*?)<\/script>/.exec(source)?.[1]
  const binding=/^\s+@close="([^"]+)"/m.exec(source)?.[1]
  if(!script || !["emit('close')",'nativeClosed'].includes(binding))throw new Error('The declared modal close binding is unavailable')
  const call=binding==='nativeClosed' ? 'nativeClosed()' : binding
  const tail=`\nexport function __element(value){el.value=value}\nexport function __close(){${call}}\n`
  const emit=type=>{emissions.push(type);if(type==='close')props.open=false}
  const namespace=await moduleWithPorts(script+tail,{vue:v.vue,'./Icon.vue':{default:{}}},
    {defineProps:()=>props,defineEmits:()=>emit},'actual-modal-script')
  namespace.__element(dialog)
  return {props,dialog,emissions,
    setOpen(value){props.open=value;v.flush()},
    nativeClose(){if(!dialog.open)throw new Error('There is no current memory dialog to close');dialog.open=false;queued.push('native-close')},
    deliver(){if(!queued.length)throw new Error('There is no queued memory close notification');const cause=queued.shift();namespace.__close();v.flush();return cause},
    detach(){namespace.__element(null);v.flush()},
    counts(){return {shows,closes,queued:queued.length}},
    unmount(){v.unmount()},
  }
}
