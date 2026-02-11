#!/usr/bin/env node

/**
 * Stitch MCP Protocol Shim V5 🛡️
 * Extreme diagnostic mode.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');

const LOG_FILE = '/tmp/stitch-shim-v5.log';
// Use the bin path we found earlier
const BIN_PATH = '/home/angel/.npm/_npx/829c6278c197c365/node_modules/.bin/stitch-mcp';
const API_KEY = process.env.STITCH_API_KEY || 'AQ.Ab8RN6KEoRIsQCIrfypHOmUNTElI9EXwF36VyE4Jz1ylNflh0Q';

function log(msg) {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

fs.writeFileSync(LOG_FILE, 'Shim V5 Started\n');

log(`Using API_KEY: ${API_KEY.substring(0, 5)}...`);
log(`Using BIN_PATH: ${BIN_PATH}`);

const child = spawn('/usr/bin/node', [BIN_PATH, 'proxy', '--transport', 'stdio'], {
    env: { ...process.env, STITCH_API_KEY: API_KEY },
    stdio: ['pipe', 'pipe', 'pipe']
});

const rlParent = readline.createInterface({ input: process.stdin });
const rlChild = readline.createInterface({ input: child.stdout });

rlParent.on('line', (line) => {
    log(`Editor -> Shim: ${line}`);
    try {
        const req = JSON.parse(line);
        if (req.method === 'resources/list' || req.method === 'prompts/list') {
            log(`Shim -> Editor: Intercepted ${req.method}`);
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: { [req.method.split('/')[0]]: [] }
            }) + '\n');
            return;
        }
        child.stdin.write(line + '\n');
    } catch (e) {
        log(`Parse Error Editor: ${e.message}`);
        child.stdin.write(line + '\n');
    }
});

rlChild.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        log(`Shim -> Editor: ${trimmed}`);
        process.stdout.write(trimmed + '\n');
    } else {
        log(`Shim -> Dropping garbage: ${trimmed}`);
    }
});

child.stderr.on('data', (data) => {
    log(`Proxy Stderr: ${data.toString()}`);
});

child.on('exit', (code) => {
    log(`Proxy exited with code ${code}`);
    process.exit(code);
});
