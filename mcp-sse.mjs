#!/usr/bin/env node
// Compatibility command: one authenticated upstream serves both web and MCP.
import { startServer } from './server.mjs';
startServer().then(({server})=>console.error('共读室：网页 /，MCP /mcp，端口 '+server.address().port)).catch(error=>{console.error(error.message);process.exitCode=1;});
