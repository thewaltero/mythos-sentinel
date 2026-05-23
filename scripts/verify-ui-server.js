import { get } from 'node:http';
import { createUiServer } from '../src/ui/server.js';

const server = await createUiServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const status = await new Promise((resolve, reject) => {
  const req = get(`http://127.0.0.1:${port}/api/status`, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ statusCode: res.statusCode, body }));
  });
  req.on('error', reject);
});
server.close();
if (status.statusCode !== 200 || !JSON.parse(status.body).version) {
  console.error('Dashboard status check failed');
  process.exit(1);
}
console.log('Dashboard server check: ok');
