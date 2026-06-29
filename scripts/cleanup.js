// Libera el puerto del health check y mata instancias huerfanas de Chrome/nodemon
// de este bot que hayan quedado vivas de una corrida anterior (causa tipica del
// EADDRINUSE en el puerto y del EBUSY al borrar .wwebjs_auth/session/lockfile).
// Se corre solo en Windows via "predev" (ver package.json), y tambien se puede
// invocar a mano con "npm run clean".
const { execSync } = require("child_process");

function ps(command) {
  try {
    return execSync(`powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

function killPort(port) {
  const pids = ps(
    `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`
  );
  pids
    .split(/\s+/)
    .filter(Boolean)
    .forEach((pid) => {
      console.log(`[cleanup] Liberando puerto ${port} (PID ${pid})`);
      ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    });
}

function killOrphans() {
  // nodemon de este bot (no cualquier node.exe -- evita matar otros proyectos).
  ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'nodemon.*Whatsapp-bot-ai-gemini|Whatsapp-bot-ai-gemini.*nodemon' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  );
  // Chrome lanzado por whatsapp-web.js para este bot (user-data-dir = .wwebjs_auth).
  ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'wwebjs_auth' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  );
}

const port = process.env.PORT || "5000";
killPort(port);
killOrphans();
console.log("[cleanup] Listo.");
