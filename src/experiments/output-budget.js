/** Per-attempt output reservation shared by all concurrent model calls. */
export function createOutputBudget({maxTokens,totalOutputTokens}) {
  if(!Number.isSafeInteger(maxTokens)||maxTokens<1||!Number.isSafeInteger(totalOutputTokens)||totalOutputTokens<maxTokens) throw Error('Invalid output token budget')
  let used=0,held=0,violated=false
  async function* meter(dispatch,options) {
    if(violated||used+held+maxTokens>totalOutputTokens) throw Error('Attempt output-token budget exceeded')
    held+=maxTokens
    let output=null,finished=false,exhausted=false
    try {
      for await(const chunk of dispatch(options)) {
        if(chunk.type==='usage')output=chunk.usage?.outputTokens
        if(chunk.type==='finish')finished=['stop','tool-calls','max-tokens'].includes(chunk.reason?.kind)
        yield chunk
      }
      exhausted=true
    }finally{
      if(exhausted&&finished&&Number.isSafeInteger(output)&&output>=0){
        held-=maxTokens;used+=output
        if(output>maxTokens||used+held>totalOutputTokens){violated=true;throw Error('Provider exceeded output-token reservation')}
      }
    }
  }
  return {
    snapshot:()=>({maxTokens,totalOutputTokens,used,held,violated}),
    wrap:adapter=>new Proxy(adapter,{get(target,property){
      if(property==='stream')return options=>meter(request=>target.stream(request),options)
      if(property==='prepareCall')return async(...args)=>{
        const prepared=await target.prepareCall(...args)
        return {...prepared,stream:options=>meter(request=>prepared.stream(request),options)}
      }
      const value=Reflect.get(target,property,target)
      return typeof value==='function'?value.bind(target):value
    }}),
  }
}
