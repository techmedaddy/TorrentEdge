const http = require('http');
const jwt = require('jsonwebtoken');
const token = jwt.sign({ userId: 'test-user-id', role: 'admin' }, 'torrentedge-dev-secret-change-in-production', { expiresIn: '1h' });

const req = http.request({
  hostname: 'localhost',
  port: 3029,
  path: '/api/torrent/create',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(res.statusCode, data));
});
req.write(JSON.stringify({
  magnetURI: 'magnet:?xt=urn:btih:91245fa084278725d4841da9b74e885b758aa832&dn=ubuntu',
  sourceUri: 'https://releases.ubuntu.com/24.04/ubuntu.iso',
  autoStart: true
}));
req.end();
