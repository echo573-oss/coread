import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { tools, handleTool } from './mcp-tools.mjs';
import { runAs, AI } from './identity.mjs';

export function validateTool(name,args){
  const tool=tools.find(t=>t.name===name);
  if(!tool)throw Error('Unknown tool');
  const shape={};
  for(const [key,prop] of Object.entries(tool.inputSchema.properties||{})){
    let validator=prop.type==='number'?z.number().int().min(key==='paragraph_idx'?0:1).max(key==='limit'?100:Number.MAX_SAFE_INTEGER)
      : z.string().max(key==='data'?35000000:20000);
    if(!(tool.inputSchema.required||[]).includes(key))validator=validator.optional();
    shape[key]=validator;
  }
  return z.strictObject(shape).parse(args);
}
export function createMcpServer(identity=AI){
  const server=new Server({name:'zhilan-coread',version:'0.2.0'}, {capabilities:{tools:{}},
    instructions:'知岚共读室：用 get_recent_activity 恢复最近阅读上下文。人类私密批注只有主动分享后才能读取；MCP 不能分享或管理书库。按稳定段落坐标引用。读取书页会记录 AI 阅读日志，只有显式 update_progress 才移动共享书签。'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.map(t=>({...t,inputSchema:{...t.inputSchema,additionalProperties:false},
    annotations:{readOnlyHint:['list_books','list_comments','get_toc','get_reading_stats','get_recent_activity'].includes(t.name),destructiveHint:t.name==='delete_comment',openWorldHint:false},
    _meta:{securitySchemes:[{type:'oauth2',scopes:[['list_books','read_book','list_comments','get_toc','get_reading_stats','get_recent_activity'].includes(t.name)?'reading:read':'reading:write']}]}}))}));
  server.setRequestHandler(CallToolRequestSchema,async req=>{
    try{
      const args=validateTool(req.params.name,req.params.arguments||{});
      const read=['list_books','read_book','list_comments','get_toc','get_reading_stats','get_recent_activity'].includes(req.params.name);
      if(!identity.scopes.includes(read?'reading:read':'reading:write'))return {isError:true,content:[{type:'text',text:'Insufficient scope'}]};
      const value=runAs(identity,()=>handleTool(req.params.name,args));
      return {content:[{type:'text',text:JSON.stringify(value)}],...(value?.error || value?.ok===false?{isError:true}:{})};
    }catch(error){return {isError:true,content:[{type:'text',text:error instanceof z.ZodError?'Invalid tool arguments':error.status?error.message:'Tool request failed'}]};}
  });
  return server;
}
export async function handleMcp(req,res,identity){
  const server=createMcpServer(identity);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void server.close().catch(()=>{});});
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
}
