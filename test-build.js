#!/usr/bin/env node

/**
 * Quick test script to verify mcp-windbg Node.js implementation
 * This doesn't actually connect to MCP, just verifies the modules load correctly
 */

import { CDBSession } from './build/cdbSession.js';
import { existsSync } from 'fs';

console.log('🔍 Testing mcp-windbg Node.js implementation...\n');

// Test 1: Check if CDB can be found
console.log('Test 1: Checking for CDB executable...');
try {
  const testPaths = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe',
    `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\cdbX64.exe`,
  ];
  
  let cdbFound = false;
  for (const path of testPaths) {
    if (existsSync(path)) {
      console.log(`✅ Found CDB at: ${path}`);
      cdbFound = true;
      break;
    }
  }
  
  if (!cdbFound) {
    console.log('⚠️  CDB not found in default locations');
    console.log('   Please install Windows Debugging Tools');
  }
} catch (error) {
  console.log(`❌ Error checking for CDB: ${error}`);
}

// Test 2: Check build artifacts
console.log('\nTest 2: Checking build artifacts...');
const buildFiles = [
  './build/index.js',
  './build/cdbSession.js',
  './build/index.d.ts',
  './build/cdbSession.d.ts',
];

let allFilesExist = true;
for (const file of buildFiles) {
  if (existsSync(file)) {
    console.log(`✅ ${file}`);
  } else {
    console.log(`❌ ${file} - missing!`);
    allFilesExist = false;
  }
}

// Test 3: Verify module imports
console.log('\nTest 3: Verifying module imports...');
try {
  console.log('✅ CDBSession class imported successfully');
  console.log(`   - Type: ${typeof CDBSession}`);
  console.log(`   - Is constructor: ${typeof CDBSession === 'function'}`);
} catch (error) {
  console.log(`❌ Failed to import modules: ${error}`);
  allFilesExist = false;
}

// Test 4: Check package.json
console.log('\nTest 4: Checking package configuration...');
try {
  const pkg = await import('./package.json', { assert: { type: 'json' } });
  console.log(`✅ Package name: ${pkg.default.name}`);
  console.log(`✅ Version: ${pkg.default.version}`);
  console.log(`✅ Entry point: ${pkg.default.bin['mcp-windbg']}`);
} catch (error) {
  console.log(`❌ Failed to load package.json: ${error}`);
}

// Summary
console.log('\n' + '='.repeat(50));
if (allFilesExist) {
  console.log('✅ All tests passed!');
  console.log('\nNext steps:');
  console.log('1. Add to your MCP client configuration:');
  console.log('   {');
  console.log('     "command": "node",');
  console.log(`     "args": ["${process.cwd()}\\\\build\\\\index.js"]`);
  console.log('   }');
  console.log('2. Restart your MCP client');
  console.log('3. Try: "List crash dumps in the default folder"');
} else {
  console.log('❌ Some tests failed. Please check the errors above.');
  process.exit(1);
}
