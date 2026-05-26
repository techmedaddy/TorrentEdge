const https = require('https');
https.get('https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso', (res) => {
  console.log('Status code:', res.statusCode);
  if (res.statusCode >= 300 && res.statusCode < 400) {
    console.log('Location header present:', Boolean(res.headers.location));
  }
});
