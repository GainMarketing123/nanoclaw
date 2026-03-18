#!/usr/bin/env tsx
/**
 * Safely update registered group configuration in NanoClaw's SQLite database.
 * Handles JSON serialization properly — no shell escaping risks.
 *
 * Usage:
 *   # Add a mount to a group
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --add-mount /home/atlas/projects:projects:ro
 *
 *   # Set full container config from a JSON file
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --config-file config.json
 *
 *   # Update group name
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --name "New Name"
 *
 *   # Update trigger pattern
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --trigger "@Atlas"
 *
 *   # Set requires-trigger
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --requires-trigger false
 *
 *   # List all groups
 *   tsx scripts/update-group-config.ts --list
 *
 *   # Show one group's full config
 *   tsx scripts/update-group-config.ts --jid "tg:7322433447" --show
 *
 * Run from the NanoClaw project root (where store/messages.db lives).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve('store', 'messages.db');

function openDb(): Database.Database {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    console.error('Run this script from the NanoClaw project root.');
    process.exit(1);
  }
  return new Database(DB_PATH);
}

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number;
  is_main: number;
}

function listGroups(db: Database.Database): void {
  const rows = db.prepare('SELECT * FROM registered_groups ORDER BY added_at').all() as GroupRow[];
  if (rows.length === 0) {
    console.log('No registered groups.');
    return;
  }

  console.log(`\n${'JID'.padEnd(25)} ${'Name'.padEnd(20)} ${'Folder'.padEnd(25)} ${'Trigger'.padEnd(10)} Main`);
  console.log('-'.repeat(90));
  for (const row of rows) {
    const main = row.is_main ? '★' : '';
    console.log(`${row.jid.padEnd(25)} ${row.name.padEnd(20)} ${row.folder.padEnd(25)} ${row.trigger_pattern.padEnd(10)} ${main}`);
  }
  console.log('');
}

function showGroup(db: Database.Database, jid: string): void {
  const row = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get(jid) as GroupRow | undefined;
  if (!row) {
    console.error(`Group not found: ${jid}`);
    process.exit(1);
  }

  console.log('\nGroup Details:');
  console.log(`  JID:              ${row.jid}`);
  console.log(`  Name:             ${row.name}`);
  console.log(`  Folder:           ${row.folder}`);
  console.log(`  Trigger:          ${row.trigger_pattern}`);
  console.log(`  Requires Trigger: ${row.requires_trigger === 1}`);
  console.log(`  Is Main:          ${row.is_main === 1}`);
  console.log(`  Added:            ${row.added_at}`);

  if (row.container_config) {
    try {
      const config = JSON.parse(row.container_config);
      console.log(`  Container Config: ${JSON.stringify(config, null, 4)}`);
    } catch {
      console.log(`  Container Config: ${row.container_config} (INVALID JSON!)`);
    }
  } else {
    console.log('  Container Config: (none)');
  }
  console.log('');
}

function addMount(db: Database.Database, jid: string, mountSpec: string): void {
  // Parse mount spec: hostPath:containerPath:ro|rw
  const parts = mountSpec.split(':');
  if (parts.length < 2) {
    console.error('Mount format: /host/path:container-name[:ro|rw]');
    console.error('Example: /home/atlas/projects:projects:ro');
    process.exit(1);
  }

  const hostPath = parts[0];
  const containerPath = parts[1];
  const readonly = parts[2] !== 'rw'; // default to readonly

  const row = db.prepare('SELECT container_config FROM registered_groups WHERE jid = ?').get(jid) as { container_config: string | null } | undefined;
  if (!row) {
    console.error(`Group not found: ${jid}`);
    process.exit(1);
  }

  let config: { additionalMounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }> } = {};
  if (row.container_config) {
    try {
      config = JSON.parse(row.container_config);
    } catch {
      console.error(`Existing config is invalid JSON: ${row.container_config}`);
      console.error('Use --config-file to replace it entirely.');
      process.exit(1);
    }
  }

  if (!config.additionalMounts) {
    config.additionalMounts = [];
  }

  // Check for duplicate
  const existing = config.additionalMounts.find(m => m.containerPath === containerPath);
  if (existing) {
    console.log(`Updating existing mount for "${containerPath}"`);
    existing.hostPath = hostPath;
    existing.readonly = readonly;
  } else {
    config.additionalMounts.push({ hostPath, containerPath, readonly });
    console.log(`Adding mount: ${hostPath} → ${containerPath} (${readonly ? 'ro' : 'rw'})`);
  }

  const configJson = JSON.stringify(config);
  db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(configJson, jid);

  // Verify round-trip
  const verify = db.prepare('SELECT container_config FROM registered_groups WHERE jid = ?').get(jid) as { container_config: string };
  JSON.parse(verify.container_config); // throws if corrupted
  console.log(`Saved: ${configJson}`);
}

function setConfigFromFile(db: Database.Database, jid: string, filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(content); // Validate JSON
  const configJson = JSON.stringify(config);

  db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(configJson, jid);
  console.log(`Config set from ${filePath}: ${configJson}`);
}

function updateField(db: Database.Database, jid: string, field: string, value: string | number): void {
  const allowedFields: Record<string, string> = {
    name: 'name',
    trigger: 'trigger_pattern',
    requires_trigger: 'requires_trigger',
  };

  const column = allowedFields[field];
  if (!column) {
    console.error(`Unknown field: ${field}. Allowed: ${Object.keys(allowedFields).join(', ')}`);
    process.exit(1);
  }

  db.prepare(`UPDATE registered_groups SET ${column} = ? WHERE jid = ?`).run(value, jid);
  console.log(`Updated ${field} = ${value} for ${jid}`);
}

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes('--list')) {
  const db = openDb();
  listGroups(db);
  db.close();
  process.exit(0);
}

const jidIdx = args.indexOf('--jid');
const jid = jidIdx >= 0 ? args[jidIdx + 1] : undefined;

if (!jid) {
  console.error('Usage: tsx scripts/update-group-config.ts --jid <jid> [options]');
  console.error('       tsx scripts/update-group-config.ts --list');
  console.error('');
  console.error('Options:');
  console.error('  --show                          Show group details');
  console.error('  --add-mount host:name[:ro|rw]   Add/update a mount');
  console.error('  --config-file path.json         Set full config from file');
  console.error('  --name "New Name"               Update group name');
  console.error('  --trigger "@Atlas"              Update trigger pattern');
  console.error('  --requires-trigger true|false   Set trigger requirement');
  process.exit(1);
}

const db = openDb();

if (args.includes('--show')) {
  showGroup(db, jid);
} else if (args.includes('--add-mount')) {
  const mountIdx = args.indexOf('--add-mount');
  addMount(db, jid, args[mountIdx + 1]);
} else if (args.includes('--config-file')) {
  const fileIdx = args.indexOf('--config-file');
  setConfigFromFile(db, jid, args[fileIdx + 1]);
} else if (args.includes('--name')) {
  const nameIdx = args.indexOf('--name');
  updateField(db, jid, 'name', args[nameIdx + 1]);
} else if (args.includes('--trigger')) {
  const trigIdx = args.indexOf('--trigger');
  updateField(db, jid, 'trigger', args[trigIdx + 1]);
} else if (args.includes('--requires-trigger')) {
  const rtIdx = args.indexOf('--requires-trigger');
  updateField(db, jid, 'requires_trigger', args[rtIdx + 1] === 'true' ? 1 : 0);
} else {
  showGroup(db, jid);
}

db.close();
