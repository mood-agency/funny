
import { spawn } from 'child_process';
import { resolveClaudeBinary } from './packages/server/src/utils/claude-binary.js';

// Mock getClaudeBinaryPath if needed or just find it
// We'll use a hardcoded path or simple find for the test if the import fails, 
// but since I'm in the repo execution context, I should try to find "claude" in path.

const claudeBin = 'claude'; // Assuming it's in PATH for this test

console.log(`Spawning ${claudeBin}...`);

const proc = spawn(claudeBin, [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    // We need a prompt or something to start
    '--',
    'Hi' // Positional prompt might be ignored if using stream-json input? Docs said: "Don't add the prompt as a positional arg - it will be sent via stdin"
], {
    stdio: ['pipe', 'pipe', 'pipe']
});

proc.stdout.on('data', (data) => {
    console.log(`STDOUT: ${data.toString()}`);
});

proc.stderr.on('data', (data) => {
    console.log(`STDERR: ${data.toString()}`);
});

proc.on('exit', (code) => {
    console.log(`Exited with code ${code}`);
});

// Send first message
const msg1 = {
    type: 'user',
    message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello, are you there?' }]
    }
};

console.log('Writing first message...');
proc.stdin.write(JSON.stringify(msg1) + '\n');

// DO NOT END STDIN
// Wait 5 seconds then send another message
setTimeout(() => {
    console.log('Writing second message...');
    const msg2 = {
        type: 'user',
        message: {
            role: 'user',
            content: [{ type: 'text', text: 'What is 2+2?' }]
        }
    };
    proc.stdin.write(JSON.stringify(msg2) + '\n');
}, 5000);

// End after 10 seconds
setTimeout(() => {
    console.log('Ending stdin...');
    proc.stdin.end();
}, 10000);
