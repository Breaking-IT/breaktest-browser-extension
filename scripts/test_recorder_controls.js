#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const [browser, panel] of [['chrome', 'sidepanel'], ['firefox', 'sidebar']]) {
  const source = fs.readFileSync(path.join(__dirname, '..', browser, `${panel}.js`), 'utf8');
  const counter = source.slice(source.indexOf('function nextTransactionPrefix'), source.indexOf('function openNextTransaction'));
  const context = vm.createContext({});
  vm.runInContext(counter, context);
  for (const [name, expected] of [
    ['01_Openhomepage', '02_'], ['UC1_01_Homepage', 'UC1_02_'],
    ['UC1_09_Homepage', 'UC1_10_'], ['099_Homepage', '100_'],
    ['UC1_99_Homepage', 'UC1_100_'], ['Homepage', '01_'],
    ['UC1_01_', 'UC1_02_'], ['  UC1_001_Homepage  ', 'UC1_002_'],
    ['UC1_01_Homepage2026', 'UC1_02_']
  ]) assert.equal(context.nextTransactionPrefix(name), expected);
  console.log(`${browser}: transaction counter suggestions passed`);
}
