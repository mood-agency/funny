
import { spawn } from 'bun';

const CLAUDE_BIN = 'claude'; // Or 'claude.cmd' on Windows? Bun should handle it.

console.log('Starting Claude Control Protocol Test V4 (Bun.spawn)...');

const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool=stdio', // The magic flag
    '--',
    'Hello' // Prompt in args to ensure it starts processing
];

const proc = spawn([CLAUDE_BIN, ...args], {
    cwd: process.cwd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
});

async function readStream(stream, name) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        console.log(`[${name}]`, text);
    }
}

readStream(proc.stdout, 'STDOUT');
readStream(proc.stderr, 'STDERR');

proc.exited.then((code) => {
    console.log(`Process exited with code ${code}`);
});

const initRequest = {
    type: 'control_request',
    request_id: 'init-test-4',
    request: {
        subtype: 'initialize',
        hooks: {
            "PreToolUse": [
                {
                    "matcher": ".*",
                    "hookCallbackIds": ["test_callback"]
                }
            ]
        }
    }
};

// Send Initialize immediately
console.log('Sending Initialize Request...');
const input = JSON.stringify(initRequest) + '\n';
proc.stdin.write(input);
proc.stdin.flush();

// Don't close stdin!
setTimeout(() => {
    console.log('Timeout, killing...');
    proc.kill();
}, 15000);
