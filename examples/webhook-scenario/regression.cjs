const {test}=require('node:test')
const assert=require('node:assert/strict')
const {version,createApi}=require('./app.cjs')
const {createStore}=require('./store.cjs')
test('existing version and health stay compatible',()=>{
 assert.equal(version(),1)
 assert.deepEqual(createApi({store:createStore()}).handle({method:'GET',path:'/health'}),{status:200,body:{ok:true,version:1}})
})
test('unknown route keeps 404',()=>{
 assert.equal(createApi({store:createStore()}).handle({method:'GET',path:'/unknown'}).status,404)
})
