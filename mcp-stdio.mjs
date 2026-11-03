#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDb } from './lib/db.mjs';
import { createMcpServer } from './lib/mcp-server.mjs';
initDb(process.env.COREAD_DB||path.join(process.cwd(),'data/coread.db'));
await createMcpServer().connect(new StdioServerTransport());
