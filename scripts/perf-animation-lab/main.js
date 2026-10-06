const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const strategy = process.argv.find((a) => a.startsWith("--strategy="))?.split("=")[1] ?? "css";
const count = process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "3";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 420,
    height: 260,
    show: true,
    backgroundColor: "#0b0b10",
    webPreferences: { backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "index.html"), {
    search: `strategy=${strategy}&count=${count}`,
  });
  console.log(`spin-lab pid=${process.pid} strategy=${strategy} count=${count}`);
});

app.on("window-all-closed", () => app.quit());
