const { execSync } = require('child_process');
try {
  const logs = execSync('docker compose logs --tail 200 backend').toString();
  console.log(logs);
} catch (e) {
  console.log(e.message);
}
