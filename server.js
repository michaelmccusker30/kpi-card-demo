// One HTTPS server for all three demo stages. No dependencies.
//   node server.js        → https://localhost:3001/stage1/index.html  (…stage2, stage3)
// Needs mkcert certs in this folder: mkcert localhost
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3001;
const ROOT = __dirname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".trex": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const options = {
  key: fs.readFileSync(path.join(__dirname, "localhost-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "localhost.pem")),
};

https
  .createServer(options, function (req, res) {
    const rel = decodeURIComponent(new URL(req.url, "https://localhost").pathname);
    const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, function (err, data) {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, function () {
    console.log("KPI Card demo serving on https://localhost:" + PORT);
    console.log("  stage 1  https://localhost:" + PORT + "/stage1/index.html");
    console.log("  stage 2  https://localhost:" + PORT + "/stage2/index.html");
    console.log("  stage 2.1 (fixed)  https://localhost:" + PORT + "/stage2-fixed/index.html");
    console.log("  stage 3  https://localhost:" + PORT + "/stage3/index.html");
  });
