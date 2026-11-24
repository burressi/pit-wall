// load the browser scripts into a Node context
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(files) {
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, performance: globalThis.performance };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../source/app/js', f), 'utf8'), ctx, { filename: f });
  return ctx;
};
